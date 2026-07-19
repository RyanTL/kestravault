import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("./codexBinary.js", () => ({ resolveCodexExecutable: () => "/mock/codex" }));

import { CodexAppServer } from "./codexAppServer.js";

interface FakeOptions {
  complete?: boolean;
  delayTurnStart?: boolean;
}

function fakeProcess(options: FakeOptions = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const requests: Array<Record<string, unknown>> = [];
  let input = "";
  const send = (message: unknown): void => {
    stdout.write(`${JSON.stringify(message)}\n`);
  };
  stdin.on("data", (chunk) => {
    input += chunk.toString();
    let newline: number;
    while ((newline = input.indexOf("\n")) >= 0) {
      const message = JSON.parse(input.slice(0, newline)) as Record<string, unknown>;
      input = input.slice(newline + 1);
      requests.push(message);
      const id = message["id"];
      if (message["method"] === "initialize") send({ id, result: {} });
      if (message["method"] === "config/read") {
        send({
          id,
          result: {
            config: {
              mcp_servers: { slowServer: { enabled: true } },
              plugins: { "tool-plugin@example": { enabled: true } },
            },
          },
        });
      }
      if (message["method"] === "thread/start") {
        send({ id, result: { thread: { id: `thread-${id}` } } });
      }
      if (message["method"] === "turn/start") {
        const params = message["params"] as Record<string, unknown>;
        const threadId = params["threadId"];
        const start = (): void => {
          send({ id, result: { turn: { id: `turn-${id}` } } });
          send({
            method: "item/agentMessage/delta",
            params: { threadId, turnId: `turn-${id}`, itemId: "item-1", delta: "Hello" },
          });
          if (options.complete !== false) {
            send({
              method: "turn/completed",
              params: { threadId, turn: { id: `turn-${id}`, status: "completed" } },
            });
          }
        };
        if (options.delayTurnStart) setTimeout(start, 25);
        else queueMicrotask(start);
      }
      if (message["method"] === "turn/interrupt") {
        const params = message["params"] as Record<string, unknown>;
        send({ id, result: {} });
        send({
          method: "turn/completed",
          params: {
            threadId: params["threadId"],
            turn: { id: params["turnId"], status: "interrupted" },
          },
        });
      }
      if (message["method"] === "thread/unsubscribe") send({ id, result: {} });
    }
  });
  const child = Object.assign(new PassThrough(), {
    stdin,
    stdout,
    stderr,
    killed: false,
    kill: vi.fn(function (this: { killed: boolean }) {
      this.killed = true;
      return true;
    }),
  });
  return { child, requests };
}

beforeEach(() => {
  spawnMock.mockReset();
});

describe("CodexAppServer", () => {
  it("reuses one process and forwards incremental agent-message deltas", async () => {
    const fake = fakeProcess();
    spawnMock.mockReturnValue(fake.child);
    const server = new CodexAppServer();
    const deltas: string[] = [];

    for (let i = 0; i < 2; i++) {
      await server.run({
        prompt: `question ${i}`,
        model: "gpt-test",
        signal: new AbortController().signal,
        onDelta: (delta) => deltas.push(delta),
      });
    }

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(deltas).toEqual(["Hello", "Hello"]);
    expect(fake.requests.filter((request) => request["method"] === "turn/start")).toHaveLength(2);
    const threadStart = fake.requests.find((request) => request["method"] === "thread/start");
    const config = (threadStart?.["params"] as Record<string, unknown>)["config"] as Record<
      string,
      unknown
    >;
    expect(config["mcp_servers"]).toEqual({ slowServer: { enabled: false } });
    expect(config["plugins"]).toEqual({ "tool-plugin@example": { enabled: false } });
    await server.stop();
  });

  it("runs independent chat turns concurrently", async () => {
    const fake = fakeProcess();
    spawnMock.mockReturnValue(fake.child);
    const server = new CodexAppServer();
    const deltas: string[] = [];

    await Promise.all(
      ["first", "second"].map((prompt) =>
        server.run({
          prompt,
          signal: new AbortController().signal,
          onDelta: (delta) => deltas.push(`${prompt}:${delta}`),
        }),
      ),
    );

    expect(fake.requests.filter((request) => request["method"] === "turn/start")).toHaveLength(2);
    expect(deltas).toEqual(expect.arrayContaining(["first:Hello", "second:Hello"]));
    await server.stop();
  });

  it("maps AbortSignal cancellation to turn/interrupt", async () => {
    const fake = fakeProcess({ complete: false });
    spawnMock.mockReturnValue(fake.child);
    const server = new CodexAppServer();
    const controller = new AbortController();
    const running = server.run({
      prompt: "long answer",
      signal: controller.signal,
      onDelta: () => controller.abort(),
    });

    await expect(running).rejects.toThrow("aborted");

    expect(fake.requests.some((request) => request["method"] === "turn/interrupt")).toBe(true);
    await server.stop();
  });

  it("cancels immediately while turn/start is still pending", async () => {
    const fake = fakeProcess({ complete: false, delayTurnStart: true });
    spawnMock.mockReturnValue(fake.child);
    const server = new CodexAppServer();
    const controller = new AbortController();
    const running = server.run({
      prompt: "cancel during startup",
      signal: controller.signal,
      onDelta: () => {},
    });

    await vi.waitFor(() => {
      expect(fake.requests.some((request) => request["method"] === "turn/start")).toBe(true);
    });
    controller.abort();

    await expect(running).rejects.toThrow("aborted");
    await server.stop();
  });

  it("times out a turn that never completes", async () => {
    const fake = fakeProcess({ complete: false });
    spawnMock.mockReturnValue(fake.child);
    const server = new CodexAppServer(10);

    await expect(
      server.run({
        prompt: "stuck answer",
        signal: new AbortController().signal,
        onDelta: () => {},
      }),
    ).rejects.toThrow("timed out");
    await server.stop();
  });
});
