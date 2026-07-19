import { promises as fs } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// vault.ts imports `electron` at module load; stub the one surface it touches so
// the module imports cleanly under the node test runner. safeResolve itself is
// pure (takes root explicitly) and needs none of it.
const trashItem = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/kestravault-test" },
  shell: { trashItem },
}));

const {
  safeResolve,
  ensureVault,
  writeFile,
  readFile,
  createDir,
  readTree,
  setEntryPrivacy,
  clearEntryPrivacy,
  renameEntry,
  deleteEntry,
  readFiles,
} = await import("./vault.js");

const ROOT = "/Users/ryan/KestraVault Vault";
const TEST_HOME = "/tmp/kestravault-test";

beforeEach(async () => {
  await fs.rm(TEST_HOME, { recursive: true, force: true });
  trashItem.mockClear();
});

describe("safeResolve", () => {
  it("resolves ordinary relative paths inside the vault", () => {
    expect(safeResolve(ROOT, "wiki/a.md")).toBe(`${ROOT}/wiki/a.md`);
    expect(safeResolve(ROOT, "notes/./b.md")).toBe(`${ROOT}/notes/b.md`);
    expect(safeResolve(ROOT, "wiki/sub/../c.md")).toBe(`${ROOT}/wiki/c.md`);
  });

  it("blocks ../ traversal out of the vault", () => {
    expect(() => safeResolve(ROOT, "../../etc/passwd")).toThrow(/escapes the vault/);
    expect(() => safeResolve(ROOT, "sub/../../../etc/passwd")).toThrow(/escapes the vault/);
  });

  it("treats an empty path as the vault root", () => {
    expect(safeResolve(ROOT, "")).toBe(ROOT);
  });

  // The rejected-absolute rule is what closes the Windows cross-drive hole: on
  // Windows a path like `C:\Windows` (vault on `D:\`) is absolute, so it's
  // refused here before the relative()/resolve() round-trip that used to let it
  // through. `/etc/passwd` exercises the same isAbsolute guard on this runner.
  it("blocks absolute paths (incl. the Windows cross-drive case)", () => {
    expect(() => safeResolve(ROOT, "/etc/passwd")).toThrow(/escapes the vault/);
  });
});

describe("vault privacy", () => {
  it("marks inherited folder privacy in the tree", async () => {
    await ensureVault();
    await createDir("notes/clients");
    await writeFile("notes/clients/acme.md", "secret");
    await setEntryPrivacy("notes/clients", "folder", "cloud-ai-private");

    const tree = await readTree();
    const notes = tree.find((n) => n.kind === "dir" && n.path === "notes");
    const clients =
      notes?.kind === "dir" ? notes.children.find((n) => n.path === "notes/clients") : null;
    const acme =
      clients?.kind === "dir"
        ? clients.children.find((n) => n.path === "notes/clients/acme.md")
        : null;

    expect(clients).toMatchObject({
      kind: "dir",
      privacy: { mode: "cloud-ai-private", explicit: true },
    });
    expect(acme).toMatchObject({
      kind: "file",
      privacy: { mode: "cloud-ai-private", inherited: true },
      private: true,
    });
  });

  it("writes and removes legacy private frontmatter for note-level cloud privacy", async () => {
    await ensureVault();
    await writeFile("notes/private.md", "body");

    await setEntryPrivacy("notes/private.md", "file", "cloud-ai-private");
    expect(await readFile("notes/private.md")).toContain("private: true");

    await setEntryPrivacy("notes/private.md", "file", "public");
    expect(await readFile("notes/private.md")).not.toContain("private: true");

    await setEntryPrivacy("notes/private.md", "file", "cloud-ai-private");
    await clearEntryPrivacy("notes/private.md", "file");
    expect(await readFile("notes/private.md")).not.toContain("private: true");
  });

  it("remaps privacy rules on rename", async () => {
    await ensureVault();
    await createDir("notes/clients");
    await writeFile("notes/clients/acme.md", "secret");
    await setEntryPrivacy("notes/clients", "folder", "local-only");

    await renameEntry("notes/clients", "notes/accounts");
    const tree = await readTree();
    const notes = tree.find((n) => n.kind === "dir" && n.path === "notes");
    const accounts =
      notes?.kind === "dir" ? notes.children.find((n) => n.path === "notes/accounts") : null;

    expect(accounts).toMatchObject({
      kind: "dir",
      privacy: { mode: "local-only", explicit: true },
    });
  });
});

describe("deleteEntry", () => {
  it("moves an existing entry to the system trash", async () => {
    await ensureVault();
    await writeFile("notes/delete-me.md", "temporary");

    await deleteEntry("notes/delete-me.md");

    expect(trashItem).toHaveBeenCalledWith(`${TEST_HOME}/KestraVault Vault/notes/delete-me.md`);
  });
});

describe("readFiles", () => {
  it("deduplicates paths and tolerates a file disappearing during the batch", async () => {
    await ensureVault();
    await writeFile("notes/a.md", "alpha");

    await expect(readFiles(["notes/a.md", "notes/a.md", "notes/missing.md"])).resolves.toEqual([
      { path: "notes/a.md", content: "alpha" },
      { path: "notes/missing.md", content: "" },
    ]);
  });
});
