import { describe, expect, it, vi } from "vitest";

// agentOps.ts reaches Electron transitively (vault.js / secrets.js) and pulls
// in the Claude Agent SDK; the zone guard under test is pure, so stub those out.
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));
vi.mock("./vault.js", () => ({
  vaultRoot: () => "/tmp/vault",
  readTree: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
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

describe("isWritablePath — the agent's writable zones", () => {
  it("allows wiki pages, the index and the log", () => {
    expect(isWritablePath("wiki/concepts/ownership.md")).toBe(true);
    expect(isWritablePath("wiki/sources/s-2026-07-01-x.md")).toBe(true);
    expect(isWritablePath("index.md")).toBe(true);
    expect(isWritablePath("log.md")).toBe(true);
  });

  it("blocks the immutable/human/meta zones", () => {
    expect(isWritablePath("sources/s-2026-07-01-x.md")).toBe(false);
    expect(isWritablePath("notes/journal.md")).toBe(false);
    expect(isWritablePath(".kestravault/instructions.md")).toBe(false);
    expect(isWritablePath("AGENTS.md")).toBe(false);
    expect(isWritablePath("CLAUDE.md")).toBe(false);
    expect(isWritablePath("random.md")).toBe(false);
  });
});

describe("checkToolUse — per-call zone enforcement", () => {
  it("lets the agent read anywhere inside the vault", () => {
    for (const p of [`${ROOT}/sources/a.md`, `${ROOT}/notes/b.md`, `${ROOT}/.kestravault/instructions.md`]) {
      expect(checkToolUse(ROOT, "Read", { file_path: p }).ok).toBe(true);
    }
  });

  it("refuses reads that escape the vault", () => {
    const res = checkToolUse(ROOT, "Read", { file_path: "/etc/passwd" });
    expect(res.ok).toBe(false);
  });

  it("refuses path traversal out of the vault", () => {
    const res = checkToolUse(ROOT, "Write", {
      file_path: `${ROOT}/wiki/../../elsewhere/x.md`,
      content: "",
    });
    expect(res.ok).toBe(false);
  });

  it("allows writes only to wiki/, index.md and log.md", () => {
    expect(checkToolUse(ROOT, "Write", { file_path: `${ROOT}/wiki/concepts/x.md` }).ok).toBe(true);
    expect(checkToolUse(ROOT, "Edit", { file_path: `${ROOT}/index.md` }).ok).toBe(true);
    expect(checkToolUse(ROOT, "Write", { file_path: `${ROOT}/sources/x.md` }).ok).toBe(false);
    expect(checkToolUse(ROOT, "Edit", { file_path: `${ROOT}/notes/x.md` }).ok).toBe(false);
    expect(
      checkToolUse(ROOT, "Write", { file_path: `${ROOT}/.kestravault/instructions.md` }).ok,
    ).toBe(false);
  });

  it("resolves relative tool paths against the vault root", () => {
    const ok = checkToolUse(ROOT, "Write", { file_path: "wiki/topics/y.md" });
    expect(ok).toEqual({ ok: true, action: "write", path: "wiki/topics/y.md" });
  });

  it("supports search tools scoped to the vault and rejects everything else", () => {
    expect(checkToolUse(ROOT, "Glob", { pattern: "wiki/**/*.md" }).ok).toBe(true);
    expect(checkToolUse(ROOT, "Grep", { pattern: "ownership", path: ROOT }).ok).toBe(true);
    expect(checkToolUse(ROOT, "Glob", { pattern: "*", path: "/" }).ok).toBe(false);
    expect(checkToolUse(ROOT, "Bash", { command: "rm -rf /" }).ok).toBe(false);
    expect(checkToolUse(ROOT, "WebFetch", { url: "https://x.test" }).ok).toBe(false);
  });
});

describe("runAgentOp — privacy guard", () => {
  it("rejects private ingest targets before starting the remote agent", async () => {
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
      op: "ingest",
      targetPath: "notes/private.md",
      provider: { kind: "subscription" },
    });

    expect(query).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      "ai:agent-event",
      expect.objectContaining({ requestId: "r1", type: "error" }),
    );
  });
});
