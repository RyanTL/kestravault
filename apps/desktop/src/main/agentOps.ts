import type { BrowserWindow } from "electron";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, relative, isAbsolute, sep } from "node:path";
import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { parseFrontmatter, resolveEffectivePrivacy, type PrivacyRule } from "@kestravault/core";
import {
  vaultRoot,
  readTree,
  readFile,
  writeFile,
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

// ── Vault agent operations (Ingest / Lint) ───────────────────────────────────
// Unlike the chat path (single turn, no tools — ai.ts), an agent op is a real
// multi-turn Claude Agent SDK run with file tools enabled, so the AI can
// actually maintain the wiki: read the source, write/update wiki pages, refresh
// index.md, append to log.md.
//
// Safety model (the three zones from plan/data-model.md, enforced here):
//   read   — anywhere inside the vault, nothing outside it
//   write  — ONLY wiki/**, index.md, log.md
//   never  — sources/ (immutable), notes/ (human-owned), .kestravault/ (the agent
//            may not rewrite its own instructions), AGENTS.md / CLAUDE.md
// Enforced via canUseTool with permissionMode "default": every tool call is
// routed through checkToolUse below; Bash/network tools are disallowed outright.
//
// Providers: needs the Claude Agent SDK runtime, so it runs on the Claude
// subscription (OAuth) or an Anthropic API key. OpenAI-compatible providers
// keep the chat features but can't run agent ops (the renderer gates this).

export type AgentOpKind = "ingest" | "lint";

export interface AgentOpRequest {
  requestId: string;
  op: AgentOpKind;
  /** Vault-relative path of the note to ingest (required for `ingest`). */
  targetPath?: string;
  model?: string;
  provider?: AiProviderConfig;
}

export interface ChangedFile {
  path: string;
  op: "create" | "update";
}

export type AgentOpEvent =
  | { requestId: string; type: "delta"; text: string }
  | { requestId: string; type: "tool"; action: "read" | "search" | "write"; path?: string }
  | { requestId: string; type: "done"; text: string; changed: ChangedFile[] }
  | { requestId: string; type: "error"; kind: AiErrorKind; message: string };

// ── Tool guard ───────────────────────────────────────────────────────────────

const READ_TOOLS = new Set(["Read", "Glob", "Grep"]);
const WRITE_TOOLS = new Set(["Write", "Edit"]);

/** Vault-relative POSIX path if `p` is inside `root`, else null. */
function relIn(root: string, p: string): string | null {
  const abs = isAbsolute(p) ? resolve(p) : resolve(root, p);
  const rel = relative(root, abs);
  if (!rel || rel === "") return ""; // the root itself (e.g. Glob over the vault)
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

/** Whether a vault-relative path is one the agent may write. */
export function isWritablePath(rel: string): boolean {
  if (rel === "index.md" || rel === "log.md") return true;
  return rel.startsWith("wiki/") && rel !== "wiki/";
}

export type ToolCheck =
  | { ok: true; action: "read" | "search" | "write"; path?: string }
  | { ok: false; reason: string };

/** Validate one tool call against the vault's zone rules. Pure — unit-tested. */
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
          `"${rel}" is not writable. You may only write wiki/**, index.md and log.md — ` +
          "sources/ is immutable, notes/ is human-owned, and .kestravault/ holds your instructions.",
      };
    }
    return { ok: true, action: "write", path: rel };
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
  const realRoot = vaultRoot();
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
    await writeTemp(".kestravault/instructions.md", await readFile(".kestravault/instructions.md"));
  } catch {
    // A not-yet-onboarded vault can still run with the base prompt.
  }

  return {
    root: tempRoot,
    blocked,
    cleanup: () => fs.rm(tempRoot, { recursive: true, force: true }),
    commit: async (changed) => {
      for (const change of changed) {
        if (matchesBlocked(change.path, blocked)) continue;
        const abs = resolve(tempRoot, change.path.split("/").join(sep));
        const rel = relative(tempRoot, abs);
        if (rel.startsWith("..") || isAbsolute(rel)) continue;
        await writeFile(change.path, await fs.readFile(abs, "utf8"));
      }
      // Preserve the old assumption that writes land in the real vault by the
      // time the caller receives the done event.
      void realRoot;
    },
  };
}

async function targetIsPrivate(targetPath: string, privacyRules: PrivacyRule[]): Promise<boolean> {
  const frontmatterPrivate = await readFrontmatterPrivate(targetPath);
  return resolveEffectivePrivacy(targetPath, "file", privacyRules, frontmatterPrivate).mode !== "public";
}

// ── Prompts ──────────────────────────────────────────────────────────────────

const OP_PERSONA = [
  "You are KestraVault AI operating directly on the user's knowledge vault (an 'LLM wiki').",
  "FIRST read .kestravault/instructions.md — it is your schema; follow its conventions, style and",
  "workflows exactly. Then read index.md to see what the wiki already contains.",
  "You may only write files under wiki/, plus index.md and log.md. sources/ is immutable,",
  "notes/ is the human's, and .kestravault/ is read-only — never try to modify them.",
  "Use [[wikilinks]] with human-readable titles for every cross-reference.",
  "Narrate briefly as you work (one short line per step), and end with a concise markdown",
  "summary: what changed, anything contradicted or superseded, and any suggested follow-ups",
  "or improvements to the instructions file.",
].join(" ");

function opPrompt(req: AgentOpRequest): string {
  if (req.op === "ingest") {
    return [
      `Ingest the source at "${req.targetPath}" into the wiki, following the Ingest workflow in`,
      "the instructions: write/refresh its summary page under wiki/, update every wiki page it",
      "touches (facts, cross-references, contradictions), update index.md, and append an ingest",
      "entry to log.md. Do not modify the source file itself.",
    ].join(" ");
  }
  return [
    "Run the Lint workflow from the instructions: health-check the wiki for contradictions,",
    "stale claims, orphan pages, missing pages and missing cross-references. Fix the mechanical",
    "problems directly (index drift, missing links), report the judgment calls, and append a",
    "lint entry to log.md. If the wiki is empty, say so and suggest what to ingest first.",
  ].join(" ");
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
  if (req.op === "ingest" && !req.targetPath) {
    send({
      requestId: req.requestId,
      type: "error",
      kind: "unknown",
      message: "Open the note you want to ingest first.",
    });
    return;
  }
  const privacyRules = await readPrivacyRules();
  if (req.op === "ingest" && req.targetPath && (await targetIsPrivate(req.targetPath, privacyRules))) {
    send({
      requestId: req.requestId,
      type: "error",
      kind: "unknown",
      message:
        "This note is private, so a remote vault agent cannot read or ingest it. " +
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

  // Same asar workaround as ai.ts baseOptions — see claudeBinary.ts.
  const claudeExe = resolveClaudeExecutable();
  const options: Options = {
    ...(claudeExe ? { pathToClaudeCodeExecutable: claudeExe } : {}),
    model: req.model || "sonnet",
    cwd: root,
    allowedTools: ["Read", "Glob", "Grep", "Write", "Edit"],
    disallowedTools: ["Bash", "WebFetch", "WebSearch", "Task", "NotebookEdit", "TodoWrite"],
    permissionMode: "default", // every tool call routes through canUseTool below
    maxTurns: 60,
    includePartialMessages: true,
    settingSources: [], // the vault's CLAUDE.md is for external tools; ours is the systemPrompt
    systemPrompt: OP_PERSONA,
    abortController: controller,
    env: envResult.env,
    stderr: (d) => {
      stderr += d;
    },
    canUseTool: async (toolName, input) => {
      const check = checkToolUse(root, toolName, input);
      if (!check.ok) return { behavior: "deny", message: check.reason };
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
        if (!changed.some((c) => c.path === check.path)) changed.push({ path: check.path, op });
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
      // A user cancel keeps whatever happened so far (writes are already on disk).
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
