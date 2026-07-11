import { describe, expect, it, vi } from "vitest";

// agentOps.ts reaches Electron transitively (vault.js / secrets.js) and pulls
// in the Claude Agent SDK; the tool guard under test is pure, so stub those out.
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
  createSdkMcpServer: vi.fn(() => ({})),
  tool: vi.fn(),
}));
vi.mock("./vault.js", () => ({
  vaultRoot: () => "/tmp/vault",
  readTree: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  renameEntry: vi.fn(),
  readPrivacyRules: vi.fn(),
}));
vi.mock("./secrets.js", () => ({
  getSecret: () => undefined,
  keyFingerprint: () => "",
}));

import { checkToolUse, isWritablePath, runAgentOp } from "./agentOps.js";
import * as vault from "./vault.js";
import { query } from "@anthropic-ai/claude-agent-sdk";

const ROOT = "/tmp/vault";

describe("isWritablePath — what the agent may write", () => {
  it("allows notes anywhere in the user's structure", () => {
    expect(isWritablePath("projects/roadmap.md")).toBe(true);
    expect(isWritablePath("notes/journal.md")).toBe(true);
    expect(isWritablePath("deeply/nested/idea.md")).toBe(true);
    expect(isWritablePath("random.md")).toBe(true);
  });

  it("allows the AI guide (the agent maintains its vault map)", () => {
    expect(isWritablePath(".kestravault/instructions.md")).toBe(true);
  });

  it("blocks every other dotfile and app metadata", () => {
    expect(isWritablePath(".kestravault/config.json")).toBe(false);
    expect(isWritablePath(".kestravault/skills.json")).toBe(false);
    expect(isWritablePath(".git/config")).toBe(false);
    expect(isWritablePath("notes/.hidden.md")).toBe(false);
    expect(isWritablePath("")).toBe(false);
  });
});

describe("checkToolUse — per-call enforcement", () => {
  it("lets the agent read anywhere inside the vault", () => {
    for (const p of [`${ROOT}/projects/a.md`, `${ROOT}/notes/b.md`, `${ROOT}/.kestravault/instructions.md`]) {
      expect(checkToolUse(ROOT, "Read", { file_path: p }).ok).toBe(true);
    }
  });

  it("refuses reads that escape the vault", () => {
    const res = checkToolUse(ROOT, "Read", { file_path: "/etc/passwd" });
    expect(res.ok).toBe(false);
  });

  it("refuses path traversal out of the vault", () => {
    const res = checkToolUse(ROOT, "Write", {
      file_path: `${ROOT}/notes/../../elsewhere/x.md`,
      content: "",
    });
    expect(res.ok).toBe(false);
  });

  it("allows writes to notes and the guide, but not app metadata", () => {
    expect(checkToolUse(ROOT, "Write", { file_path: `${ROOT}/projects/x.md` }).ok).toBe(true);
    expect(checkToolUse(ROOT, "Edit", { file_path: `${ROOT}/notes/x.md` }).ok).toBe(true);
    expect(
      checkToolUse(ROOT, "Edit", { file_path: `${ROOT}/.kestravault/instructions.md` }).ok,
    ).toBe(true);
    expect(
      checkToolUse(ROOT, "Write", { file_path: `${ROOT}/.kestravault/config.json` }).ok,
    ).toBe(false);
  });

  it("resolves relative tool paths against the vault root", () => {
    const ok = checkToolUse(ROOT, "Write", { file_path: "topics/y.md" });
    expect(ok).toEqual({ ok: true, action: "write", path: "topics/y.md" });
  });

  it("validates moves: inside the vault, both ends writable", () => {
    expect(checkToolUse(ROOT, "mcp__vault__move_note", { from: "a.md", to: "archive/a.md" })).toEqual(
      { ok: true, action: "move", from: "a.md", to: "archive/a.md" },
    );
    expect(checkToolUse(ROOT, "mcp__vault__move_note", { from: "a.md" }).ok).toBe(false);
    expect(
      checkToolUse(ROOT, "mcp__vault__move_note", { from: "a.md", to: "/etc/x.md" }).ok,
    ).toBe(false);
    expect(
      checkToolUse(ROOT, "mcp__vault__move_note", { from: ".kestravault/config.json", to: "x.md" }).ok,
    ).toBe(false);
  });

  it("supports search tools scoped to the vault and rejects everything else", () => {
    expect(checkToolUse(ROOT, "Glob", { pattern: "**/*.md" }).ok).toBe(true);
    expect(checkToolUse(ROOT, "Grep", { pattern: "ownership", path: ROOT }).ok).toBe(true);
    expect(checkToolUse(ROOT, "Glob", { pattern: "*", path: "/" }).ok).toBe(false);
    expect(checkToolUse(ROOT, "Bash", { command: "rm -rf /" }).ok).toBe(false);
    expect(checkToolUse(ROOT, "WebFetch", { url: "https://x.test" }).ok).toBe(false);
  });
});

describe("runAgentOp — privacy guard", () => {
  it("rejects private targets before starting the remote agent", async () => {
    vi.mocked(vault.readPrivacyRules).mockResolvedValue([
      {
        path: "notes/private.md",
        target: "file",
        mode: "cloud-ai-private",
        updatedAt: "2026-07-09T12:00:00.000Z",
        source: "local",
      },
    ]);
    vi.mocked(vault.readFile).mockResolvedValue("secret");
    const send = vi.fn();
    const win = { isDestroyed: () => false, webContents: { send } };

    await runAgentOp(win as never, {
      requestId: "r1",
      op: "file",
      targetPath: "notes/private.md",
      provider: { kind: "subscription" },
    });

    expect(query).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      "ai:agent-event",
      expect.objectContaining({ requestId: "r1", type: "error" }),
    );
  });

  it("rejects a custom skill with no instruction", async () => {
    const send = vi.fn();
    const win = { isDestroyed: () => false, webContents: { send } };

    await runAgentOp(win as never, {
      requestId: "r2",
      op: "custom",
      prompt: "   ",
      provider: { kind: "subscription" },
    });

    expect(query).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      "ai:agent-event",
      expect.objectContaining({ requestId: "r2", type: "error" }),
    );
  });
});
