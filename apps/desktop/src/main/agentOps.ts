import type { BrowserWindow } from "electron";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, relative, isAbsolute, sep } from "node:path";
import {
  createSdkMcpServer,
  query,
  tool,
  type Options,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { parseFrontmatter, resolveEffectivePrivacy, type PrivacyRule } from "@kestravault/core";
import {
  readTree,
  readFile,
  writeFile,
  renameEntry,
  readPrivacyRules,
  type VaultNode,
} from "./vault.js";
import {
  cleanEnv,
  classifyError,
  friendly,
  type AiErrorKind,
  type AiProviderConfig,
} from "./ai.js";
import { getSecret } from "./secrets.js";
import { resolveClaudeExecutable } from "./claudeBinary.js";

// ── Vault agent operations (skills) ──────────────────────────────────────────
// Unlike the chat path (single turn, no tools — ai.ts), an agent op is a real
// multi-turn Claude Agent SDK run with file tools enabled, so the AI can work
// on the vault directly: file a note, tidy the structure, reorganize folders,
// or run a user-written custom skill. There is no imposed layout — the agent
// follows the vault's own AI guide (.kestravault/instructions.md) and keeps
// the guide's Vault map (the index) current so future runs navigate without
// scanning every file.
//
// Safety model, enforced here:
//   read   — anywhere inside the vault, nothing outside it
//   write  — any note in the vault, plus .kestravault/instructions.md (the
//            guide's index sections); never other dotfiles or app config
//   move   — via a dedicated move_note tool (rename only, nothing is deleted)
//   never  — private/local-only notes (excluded from the workspace entirely)
// Enforced via canUseTool with permissionMode "default": every tool call is
// routed through checkToolUse below; Bash/network tools are disallowed outright.
// The run happens in a temp copy of the vault; changes are committed back only
// when it finishes (or is cancelled by the user).
//
// Providers: needs the Claude Agent SDK runtime, so it runs on the Claude
// subscription (OAuth) or an Anthropic API key. Other providers keep the chat
// features but can't run agent ops (the renderer gates this).

export type AgentOpKind = "file" | "tidy" | "organize" | "custom";

export interface AgentOpRequest {
  requestId: string;
  op: AgentOpKind;
  /** Vault-relative path of the note the op targets (required for `file`). */
  targetPath?: string;
  /** The instruction for a `custom` op (a user-defined skill's prompt). */
  prompt?: string;
  model?: string;
  provider?: AiProviderConfig;
}

export interface ChangedFile {
  path: string;
  op: "create" | "update" | "move";
  /** Previous path when `op` is "move". */
  from?: string;
}

export type AgentOpEvent =
  | { requestId: string; type: "delta"; text: string }
  | { requestId: string; type: "tool"; action: "read" | "search" | "write" | "move"; path?: string }
  | { requestId: string; type: "done"; text: string; changed: ChangedFile[] }
  | { requestId: string; type: "error"; kind: AiErrorKind; message: string };

// ── Tool guard ───────────────────────────────────────────────────────────────

const READ_TOOLS = new Set(["Read", "Glob", "Grep"]);
const WRITE_TOOLS = new Set(["Write", "Edit"]);
const MOVE_TOOL = "mcp__vault__move_note";

/** The one dotfile the agent may edit: the AI guide (it owns the vault map). */
const GUIDE_PATH = ".kestravault/instructions.md";

/** Vault-relative POSIX path if `p` is inside `root`, else null. */
function relIn(root: string, p: string): string | null {
  const abs = isAbsolute(p) ? resolve(p) : resolve(root, p);
  const rel = relative(root, abs);
  if (!rel || rel === "") return ""; // the root itself (e.g. Glob over the vault)
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

/** Whether a vault-relative path is one the agent may write or move. The
 *  structure is the user's own, so everything is fair game except app
 *  metadata: dotfiles/dotfolders stay read-only, with the single exception of
 *  the AI guide, whose index sections the agent maintains. */
export function isWritablePath(rel: string): boolean {
  if (!rel) return false;
  if (rel === GUIDE_PATH) return true;
  return !rel.split("/").some((seg) => seg.startsWith("."));
}

export type ToolCheck =
  | { ok: true; action: "read" | "search" | "write"; path?: string }
  | { ok: true; action: "move"; from: string; to: string }
  | { ok: false; reason: string };

/** Validate one tool call against the vault's rules. Pure — unit-tested. */
export function checkToolUse(
  root: string,
  toolName: string,
  input: Record<string, unknown>,
): ToolCheck {
  const pathArg = (key: string): string | undefined =>
    typeof input[key] === "string" ? (input[key] as string) : undefined;

  if (READ_TOOLS.has(toolName)) {
    const p = pathArg("file_path") ?? pathArg("path");
    if (p !== undefined && relIn(root, p) === null) {
      return { ok: false, reason: `Reads must stay inside the vault (got ${p}).` };
    }
    const rel = p === undefined ? undefined : (relIn(root, p) ?? undefined);
    return { ok: true, action: toolName === "Read" ? "read" : "search", path: rel || undefined };
  }

  if (WRITE_TOOLS.has(toolName)) {
    const p = pathArg("file_path");
    if (!p) return { ok: false, reason: "Missing file_path." };
    const rel = relIn(root, p);
    if (rel === null || rel === "") {
      return { ok: false, reason: `Writes must stay inside the vault (got ${p}).` };
    }
    if (!isWritablePath(rel)) {
      return {
        ok: false,
        reason:
          `"${rel}" is not writable. Notes anywhere in the vault are, and so is the AI guide ` +
          `(${GUIDE_PATH}) — but other app metadata and dotfiles are read-only.`,
      };
    }
    return { ok: true, action: "write", path: rel };
  }

  if (toolName === MOVE_TOOL) {
    const from = pathArg("from");
    const to = pathArg("to");
    if (!from || !to) return { ok: false, reason: "move_note needs both `from` and `to`." };
    const relFrom = relIn(root, from);
    const relTo = relIn(root, to);
    if (relFrom === null || relFrom === "" || relTo === null || relTo === "") {
      return { ok: false, reason: "Moves must stay inside the vault." };
    }
    if (!isWritablePath(relFrom) || !isWritablePath(relTo)) {
      return { ok: false, reason: "Dotfiles and app metadata cannot be moved." };
    }
    return { ok: true, action: "move", from: relFrom, to: relTo };
  }

  return { ok: false, reason: `The ${toolName} tool is not available in vault operations.` };
}

interface AgentWorkspace {
  root: string;
  blocked: Array<{ path: string; kind: "file" | "folder"; mode: string }>;
  cleanup: () => Promise<void>;
  commit: (changed: ChangedFile[]) => Promise<void>;
}

function matchesBlocked(
  rel: string | undefined,
  blocked: AgentWorkspace["blocked"],
): { path: string; kind: "file" | "folder"; mode: string } | null {
  if (!rel) return null;
  for (const b of blocked) {
    if (b.kind === "file" && rel === b.path) return b;
    if (b.kind === "folder" && (rel === b.path || rel.startsWith(`${b.path}/`))) return b;
  }
  return null;
}

function treeFiles(nodes: VaultNode[]): VaultNode[] {
  const out: VaultNode[] = [];
  const walk = (ns: VaultNode[]): void => {
    for (const n of ns) {
      if (n.kind === "file") out.push(n);
      else walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

function blockedPaths(nodes: VaultNode[]): AgentWorkspace["blocked"] {
  const out: AgentWorkspace["blocked"] = [];
  const walk = (ns: VaultNode[]): void => {
    for (const n of ns) {
      if (n.privacy.mode !== "public") {
        out.push({
          path: n.path,
          kind: n.kind === "dir" ? "folder" : "file",
          mode: n.privacy.mode,
        });
      }
      if (n.kind === "dir") walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

async function readFrontmatterPrivate(relPath: string): Promise<boolean> {
  try {
    return parseFrontmatter(await readFile(relPath)).data["private"] === true;
  } catch {
    return false;
  }
}

async function buildAgentWorkspace(): Promise<AgentWorkspace> {
  const tempRoot = await fs.mkdtemp(join(tmpdir(), "kestravault-agent-"));
  const tree = await readTree();
  const blocked = blockedPaths(tree);
  const publicFiles = treeFiles(tree).filter((n) => n.privacy.mode === "public");

  const writeTemp = async (rel: string, content: string): Promise<void> => {
    const abs = resolve(tempRoot, rel.split("/").join(sep));
    await fs.mkdir(dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
  };

  for (const file of publicFiles) {
    await writeTemp(file.path, await readFile(file.path));
  }
  try {
    await writeTemp(GUIDE_PATH, await readFile(GUIDE_PATH));
  } catch {
    // A not-yet-onboarded vault can still run with the base prompt.
  }

  return {
    root: tempRoot,
    blocked,
    cleanup: () => fs.rm(tempRoot, { recursive: true, force: true }),
    commit: async (changed) => {
      // Moves first (renames in the real vault), then content writes — so an
      // edit made after a move lands on the file's new path.
      for (const change of changed) {
        if (change.op !== "move" || !change.from) continue;
        if (matchesBlocked(change.from, blocked) || matchesBlocked(change.path, blocked)) continue;
        try {
          await renameEntry(change.from, change.path);
        } catch {
          // Source vanished or destination taken since the run started — the
          // content writes below still land whatever the agent produced.
        }
      }
      for (const change of changed) {
        if (change.op === "move") continue;
        if (matchesBlocked(change.path, blocked)) continue;
        const abs = resolve(tempRoot, change.path.split("/").join(sep));
        const rel = relative(tempRoot, abs);
        if (rel.startsWith("..") || isAbsolute(rel)) continue;
        try {
          await writeFile(change.path, await fs.readFile(abs, "utf8"));
        } catch {
          // The temp file may not exist if the agent moved it after writing;
          // the move above already carried the content.
        }
      }
    },
  };
}

async function targetIsPrivate(targetPath: string, privacyRules: PrivacyRule[]): Promise<boolean> {
  const frontmatterPrivate = await readFrontmatterPrivate(targetPath);
  return resolveEffectivePrivacy(targetPath, "file", privacyRules, frontmatterPrivate).mode !== "public";
}

// ── Prompts ──────────────────────────────────────────────────────────────────

const OP_PERSONA = [
  "You are KestraVault AI operating directly on the user's personal notes vault.",
  `FIRST read ${GUIDE_PATH} — it is the vault's AI guide: its purpose, the working rules,`,
  "and the Vault map (the index of the structure). Follow it exactly and use the map to",
  "navigate instead of scanning every file. If the guide is missing, infer the structure",
  "from the folders you see and be conservative.",
  "You may create and edit notes anywhere in the vault, and move/rename them with the",
  "move_note tool. Nothing is ever deleted — move superseded material to an archive",
  "folder instead. Dotfiles and app metadata are read-only, with one exception: keep the",
  `guide (${GUIDE_PATH}) current — after any change that adds, moves, or reorganizes notes,`,
  "update its Vault map section (and, when the user corrected you, its Learned preferences",
  "section). Do not rewrite the guide's Purpose or How-to-work sections unless the task",
  "explicitly asks for it.",
  "Cross-reference notes with [[wikilinks]] using note titles.",
  "Narrate briefly as you work (one short line per step), and end with a concise markdown",
  "summary: what changed and any suggested follow-ups.",
].join(" ");

function opPrompt(req: AgentOpRequest): string {
  if (req.op === "file") {
    return [
      `File the note at "${req.targetPath}" into the vault, following the guide: put it (or its`,
      "substance) where it belongs in the structure, connect it to related notes with wikilinks,",
      "update any notes it affects, and refresh the guide's Vault map. If the note is already in",
      "the right place, just link and index it.",
    ].join(" ");
  }
  if (req.op === "tidy") {
    return [
      "Tidy the vault: check for broken or missing wikilinks, notes that plainly sit in the wrong",
      "folder, duplicates or contradictions between notes, and a Vault map that has drifted from",
      "reality. Fix the mechanical problems directly (links, the map, obvious misfiles), report",
      "the judgment calls to the user, and leave everything else alone. If the vault is empty,",
      "say so and suggest what to add first.",
    ].join(" ");
  }
  if (req.op === "organize") {
    return [
      "Reorganize the vault so everything is easy to find: analyze the existing notes, decide the",
      "best folder structure for this user's content (respect the guide's Purpose and any structure",
      "the user clearly chose), move notes into place with move_note, add wikilinks between related",
      "notes, and rewrite the guide's Vault map section so it precisely indexes the new structure —",
      "every folder with a one-line description, plus the key notes. Never delete anything; move",
      "superseded material to an archive folder. Keep the guide short.",
    ].join(" ");
  }
  // custom — a user-authored skill. It runs under the same persona and rules.
  const target = req.targetPath ? ` The currently open note is "${req.targetPath}".` : "";
  return `${(req.prompt ?? "").trim()}${target}`;
}

// ── Runner ───────────────────────────────────────────────────────────────────

const inflight = new Map<string, AbortController>();

function envFor(
  provider: AiProviderConfig | undefined,
): { env: NodeJS.ProcessEnv } | { error: string } {
  const p = provider ?? { kind: "subscription" as const };
  if (p.kind === "subscription") return { env: cleanEnv() };
  if (p.kind === "anthropic") {
    const key = getSecret(p.providerId);
    if (!key) return { error: "Add your Anthropic API key in Settings → AI model first." };
    const env = cleanEnv();
    env["ANTHROPIC_API_KEY"] = key;
    if (p.baseUrl) env["ANTHROPIC_BASE_URL"] = p.baseUrl;
    return { env };
  }
  return {
    error:
      "Vault skills need Claude (subscription or Anthropic API) — the current provider only supports chat.",
  };
}

export async function runAgentOp(win: BrowserWindow, req: AgentOpRequest): Promise<void> {
  const send = (e: AgentOpEvent): void => {
    if (!win.isDestroyed()) win.webContents.send("ai:agent-event", e);
  };
  const provider = req.provider ?? { kind: "subscription" as const };
  const envResult = envFor(req.provider);
  if ("error" in envResult) {
    send({ requestId: req.requestId, type: "error", kind: "auth", message: envResult.error });
    return;
  }
  if (req.op === "file" && !req.targetPath) {
    send({
      requestId: req.requestId,
      type: "error",
      kind: "unknown",
      message: "Open the note you want to file first.",
    });
    return;
  }
  if (req.op === "custom" && !req.prompt?.trim()) {
    send({
      requestId: req.requestId,
      type: "error",
      kind: "unknown",
      message: "This custom skill has no instruction — edit it in Settings first.",
    });
    return;
  }
  const privacyRules = await readPrivacyRules();
  if (req.targetPath && (await targetIsPrivate(req.targetPath, privacyRules))) {
    send({
      requestId: req.requestId,
      type: "error",
      kind: "unknown",
      message:
        "This note is private, so a remote vault agent cannot read or work on it. " +
        "Switch to a local model for private content, or make the note visible to cloud AI.",
    });
    return;
  }

  const controller = new AbortController();
  inflight.set(req.requestId, controller);
  let workspace: AgentWorkspace;
  try {
    workspace = await buildAgentWorkspace();
  } catch (err) {
    inflight.delete(req.requestId);
    const raw = err instanceof Error ? err.message : String(err);
    const kind = classifyError(raw);
    send({
      requestId: req.requestId,
      type: "error",
      kind,
      message: friendly(kind, raw, provider),
    });
    return;
  }
  const root = workspace.root;
  const changed: ChangedFile[] = [];
  let full = "";
  let stderr = "";

  // Remap already-recorded changes when a file (or a folder of files) moves,
  // so the commit step writes content to the path the file ended up at.
  const applyMoveToChanged = (from: string, to: string): void => {
    for (const c of changed) {
      if (c.op === "move") continue;
      if (c.path === from) c.path = to;
      else if (c.path.startsWith(`${from}/`)) c.path = to + c.path.slice(from.length);
    }
  };

  // The move tool: renames inside the temp workspace, recorded for commit.
  // Moves only — the agent has no way to delete anything.
  const vaultTools = createSdkMcpServer({
    name: "vault",
    version: "1.0.0",
    tools: [
      tool(
        "move_note",
        "Move or rename a note (or folder) inside the vault. Use vault-relative paths. " +
          "Parent folders of the destination are created as needed. Never overwrites: " +
          "fails if the destination already exists.",
        {
          from: z.string().describe("Current vault-relative path"),
          to: z.string().describe("New vault-relative path"),
        },
        async (args) => {
          const check = checkToolUse(root, MOVE_TOOL, args);
          if (!check.ok) return { content: [{ type: "text", text: check.reason }], isError: true };
          if (check.action !== "move") {
            return { content: [{ type: "text", text: "Unexpected tool input." }], isError: true };
          }
          const absFrom = resolve(root, check.from.split("/").join(sep));
          const absTo = resolve(root, check.to.split("/").join(sep));
          if (!existsSync(absFrom)) {
            return {
              content: [{ type: "text", text: `"${check.from}" does not exist.` }],
              isError: true,
            };
          }
          if (existsSync(absTo)) {
            return {
              content: [
                { type: "text", text: `"${check.to}" already exists — pick another name.` },
              ],
              isError: true,
            };
          }
          await fs.mkdir(dirname(absTo), { recursive: true });
          await fs.rename(absFrom, absTo);
          applyMoveToChanged(check.from, check.to);
          changed.push({ path: check.to, op: "move", from: check.from });
          return { content: [{ type: "text", text: `Moved ${check.from} → ${check.to}` }] };
        },
      ),
    ],
  });

  // Same asar workaround as ai.ts baseOptions — see claudeBinary.ts.
  const claudeExe = resolveClaudeExecutable();
  const options: Options = {
    ...(claudeExe ? { pathToClaudeCodeExecutable: claudeExe } : {}),
    model: req.model || "sonnet",
    cwd: root,
    mcpServers: { vault: vaultTools },
    allowedTools: ["Read", "Glob", "Grep", "Write", "Edit", MOVE_TOOL],
    disallowedTools: ["Bash", "WebFetch", "WebSearch", "Task", "NotebookEdit", "TodoWrite"],
    permissionMode: "default", // every tool call routes through canUseTool below
    maxTurns: 80,
    includePartialMessages: true,
    settingSources: [], // any CLAUDE.md in the vault is a note; ours is the systemPrompt
    systemPrompt: OP_PERSONA,
    abortController: controller,
    env: envResult.env,
    stderr: (d) => {
      stderr += d;
    },
    canUseTool: async (toolName, input) => {
      const check = checkToolUse(root, toolName, input);
      if (!check.ok) return { behavior: "deny", message: check.reason };
      if (check.action === "move") {
        const blocked =
          matchesBlocked(check.from, workspace.blocked) ??
          matchesBlocked(check.to, workspace.blocked);
        if (blocked) {
          return {
            behavior: "deny",
            message: `"${blocked.path}" is ${blocked.mode}; remote agent operations cannot touch it.`,
          };
        }
        send({
          requestId: req.requestId,
          type: "tool",
          action: "move",
          path: `${check.from} → ${check.to}`,
        });
        return { behavior: "allow", updatedInput: input };
      }
      const blocked = matchesBlocked(check.path, workspace.blocked);
      if (blocked) {
        return {
          behavior: "deny",
          message:
            `"${blocked.path}" is ${blocked.mode}; remote agent operations cannot read or write it.`,
        };
      }
      if (check.action === "write" && check.path) {
        const op = existsSync(resolve(root, check.path)) ? "update" : "create";
        if (!changed.some((c) => c.op !== "move" && c.path === check.path)) {
          changed.push({ path: check.path, op });
        }
      }
      send({ requestId: req.requestId, type: "tool", action: check.action, path: check.path });
      return { behavior: "allow", updatedInput: input };
    },
  };

  try {
    let sawText = false;
    for await (const msg of query({ prompt: opPrompt(req), options }) as AsyncIterable<SDKMessage>) {
      if (msg.type === "stream_event") {
        const ev = msg.event;
        if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
          sawText = true;
          full += ev.delta.text;
          send({ requestId: req.requestId, type: "delta", text: ev.delta.text });
        }
      } else if (msg.type === "assistant" && msg.error) {
        throw new Error(`assistant_error:${msg.error}`);
      } else if (msg.type === "result" && msg.subtype !== "success" && !sawText) {
        const detail = ("result" in msg && msg.result) || stderr || msg.subtype;
        throw new Error(String(detail));
      }
    }
    await workspace.commit(changed);
    send({ requestId: req.requestId, type: "done", text: full, changed });
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    if (controller.signal.aborted) {
      // A user cancel keeps whatever happened so far.
      await workspace.commit(changed).catch(() => undefined);
      send({ requestId: req.requestId, type: "done", text: full, changed });
    } else {
      const kind = classifyError(raw);
      send({
        requestId: req.requestId,
        type: "error",
        kind,
        message: friendly(kind, raw, provider),
      });
    }
  } finally {
    await workspace.cleanup().catch(() => undefined);
    inflight.delete(req.requestId);
  }
}

export function cancelAgentOp(requestId: string): void {
  inflight.get(requestId)?.abort();
}
