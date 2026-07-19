import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const appServerRun = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));
vi.mock("./vault.js", () => ({ vaultRoot: () => "/tmp/vault" }));
vi.mock("./secrets.js", () => ({ getSecret: () => undefined, keyFingerprint: () => "" }));
vi.mock("./codexAppServer.js", () => ({
  codexAppServer: { run: appServerRun, prewarm: vi.fn(), stop: vi.fn() },
}));
vi.mock("./codexBinary.js", () => ({
  resolveCodexExecutable: () => "/mock/codex",
  codexLoggedIn: () => true,
  resetCodexCache: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { runAiRequest, type AiEvent, type AiSendRequest } from "./ai.js";

function fallbackProcess() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new PassThrough(), {
    stdin,
    stdout,
    stderr,
    killed: false,
    kill: vi.fn(),
  });
  stdin.on("finish", () => {
    stdout.write(
      `${JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "fallback answer" },
      })}\n`,
    );
    queueMicrotask(() => child.emit("close", 0));
  });
  return child;
}

function request(): AiSendRequest {
  return {
    requestId: "request-1",
    system: "Be concise.",
    messages: [{ role: "user", content: "Hello" }],
    model: "gpt-test",
    provider: { kind: "openai-sub" },
  };
}

beforeEach(() => {
  appServerRun.mockReset();
  spawnMock.mockReset();
});

describe("ChatGPT subscription compatibility", () => {
  it("falls back to codex exec when app-server fails before output", async () => {
    appServerRun.mockRejectedValue(new Error("unsupported"));
    spawnMock.mockReturnValue(fallbackProcess());
    const events: AiEvent[] = [];
    const win = {
      isDestroyed: () => false,
      webContents: { send: (_channel: string, event: AiEvent) => events.push(event) },
    };

    await runAiRequest(win as never, request());

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({
      requestId: "request-1",
      type: "done",
      text: "fallback answer",
    });
  });

  it("keeps partial output without starting a duplicate fallback", async () => {
    appServerRun.mockImplementation(async ({ onDelta }) => {
      onDelta("partial");
      throw new Error("server exited");
    });
    const events: AiEvent[] = [];
    const win = {
      isDestroyed: () => false,
      webContents: { send: (_channel: string, event: AiEvent) => events.push(event) },
    };

    await runAiRequest(win as never, request());

    expect(spawnMock).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({
      type: "done",
      text: expect.stringContaining("partial"),
    });
  });
});
