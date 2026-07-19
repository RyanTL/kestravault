import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { resolveCodexExecutable } from "./codexBinary.js";

type JsonRecord = Record<string, unknown>;

interface PendingRequest {
  resolve: (value: JsonRecord) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface ActiveTurn {
  turnId: string | null;
  onDelta: (text: string) => void;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface CodexAppServerRequest {
  prompt: string;
  system?: string;
  model?: string;
  effort?: "low" | "medium" | "high";
  signal: AbortSignal;
  onDelta: (text: string) => void;
}

const TEXT_ONLY_INSTRUCTIONS =
  "You are a text-only assistant embedded in KestraVault. Answer the user's prompt directly. " +
  "Do not inspect files, run commands, call tools, or describe agent work.";

/** Persistent JSONL client for the Codex app-server rich-client protocol. */
export class CodexAppServer {
  private child: ChildProcessWithoutNullStreams | null = null;
  private cwd: string | null = null;
  private startPromise: Promise<void> | null = null;
  private unsupported = false;
  private nextId = 1;
  private disabledMcpServers: JsonRecord = {};
  private disabledPlugins: JsonRecord = {};
  private pending = new Map<number, PendingRequest>();
  private active = new Map<string, ActiveTurn>();

  constructor(private readonly turnTimeoutMs = 90_000) {}

  async prewarm(): Promise<void> {
    await this.ensureStarted();
  }

  async run(req: CodexAppServerRequest): Promise<void> {
    if (req.signal.aborted) throw new Error("aborted");
    await this.ensureStarted();
    if (req.signal.aborted) throw new Error("aborted");

    const started = await this.request("thread/start", {
      model: req.model ?? null,
      cwd: this.cwd,
      approvalPolicy: "never",
      sandbox: "read-only",
      baseInstructions: TEXT_ONLY_INSTRUCTIONS,
      developerInstructions: req.system || null,
      personality: "none",
      ephemeral: true,
      config: {
        web_search: "disabled",
        include_apps_instructions: false,
        include_collaboration_mode_instructions: false,
        include_environment_context: false,
        tool_suggest: false,
        mcp_servers: this.disabledMcpServers,
        plugins: this.disabledPlugins,
        features: {
          apps: false,
          mentions_v2: false,
          multi_agent: false,
          remote_plugin: false,
          shell_tool: false,
          tool_suggest: false,
          unified_exec: false,
        },
      },
    });
    const thread = started["thread"] as JsonRecord | undefined;
    const threadId = typeof thread?.["id"] === "string" ? thread["id"] : null;
    if (!threadId) throw new Error("Codex app-server did not return a thread id");

    let abortListener: (() => void) | null = null;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          const active = this.active.get(threadId);
          if (!active) return;
          active.reject(new Error("Codex response timed out"));
          if (active.turnId) {
            void this.request("turn/interrupt", { threadId, turnId: active.turnId }).catch(
              () => {},
            );
          }
        }, this.turnTimeoutMs);
        const active: ActiveTurn = {
          turnId: null,
          onDelta: req.onDelta,
          resolve,
          reject,
          timer,
        };
        this.active.set(threadId, active);
        abortListener = () => {
          // Settle locally right away, including while turn/start is still in
          // flight. If the server returns a turn id later, interrupt it too.
          active.reject(new Error("aborted"));
          if (active.turnId) {
            void this.request("turn/interrupt", { threadId, turnId: active.turnId }).catch(
              () => {},
            );
          }
        };
        req.signal.addEventListener("abort", abortListener, { once: true });
        void this.request("turn/start", {
          threadId,
          input: [{ type: "text", text: req.prompt }],
          ...(req.model ? { model: req.model } : {}),
          ...(req.effort ? { effort: req.effort } : {}),
        })
          .then((response) => {
            const turn = response["turn"] as JsonRecord | undefined;
            if (typeof turn?.["id"] === "string") active.turnId = turn["id"];
            if (req.signal.aborted && active.turnId) abortListener?.();
          })
          .catch(reject);
      });
    } finally {
      if (abortListener) req.signal.removeEventListener("abort", abortListener);
      const active = this.active.get(threadId);
      if (active) clearTimeout(active.timer);
      this.active.delete(threadId);
      void this.request("thread/unsubscribe", { threadId }).catch(() => {});
    }
  }

  async stop(): Promise<void> {
    this.startPromise = null;
    const child = this.child;
    this.child = null;
    if (child && !child.killed) child.kill("SIGTERM");
    this.failAll(new Error("Codex app-server stopped"));
    if (this.cwd) {
      const cwd = this.cwd;
      this.cwd = null;
      await fs.rm(cwd, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.unsupported) throw new Error("codex_app_server_unavailable");
    if (this.child && !this.child.killed) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.start().catch((error) => {
      this.unsupported = true;
      throw error;
    });
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async start(): Promise<void> {
    const exe = resolveCodexExecutable();
    if (!exe) throw new Error("codex_not_installed");
    this.cwd ??= await fs.mkdtemp(join(tmpdir(), "kestravault-codex-server-"));
    const child = spawn(exe, ["app-server", "--stdio"], {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    // Always drain stderr; a chatty CLI warning stream can otherwise fill the
    // pipe buffer and stall the long-lived process.
    child.stderr.on("data", () => {});
    child.on("error", (error) => this.handleExit(error));
    child.on("close", (code) => this.handleExit(new Error(`Codex app-server exited (${code})`)));

    await this.request("initialize", {
      clientInfo: { name: "kestravault", title: "KestraVault", version: "0.3.0" },
    });
    this.notify("initialized", {});
    // Preserve the user's ChatGPT authentication while disabling every MCP
    // configured in their Codex profile for these text-only turns. Otherwise a
    // slow or expired MCP can add seconds before the model request even starts.
    const configResult = await this.request("config/read", { includeLayers: false });
    const config = configResult["config"] as JsonRecord | undefined;
    const servers = config?.["mcp_servers"] as JsonRecord | undefined;
    this.disabledMcpServers = Object.fromEntries(
      Object.keys(servers ?? {}).map((name) => [name, { enabled: false }]),
    );
    const plugins = config?.["plugins"] as JsonRecord | undefined;
    this.disabledPlugins = Object.fromEntries(
      Object.keys(plugins ?? {}).map((name) => [name, { enabled: false }]),
    );
  }

  private request(method: string, params: JsonRecord, timeoutMs = 15_000): Promise<JsonRecord> {
    const id = this.nextId++;
    return new Promise<JsonRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server timed out during ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private notify(method: string, params: JsonRecord): void {
    this.write({ method, params });
  }

  private write(message: JsonRecord): void {
    if (!this.child || this.child.killed || !this.child.stdin.writable) {
      throw new Error("Codex app-server is not running");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: JsonRecord;
    try {
      message = JSON.parse(line) as JsonRecord;
    } catch {
      return;
    }
    if (typeof message["id"] === "number") {
      const id = message["id"];
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      const error = message["error"] as JsonRecord | undefined;
      if (error) pending.reject(new Error(String(error["message"] ?? "Codex app-server error")));
      else pending.resolve((message["result"] as JsonRecord | undefined) ?? {});
      return;
    }

    const method = message["method"];
    const params = (message["params"] as JsonRecord | undefined) ?? {};
    const threadId = typeof params["threadId"] === "string" ? params["threadId"] : null;
    const active = threadId ? this.active.get(threadId) : undefined;
    if (!active || typeof method !== "string") return;
    if (method === "item/agentMessage/delta" && typeof params["delta"] === "string") {
      clearTimeout(active.timer);
      active.timer = setTimeout(() => {
        active.reject(new Error("Codex response timed out"));
        if (active.turnId) {
          void this.request("turn/interrupt", { threadId, turnId: active.turnId }).catch(() => {});
        }
      }, this.turnTimeoutMs);
      active.onDelta(params["delta"]);
      return;
    }
    if (method === "turn/completed") {
      clearTimeout(active.timer);
      const turn = params["turn"] as JsonRecord | undefined;
      const status = turn?.["status"];
      if (status === "failed") {
        const error = turn?.["error"] as JsonRecord | undefined;
        active.reject(new Error(String(error?.["message"] ?? "Codex turn failed")));
      } else {
        active.resolve();
      }
      return;
    }
    if (method === "error" && params["willRetry"] !== true) {
      const error = params["error"] as JsonRecord | undefined;
      active.reject(new Error(String(error?.["message"] ?? "Codex stream failed")));
    }
  }

  private handleExit(error: Error): void {
    this.child = null;
    this.failAll(error);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const active of this.active.values()) {
      clearTimeout(active.timer);
      active.reject(error);
    }
    this.active.clear();
  }
}

export const codexAppServer = new CodexAppServer();
