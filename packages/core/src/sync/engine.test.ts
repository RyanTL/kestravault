import { describe, expect, it } from "vitest";
import { InMemoryFileRepo } from "../data/in-memory.js";
import type { CommitFileOptions, CommitFileResult } from "../data/repositories.js";
import type { FileRecord } from "../types/entities.js";
import { sha256Hex } from "../utils/hash.js";
import { deriveFileMeta, deriveZone } from "./derive.js";
import { syncVault } from "./engine.js";
import { InMemoryLocalVaultStore } from "./local.js";
import { emptySyncState } from "./types.js";

const WS = "ws-1";
const NOW = "2026-07-03T12:00:00.000Z";
const ALICE = "00000000-0000-4000-8000-00000000000a";
const BOB = "00000000-0000-4000-8000-00000000000b";

/** Deterministic id source so records are stable across runs. */
function idSource(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

/** Commit a file to the repo as if another device/member had synced it. */
async function seedRemote(
  repo: InMemoryFileRepo,
  path: string,
  content: string,
  opts: { id?: string; authorId?: string | null } = {},
): Promise<FileRecord> {
  const meta = deriveFileMeta(path, content);
  const file: FileRecord = {
    id: opts.id ?? `remote-${path}`,
    workspaceId: WS,
    path,
    ...meta,
    content,
    sha256: await sha256Hex(content),
    version: 1,
    updatedBy: "human",
    updatedAt: NOW,
    deleted: false,
  };
  const result = await repo.commit(file, {
    versionId: `${file.id}-v1`,
    expectedVersion: 0,
    authorId: opts.authorId ?? BOB,
  });
  if (result.status !== "committed") throw new Error("seed failed");
  return result.file;
}

/** Commit the next version of an existing remote file (a concurrent writer). */
async function editRemote(
  repo: InMemoryFileRepo,
  record: FileRecord,
  content: string,
  opts: { deleted?: boolean } = {},
): Promise<FileRecord> {
  const next: FileRecord = {
    ...record,
    content,
    sha256: await sha256Hex(content),
    version: record.version + 1,
    updatedAt: NOW,
    deleted: opts.deleted ?? false,
  };
  const result = await repo.commit(next, {
    versionId: `${record.id}-v${next.version}`,
    expectedVersion: record.version,
    authorId: BOB,
  });
  if (result.status !== "committed") throw new Error("remote edit failed");
  return result.file;
}

function makeDeps(repo: InMemoryFileRepo, local: InMemoryLocalVaultStore) {
  return {
    files: repo,
    local,
    authorId: ALICE,
    newId: idSource("id"),
    now: () => NOW,
  };
}

describe("syncVault — first sync", () => {
  it("pulls every remote file into an empty vault", async () => {
    const repo = new InMemoryFileRepo();
    const local = new InMemoryLocalVaultStore();
    await seedRemote(repo, "notes/hello.md", "# Hello");
    await seedRemote(repo, "wiki/rust.md", "# Rust");

    const report = await syncVault(emptySyncState(WS), makeDeps(repo, local));

    expect(report.pulled.sort()).toEqual(["notes/hello.md", "wiki/rust.md"]);
    expect(report.errors).toEqual([]);
    expect(await local.read("notes/hello.md")).toBe("# Hello");
    expect(await local.read("wiki/rust.md")).toBe("# Rust");
    expect(Object.keys(report.state.files).sort()).toEqual([
      "notes/hello.md",
      "wiki/rust.md",
    ]);
  });

  it("pushes every local file into an empty workspace, deriving metadata", async () => {
    const repo = new InMemoryFileRepo();
    const local = new InMemoryLocalVaultStore([
      { path: "notes/todo.md", content: "- [ ] ship sync" },
      {
        path: "wiki/concepts/ownership.md",
        content: "---\ntitle: Ownership in Rust\ntype: concept\n---\n\nBody",
      },
    ]);

    const report = await syncVault(emptySyncState(WS), makeDeps(repo, local));

    expect(report.pushed.sort()).toEqual([
      "notes/todo.md",
      "wiki/concepts/ownership.md",
    ]);
    const todo = await repo.getByPath(WS, "notes/todo.md");
    expect(todo).toMatchObject({
      zone: "notes",
      type: "note",
      title: "todo",
      version: 1,
      updatedBy: "human",
    });
    const ownership = await repo.getByPath(WS, "wiki/concepts/ownership.md");
    expect(ownership).toMatchObject({
      zone: "wiki",
      type: "concept",
      title: "Ownership in Rust",
    });
    // The push wrote an attributed v1 into history.
    const versions = await repo.listVersions(todo!.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ version: 1, authorId: ALICE });
  });

  it("adopts identical files present on both sides without writing anything", async () => {
    const repo = new InMemoryFileRepo();
    const local = new InMemoryLocalVaultStore([{ path: "notes/same.md", content: "same" }]);
    const remote = await seedRemote(repo, "notes/same.md", "same");

    const report = await syncVault(emptySyncState(WS), makeDeps(repo, local));

    expect(report.pushed).toEqual([]);
    expect(report.pulled).toEqual([]);
    expect(report.conflicts).toEqual([]);
    expect(report.state.files["notes/same.md"]).toMatchObject({
      fileId: remote.id,
      version: 1,
    });
  });
});

describe("syncVault — steady state", () => {
  async function syncedFixture(content = "line1\nline2\nline3\n") {
    const repo = new InMemoryFileRepo();
    const local = new InMemoryLocalVaultStore();
    const remote = await seedRemote(repo, "notes/doc.md", content);
    const first = await syncVault(emptySyncState(WS), makeDeps(repo, local));
    return { repo, local, remote, state: first.state };
  }

  it("is idempotent when nothing changed", async () => {
    const { repo, local, state } = await syncedFixture();
    const report = await syncVault(state, makeDeps(repo, local));
    expect(report.pulled).toEqual([]);
    expect(report.pushed).toEqual([]);
    expect(report.merged).toEqual([]);
    expect(report.conflicts).toEqual([]);
    expect(report.state).toEqual(state);
  });

  it("pushes a local edit as the next version", async () => {
    const { repo, local, remote, state } = await syncedFixture();
    await local.write("notes/doc.md", "line1\nline2 edited\nline3\n");

    const report = await syncVault(state, makeDeps(repo, local));

    expect(report.pushed).toEqual(["notes/doc.md"]);
    const stored = await repo.get(remote.id);
    expect(stored).toMatchObject({ version: 2, content: "line1\nline2 edited\nline3\n" });
    expect(report.state.files["notes/doc.md"]).toMatchObject({ version: 2 });
  });

  it("pulls a remote edit", async () => {
    const { repo, local, remote, state } = await syncedFixture();
    await editRemote(repo, remote, "line1\nline2 remote\nline3\n");

    const report = await syncVault(state, makeDeps(repo, local));

    expect(report.pulled).toEqual(["notes/doc.md"]);
    expect(await local.read("notes/doc.md")).toBe("line1\nline2 remote\nline3\n");
  });

  it("3-way merges non-overlapping edits and pushes the merged text", async () => {
    const { repo, local, remote, state } = await syncedFixture();
    await local.write("notes/doc.md", "line1 local\nline2\nline3\n");
    await editRemote(repo, remote, "line1\nline2\nline3 remote\n");

    const report = await syncVault(state, makeDeps(repo, local));

    expect(report.merged).toEqual(["notes/doc.md"]);
    expect(report.conflicts).toEqual([]);
    const mergedText = "line1 local\nline2\nline3 remote\n";
    expect(await local.read("notes/doc.md")).toBe(mergedText);
    expect((await repo.get(remote.id))?.content).toBe(mergedText);
    expect((await repo.get(remote.id))?.version).toBe(3);
  });

  it("resolves overlapping edits first-committer-wins with a conflict copy", async () => {
    const { repo, local, remote, state } = await syncedFixture();
    await local.write("notes/doc.md", "line1\nline2 LOCAL\nline3\n");
    const committed = await editRemote(repo, remote, "line1\nline2 REMOTE\nline3\n");

    const report = await syncVault(state, makeDeps(repo, local));

    expect(report.conflicts).toEqual([
      { path: "notes/doc.md", conflictPath: "notes/doc.conflict.md" },
    ]);
    // The committed (remote) edit stays canonical on both sides.
    expect(await local.read("notes/doc.md")).toBe(committed.content);
    expect((await repo.get(remote.id))?.content).toBe(committed.content);
    // The losing local edit is preserved locally AND pushed for everyone.
    expect(await local.read("notes/doc.conflict.md")).toBe("line1\nline2 LOCAL\nline3\n");
    const copy = await repo.getByPath(WS, "notes/doc.conflict.md");
    expect(copy).toMatchObject({ content: "line1\nline2 LOCAL\nline3\n", version: 1 });
    // Both paths are tracked, so the next run is a no-op.
    const again = await syncVault(report.state, makeDeps(repo, local));
    expect(again.conflicts).toEqual([]);
    expect(again.pushed).toEqual([]);
  });

  it("resolves both-sides-new-at-same-path clashes with a conflict copy", async () => {
    const repo = new InMemoryFileRepo();
    const local = new InMemoryLocalVaultStore([{ path: "notes/new.md", content: "mine" }]);
    await seedRemote(repo, "notes/new.md", "theirs");

    const report = await syncVault(emptySyncState(WS), makeDeps(repo, local));

    expect(report.conflicts).toEqual([
      { path: "notes/new.md", conflictPath: "notes/new.conflict.md" },
    ]);
    expect(await local.read("notes/new.md")).toBe("theirs");
    expect(await local.read("notes/new.conflict.md")).toBe("mine");
  });
});

describe("syncVault — deletes", () => {
  async function syncedFixture() {
    const repo = new InMemoryFileRepo();
    const local = new InMemoryLocalVaultStore();
    const remote = await seedRemote(repo, "notes/doc.md", "content\n");
    const first = await syncVault(emptySyncState(WS), makeDeps(repo, local));
    return { repo, local, remote, state: first.state };
  }

  it("soft-deletes remotely when the file was deleted locally", async () => {
    const { repo, local, remote, state } = await syncedFixture();
    await local.remove("notes/doc.md");

    const report = await syncVault(state, makeDeps(repo, local));

    expect(report.deletedRemote).toEqual(["notes/doc.md"]);
    expect(await repo.get(remote.id)).toMatchObject({ deleted: true, version: 2 });
    expect(report.state.files["notes/doc.md"]).toBeUndefined();
  });

  it("removes locally when the file was deleted remotely", async () => {
    const { repo, local, remote, state } = await syncedFixture();
    await editRemote(repo, remote, "content\n", { deleted: true });

    const report = await syncVault(state, makeDeps(repo, local));

    expect(report.deletedLocal).toEqual(["notes/doc.md"]);
    expect(await local.read("notes/doc.md")).toBeNull();
  });

  it("edits beat deletes: a local edit resurrects a remotely deleted file", async () => {
    const { repo, local, remote, state } = await syncedFixture();
    await editRemote(repo, remote, "content\n", { deleted: true });
    await local.write("notes/doc.md", "content edited\n");

    const report = await syncVault(state, makeDeps(repo, local));

    expect(report.pushed).toEqual(["notes/doc.md"]);
    expect(await repo.get(remote.id)).toMatchObject({
      deleted: false,
      version: 3,
      content: "content edited\n",
    });
  });

  it("edits beat deletes: a remote edit is pulled back after a local delete", async () => {
    const { repo, local, remote, state } = await syncedFixture();
    await editRemote(repo, remote, "content remote\n");
    await local.remove("notes/doc.md");

    const report = await syncVault(state, makeDeps(repo, local));

    expect(report.pulled).toEqual(["notes/doc.md"]);
    expect(await local.read("notes/doc.md")).toBe("content remote\n");
  });
});

describe("syncVault — privacy sync filtering", () => {
  it("does not push a new local-only file", async () => {
    const repo = new InMemoryFileRepo();
    const local = new InMemoryLocalVaultStore([
      { path: "notes/private.md", content: "stays here" },
    ]);

    const report = await syncVault(emptySyncState(WS), {
      ...makeDeps(repo, local),
      shouldSyncPath: (path) => path !== "notes/private.md",
    });

    expect(report.pushed).toEqual([]);
    expect(await repo.getByPath(WS, "notes/private.md")).toBeNull();
    expect(report.state.files["notes/private.md"]).toBeUndefined();
  });

  it("soft-deletes an existing cloud copy when a synced file becomes local-only", async () => {
    const repo = new InMemoryFileRepo();
    const local = new InMemoryLocalVaultStore();
    const remote = await seedRemote(repo, "notes/private.md", "secret");
    const first = await syncVault(emptySyncState(WS), makeDeps(repo, local));

    const report = await syncVault(first.state, {
      ...makeDeps(repo, local),
      shouldSyncPath: (path) => path !== "notes/private.md",
    });

    expect(report.deletedRemote).toEqual(["notes/private.md"]);
    expect(await repo.get(remote.id)).toMatchObject({ deleted: true, version: 2 });
    expect(report.state.files["notes/private.md"]).toBeUndefined();
  });

  it("deletes and does not pull a remote-only local-only path", async () => {
    const repo = new InMemoryFileRepo();
    const local = new InMemoryLocalVaultStore();
    const remote = await seedRemote(repo, "notes/private.md", "secret");

    const report = await syncVault(emptySyncState(WS), {
      ...makeDeps(repo, local),
      shouldSyncPath: (path) => path !== "notes/private.md",
    });

    expect(report.pulled).toEqual([]);
    expect(report.deletedRemote).toEqual(["notes/private.md"]);
    expect(await local.read("notes/private.md")).toBeNull();
    expect(await repo.get(remote.id)).toMatchObject({ deleted: true });
  });

  it("still syncs cloud-AI-private files because they are cloud eligible", async () => {
    const repo = new InMemoryFileRepo();
    const local = new InMemoryLocalVaultStore([
      {
        path: "notes/cloud-private.md",
        content: "---\nprivate: true\n---\n\nsecret",
      },
    ]);

    const report = await syncVault(emptySyncState(WS), {
      ...makeDeps(repo, local),
      shouldSyncPath: () => true,
    });

    expect(report.pushed).toEqual(["notes/cloud-private.md"]);
    expect(await repo.getByPath(WS, "notes/cloud-private.md")).toMatchObject({
      content: "---\nprivate: true\n---\n\nsecret",
    });
  });
});

describe("syncVault — commit races", () => {
  it("re-merges immediately when a push loses the optimistic commit", async () => {
    const repo = new InMemoryFileRepo();
    const local = new InMemoryLocalVaultStore();
    const remote = await seedRemote(repo, "notes/doc.md", "line1\nline2\nline3\n");
    const { state } = await syncVault(emptySyncState(WS), makeDeps(repo, local));

    await local.write("notes/doc.md", "line1 local\nline2\nline3\n");

    // A competing writer lands v2 between our list() and our commit(): simulate
    // by injecting the edit on the first commit attempt only.
    let injected = false;
    const originalCommit = repo.commit.bind(repo);
    repo.commit = async (
      file: FileRecord,
      opts: CommitFileOptions,
    ): Promise<CommitFileResult> => {
      if (!injected) {
        injected = true;
        await editRemote(repo, remote, "line1\nline2\nline3 remote\n");
      }
      return originalCommit(file, opts);
    };

    const report = await syncVault(state, makeDeps(repo, local));

    expect(report.errors).toEqual([]);
    expect(report.merged).toEqual(["notes/doc.md"]);
    const mergedText = "line1 local\nline2\nline3 remote\n";
    expect(await local.read("notes/doc.md")).toBe(mergedText);
    expect((await repo.get(remote.id))?.content).toBe(mergedText);
  });

  it("keeps going and reports per-file errors instead of failing the run", async () => {
    const repo = new InMemoryFileRepo();
    const local = new InMemoryLocalVaultStore([
      { path: "notes/bad.md", content: "x" },
      { path: "notes/good.md", content: "y" },
    ]);
    const originalCommit = repo.commit.bind(repo);
    repo.commit = async (
      file: FileRecord,
      opts: CommitFileOptions,
    ): Promise<CommitFileResult> => {
      if (file.path === "notes/bad.md") throw new Error("boom");
      return originalCommit(file, opts);
    };

    const report = await syncVault(emptySyncState(WS), makeDeps(repo, local));

    expect(report.pushed).toEqual(["notes/good.md"]);
    expect(report.errors).toEqual([{ path: "notes/bad.md", message: "boom" }]);
  });
});

describe("deriveZone / deriveFileMeta", () => {
  it("maps top-level folders to zones, defaulting to notes", () => {
    expect(deriveZone("sources/s-2026-07-03-x.md")).toBe("sources");
    expect(deriveZone("wiki/concepts/a.md")).toBe("wiki");
    expect(deriveZone("notes/a.md")).toBe("notes");
    expect(deriveZone("Welcome.md")).toBe("notes");
    expect(deriveZone("journal/2026.md")).toBe("notes");
  });

  it("prefers frontmatter type/title and falls back to zone defaults + stem", () => {
    expect(deriveFileMeta("wiki/x.md", "---\ntype: topic\ntitle: X marks\n---\n\nBody"))
      .toEqual({ zone: "wiki", type: "topic", title: "X marks" });
    expect(deriveFileMeta("sources/s.md", "raw")).toEqual({
      zone: "sources",
      type: "source",
      title: "s",
    });
    expect(deriveFileMeta("notes/plain.md", "no frontmatter")).toEqual({
      zone: "notes",
      type: "note",
      title: "plain",
    });
  });

  it("ignores an invalid frontmatter type and malformed YAML", () => {
    expect(deriveFileMeta("notes/a.md", "---\ntype: nonsense\n---\n\nx").type).toBe("note");
    expect(deriveFileMeta("notes/a.md", "---\n[broken yaml\n---\n\nx").type).toBe("note");
  });
});
