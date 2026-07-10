import type { BrowserWindow } from "electron";
import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { vaultRoot } from "./vault.js";
import { getSecret, keyFingerprint } from "./secrets.js";
import { resolveClaudeExecutable } from "./claudeBinary.js";

// ── KestraVault AI bridge ────────────────────────────────────────────────────────
// KestraVault is open source and "bring your own model": the AI features run on
// whatever provider the user configures in Settings. We support three wire
// "kinds", which between them cover the popular options:
//
//   • subscription — the Claude Agent SDK, reusing the user's Claude.ai
//     (Pro/Max) login over OAuth, exactly like Claude Code. No API key.
//   • anthropic    — the Anthropic Messages API with the user's own key.
//   • openai       — any OpenAI-compatible /chat/completions endpoint. One code
//     path serves OpenAI, OpenRouter, Together, a local Ollama or LM Studio,
//     and anything else that speaks the same protocol (the renderer points
//     baseUrl at it; the key is resolved from encrypted storage by provider id).
//
// API keys live in the main process only (see secrets.ts) — encrypted at rest
// with the OS keychain and never sent over IPC or stored in the renderer.
//
// Every call is a single, stateless text generation (no tools). The renderer
// owns conversation state and passes the running transcript in.

export type ChatRole = "user" | "assistant";
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

// The wire config the renderer attaches to each request. Absent → subscription,
// which keeps older callers (and the default install) working unchanged.
//
// Note there is no `apiKey` here on purpose: keys never cross the IPC boundary.
// The renderer passes only the provider *id*, and the main process resolves the
// key from encrypted storage (secrets.ts) at the moment of the request.
export type AiProviderKind = "subscription" | "anthropic" | "openai";
export interface AiProviderConfig {
  kind: AiProviderKind;
  /** Which provider preset — used to look up the stored key in secrets.ts. */
  providerId?: string;
  /** Base URL for `anthropic` / `openai` kinds (no trailing slash needed). */
  baseUrl?: string;
}

// How hard the model should think before answering. A Claude-only concept:
// the Agent SDK (subscription) silently downgrades it for models that don't
// support effort, but the raw Anthropic API rejects it on Haiku — hence the
// per-provider handling below. OpenAI-compatible providers ignore it entirely.
export type AiEffort = "low" | "medium" | "high";

/** Resolve the API key for a provider from encrypted storage (main-process). */
function keyFor(p: AiProviderConfig): string | undefined {
  return getSecret(p.providerId);
}

export interface AiSendRequest {
  requestId: string;
  /** Persona / task instructions (the system prompt). */
  system: string;
  /** Full conversation so far; the last entry is the new user turn. */
  messages: ChatMessage[];
  /** Provider-specific model id (alias for subscription, full id otherwise). */
  model?: string;
  /** Where to send the request. Defaults to the Claude subscription. */
  provider?: AiProviderConfig;
  /** Reasoning effort (Claude providers only); omitted → provider default. */
  effort?: AiEffort;
}

export type AiEvent =
  | { requestId: string; type: "delta"; text: string }
  | { requestId: string; type: "done"; text: string }
  | { requestId: string; type: "error"; kind: AiErrorKind; message: string };

export type AiErrorKind = "auth" | "rate_limit" | "aborted" | "unknown";

export interface AiStatus {
  connected: boolean;
  /** Friendly explanation when not connected. */
  detail?: string;
  kind?: AiErrorKind;
}

const DEFAULT_MODEL = "sonnet";

function providerOf(req: { provider?: AiProviderConfig }): AiProviderConfig {
  return req.provider ?? { kind: "subscription" };
}

// ── Subscription (Claude Agent SDK) ──────────────────────────────────────────

// Shared options for every subscription call: no tools, no filesystem
// settings — a clean assistant that only ever generates text.
//
// The tool controls here are subtle and were the source of an "error_max_turns"
// bug. `allowedTools` does NOT restrict which tools exist — per the SDK it only
// lists tools that skip the permission prompt ("auto-allowed"). What actually
// makes this a pure text generator is `tools: []`, which disables every
// built-in tool. Without it — and with `permissionMode: "bypassPermissions"`
// plus `cwd` pointed at the vault — the model silently picks up every built-in
// not in the tiny `disallowedTools` list (Grep, Glob, LS, Task, TodoWrite, …),
// explores the vault turn after turn, and exhausts `maxTurns` before it ever
// answers, surfacing to the user as "Reached maximum number of turns".
function baseOptions(model: string | undefined, signal: AbortController): Options {
  // Packaged builds must point the SDK at the extracted engine binary — its own
  // resolution lands inside app.asar, which spawn can't execute (claudeBinary.ts).
  const claudeExe = resolveClaudeExecutable();
  return {
    ...(claudeExe ? { pathToClaudeCodeExecutable: claudeExe } : {}),
    model: model || DEFAULT_MODEL,
    tools: [], // disable ALL built-in tools — this is what makes replies text-only
    disallowedTools: ["Bash", "Edit", "Write", "Read", "WebFetch", "WebSearch"], // belt-and-suspenders if `tools` is ever widened
    maxTurns: 2, // a text answer is one round-trip; minimal slack, then fail fast
    permissionMode: "bypassPermissions",
    settingSources: [], // ignore global/project CLAUDE.md + MCP — a clean assistant
    includePartialMessages: true,
    cwd: vaultRoot(),
    abortController: signal,
    // Force subscription auth: strip any API key from the child env so the SDK
    // can't silently fall back to a stray key (deleting beats setting
    // `undefined`, which some Node versions stringify to "undefined").
    env: cleanEnv(),
  };
}

// Environment variables that redirect *where* or *how* Claude Code
// authenticates and which endpoint it talks to. The subscription path must
// always reach the real Claude endpoint using the user's Claude.ai OAuth login,
// so any of these leaking in from the launching shell — a developer running the
// app from a Claude Code / proxy / Bedrock session, a corporate gateway, or our
// own staging env — would silently hijack it and typically surface as the
// confusing "Not logged in · Please run /login".
export const SUBSCRIPTION_ENV_OVERRIDES = [
  "ANTHROPIC_API_KEY", // would bill the pay-as-you-go API instead of the subscription
  "ANTHROPIC_AUTH_TOKEN", // a bearer-token override
  "ANTHROPIC_BASE_URL", // points Claude at a proxy / gateway / staging host
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_USE_BEDROCK", // routes auth through AWS Bedrock
  "CLAUDE_CODE_USE_VERTEX", // routes auth through GCP Vertex
  "USE_STAGING_OAUTH", // internal: point the OAuth flow at staging
  "USE_LOCAL_OAUTH", // internal: point the OAuth flow at localhost
] as const;

// A copy of `env` (defaulting to process.env) with those overrides removed, so
// the subscription path always authenticates the user's Claude.ai login against
// the real Claude endpoint — never a leftover key or a redirected endpoint.
// (Deleting beats setting `undefined`, which some Node versions stringify to
// the literal "undefined".)
export function cleanEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const rest = { ...env };
  for (const key of SUBSCRIPTION_ENV_OVERRIDES) delete rest[key];
  return rest;
}

// Compose the running conversation into one prompt. Single-shot keeps state in
// the renderer (no SDK session juggling) and is plenty for a chat demo.
function composePrompt(messages: ChatMessage[]): string {
  if (messages.length === 1 && messages[0]?.role === "user") {
    return messages[0].content;
  }
  const transcript = messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");
  return `Continue this conversation. Reply only as the assistant's next turn.\n\n${transcript}\n\nAssistant:`;
}

// Runners stream every chunk through `onDelta` (which the caller uses to both
// forward to the renderer and accumulate the final text) and return nothing —
// so a mid-stream abort still keeps whatever arrived.
async function runSubscription(
  req: AiSendRequest,
  controller: AbortController,
  onDelta: (t: string) => void,
): Promise<void> {
  let any = false;
  let stderr = "";
  const options = baseOptions(req.model, controller);
  options.stderr = (d) => {
    stderr += d;
  };
  // Safe for every alias: the SDK silently downgrades effort for models that
  // don't support it (e.g. the `haiku` alias), so this never errors.
  if (req.effort) options.effort = req.effort;
  if (req.system) options.systemPrompt = req.system;

  for await (const msg of query({
    prompt: composePrompt(req.messages),
    options,
  }) as AsyncIterable<SDKMessage>) {
    if (msg.type === "stream_event") {
      const ev = msg.event;
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
        any = true;
        onDelta(ev.delta.text);
      }
    } else if (msg.type === "assistant" && msg.error) {
      throw new Error(`assistant_error:${msg.error}`);
    } else if (msg.type === "result") {
      if (msg.subtype !== "success") {
        if (!any) {
          const detail = ("result" in msg && msg.result) || stderr || msg.subtype;
          throw new Error(String(detail));
        }
      } else if (!any && msg.result) {
        // Some turns deliver only the final result, no partial deltas.
        onDelta(msg.result);
      }
    }
  }
}

// ── HTTP providers (Anthropic API + OpenAI-compatible) ───────────────────────

// Read a fetch SSE body line by line. `extract` turns one parsed `data:` JSON
// object into a text chunk (or throws to surface a provider error); a `[DONE]`
// sentinel ends the stream. Shared by both HTTP kinds — only `extract` differs.
async function pumpSse(
  body: ReadableStream<Uint8Array>,
  extract: (json: unknown) => string | undefined,
  onDelta: (t: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue; // skip `event:` + keepalive lines
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") {
        if (data === "[DONE]") return;
        continue;
      }
      let json: unknown;
      try {
        json = JSON.parse(data);
      } catch {
        continue; // non-JSON keepalive
      }
      const chunk = extract(json);
      if (chunk) onDelta(chunk);
    }
  }
}

const trimSlash = (s: string): string => s.replace(/\/+$/, "");

// Surface a non-2xx response as a readable Error (status + a snippet of body).
async function httpError(res: Response): Promise<Error> {
  let body = "";
  try {
    body = await res.text();
  } catch {
    /* ignore */
  }
  // Provider error bodies are usually `{ "error": { "message": ... } }`.
  let detail = body.slice(0, 400);
  try {
    const j = JSON.parse(body) as { error?: { message?: string } | string };
    const m = typeof j.error === "string" ? j.error : j.error?.message;
    if (m) detail = m;
  } catch {
    /* keep raw snippet */
  }
  return new Error(`HTTP ${res.status} — ${detail}`);
}

async function runOpenAi(
  req: AiSendRequest,
  provider: AiProviderConfig,
  controller: AbortController,
  onDelta: (t: string) => void,
): Promise<void> {
  const base = trimSlash(provider.baseUrl || "https://api.openai.com/v1");
  const key = keyFor(provider);
  const messages = [
    ...(req.system ? [{ role: "system", content: req.system }] : []),
    ...req.messages.map((m) => ({ role: m.role, content: m.content })),
  ];
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    signal: controller.signal,
    headers: {
      "Content-Type": "application/json",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({ model: req.model, messages, stream: true }),
  });
  if (!res.ok || !res.body) throw await httpError(res);
  await pumpSse(
    res.body,
    (json) => {
      const j = json as {
        error?: { message?: string };
        choices?: { delta?: { content?: string } }[];
      };
      if (j.error) throw new Error(j.error.message || "provider error");
      return j.choices?.[0]?.delta?.content;
    },
    onDelta,
  );
}

async function runAnthropic(
  req: AiSendRequest,
  provider: AiProviderConfig,
  controller: AbortController,
  onDelta: (t: string) => void,
): Promise<void> {
  const base = trimSlash(provider.baseUrl || "https://api.anthropic.com");
  const res = await fetch(`${base}/v1/messages`, {
    method: "POST",
    signal: controller.signal,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": keyFor(provider) ?? "",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: req.model,
      max_tokens: 4096,
      stream: true,
      // `effort` is GA on Opus/Sonnet but rejected (400) on Haiku 4.5, so only
      // attach it for models that accept it.
      ...(req.effort && !/haiku/i.test(req.model ?? "")
        ? { output_config: { effort: req.effort } }
        : {}),
      ...(req.system ? { system: req.system } : {}),
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    }),
  });
  if (!res.ok || !res.body) throw await httpError(res);
  await pumpSse(
    res.body,
    (json) => {
      const j = json as {
        type?: string;
        error?: { message?: string };
        delta?: { type?: string; text?: string };
      };
      if (j.type === "error") throw new Error(j.error?.message || "provider error");
      if (j.type === "content_block_delta" && j.delta?.type === "text_delta") {
        return j.delta.text;
      }
      return undefined;
    },
    onDelta,
  );
}

// ── Error classification + friendly copy ─────────────────────────────────────

export function classifyError(message: string): AiErrorKind {
  const m = message.toLowerCase();
  if (
    /\b(401|403)\b|not logged in|unauthor|authentication|invalid.*api key|incorrect api key|no api key|missing.*key|please run \/login|oauth/.test(
      m,
    )
  ) {
    return "auth";
  }
  if (/\b429\b|rate.?limit|usage limit|quota|too many requests|overloaded/.test(m)) {
    return "rate_limit";
  }
  if (/abort/.test(m)) return "aborted";
  return "unknown";
}

export function friendly(kind: AiErrorKind, raw: string, provider: AiProviderConfig): string {
  if (kind === "auth") {
    if (provider.kind === "subscription") {
      return "Not connected to your Claude account. Open a terminal, run `claude`, then `/login` and choose “Claude account with subscription”.";
    }
    return "The provider rejected the request — check your API key and base URL in Settings → AI model.";
  }
  if (kind === "rate_limit") {
    return "The provider’s usage limit was hit. Wait a bit, switch to a cheaper model, then try again.";
  }
  if (provider.kind === "openai" && /fetch failed|econnrefused|enotfound|network/i.test(raw)) {
    return "Couldn’t reach the endpoint. If this is a local model (Ollama / LM Studio), make sure it’s running, then re-check.";
  }
  return raw.split("\n").slice(0, 4).join("\n");
}

// ── Public API ───────────────────────────────────────────────────────────────

// In-flight requests, so the renderer can cancel a stream by id.
const inflight = new Map<string, AbortController>();

export async function runAiRequest(win: BrowserWindow, req: AiSendRequest): Promise<void> {
  const controller = new AbortController();
  inflight.set(req.requestId, controller);
  const provider = providerOf(req);
  const send = (e: AiEvent): void => {
    if (!win.isDestroyed()) win.webContents.send("ai:event", e);
  };
  // Forward every chunk to the renderer and accumulate it, so a mid-stream
  // abort still surfaces whatever arrived so far.
  let full = "";
  const onDelta = (text: string): void => {
    full += text;
    send({ requestId: req.requestId, type: "delta", text });
  };

  try {
    if (provider.kind === "anthropic") {
      await runAnthropic(req, provider, controller, onDelta);
    } else if (provider.kind === "openai") {
      await runOpenAi(req, provider, controller, onDelta);
    } else {
      await runSubscription(req, controller, onDelta);
    }
    send({ requestId: req.requestId, type: "done", text: full });
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const kind = controller.signal.aborted ? "aborted" : classifyError(raw);
    if (kind === "aborted") {
      // A user-initiated cancel still keeps whatever streamed so far.
      send({ requestId: req.requestId, type: "done", text: full });
    } else {
      send({ requestId: req.requestId, type: "error", kind, message: friendly(kind, raw, provider) });
    }
  } finally {
    inflight.delete(req.requestId);
  }
}

export function cancelAiRequest(requestId: string): void {
  inflight.get(requestId)?.abort();
}

// ── Connection probe ─────────────────────────────────────────────────────────

// Cheap-ish probe, cached per provider signature so flipping the chat panel
// open doesn't re-spend. A misconfigured/unauthenticated provider fails fast.
const statusCache = new Map<string, AiStatus>();
// Fingerprint the *value* of the key (not just its presence) so that fixing a
// bad key busts the cache — otherwise a corrected key kept returning the stale
// "auth failed" result.
const sigOf = (p: AiProviderConfig): string =>
  `${p.kind}|${p.providerId ?? ""}|${p.baseUrl ?? ""}|${keyFingerprint(p.providerId)}`;

async function probeSubscription(controller: AbortController): Promise<void> {
  const options = baseOptions(DEFAULT_MODEL, controller);
  options.systemPrompt = "Reply with the single word: ok";
  let sawText = false;
  for await (const msg of query({ prompt: "ping", options }) as AsyncIterable<SDKMessage>) {
    if (msg.type === "stream_event" && msg.event.type === "content_block_delta") sawText = true;
    if (msg.type === "assistant" && msg.error) throw new Error(`assistant_error:${msg.error}`);
    if (msg.type === "result" && msg.subtype !== "success" && !sawText) {
      const detail = ("result" in msg && msg.result) || msg.subtype;
      throw new Error(String(detail));
    }
  }
}

// Validate an HTTP provider with a 1-token, non-streamed generation. Cheap, and
// it actually exercises auth + the model id (not just network reachability).
async function probeHttp(provider: AiProviderConfig, controller: AbortController): Promise<void> {
  const key = keyFor(provider);
  if (provider.kind === "anthropic") {
    const base = trimSlash(provider.baseUrl || "https://api.anthropic.com");
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key ?? "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    if (!res.ok) throw await httpError(res);
    return;
  }
  // openai-compatible: a GET /models is the lightest auth check and works for
  // OpenAI, OpenRouter, Ollama and LM Studio alike.
  const base = trimSlash(provider.baseUrl || "https://api.openai.com/v1");
  const res = await fetch(`${base}/models`, {
    method: "GET",
    signal: controller.signal,
    headers: key ? { Authorization: `Bearer ${key}` } : {},
  });
  if (!res.ok) throw await httpError(res);
}

export async function aiStatus(provider?: AiProviderConfig, force = false): Promise<AiStatus> {
  const p = provider ?? { kind: "subscription" };
  const sig = sigOf(p);
  const cached = statusCache.get(sig);
  if (cached && !force) return cached;

  // A provider that needs a key but has none is plainly "not connected" — no
  // point spending a network round-trip to learn that.
  if (
    (p.kind === "anthropic" ||
      (p.kind === "openai" && /openai\.com|openrouter/i.test(p.baseUrl ?? ""))) &&
    !keyFor(p)
  ) {
    const s: AiStatus = {
      connected: false,
      kind: "auth",
      detail: "Add your API key in Settings → AI model.",
    };
    statusCache.set(sig, s);
    return s;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let status: AiStatus;
  try {
    if (p.kind === "subscription") await probeSubscription(controller);
    else await probeHttp(p, controller);
    status = { connected: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const kind = classifyError(message);
    status = { connected: false, kind, detail: friendly(kind, message, p) };
  } finally {
    clearTimeout(timer);
  }
  statusCache.set(sig, status);
  return status;
}

export function resetAiStatus(): void {
  statusCache.clear();
}
