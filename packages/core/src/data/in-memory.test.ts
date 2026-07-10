import { describe, expect, it } from "vitest";
import type {
  ChangeSet,
  FileChange,
  FileRecord,
  FileVersion,
  Workspace,
} from "../types/entities.js";
import {
  InMemoryChangeSetRepo,
  InMemoryFileRepo,
  InMemoryWorkspaceRepo,
} from "./in-memory.js";

const NOW = "2026-06-27T12:00:00.000Z";

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws-1",
    ownerId: "owner-1",
    name: "Brain",
    createdAt: NOW,
    config: { ingestMode: "async", runMode: "default", scaffold: ["concepts"] },
    ...overrides,
  };
}

function file(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    id: "f-1",
    workspaceId: "ws-1",
    path: "wiki/concepts/ownership.md",
    zone: "wiki",
    type: "concept",
    title: "Ownership",
    content: "# Ownership",
    sha256: "abc",
    version: 1,
    updatedBy: "agent",
    updatedAt: NOW,
    deleted: false,
    ...overrides,
  };
}

describe("InMemoryWorkspaceRepo", () => {
  it("upserts and reads back a deep copy (no shared references)", async () => {
    const repo = new InMemoryWorkspaceRepo();
    const ws = workspace();
    await repo.upsert(ws);

    const fetched = await repo.get("ws-1");
    expect(fetched).toEqual(ws);
    // Mutating the stored input must not leak into the repo.
    ws.name = "Mutated";
    ws.config.scaffold.push("topics");
    const again = await repo.get("ws-1");
    expect(again?.name).toBe("Brain");
    expect(again?.config.scaffold).toEqual(["concepts"]);
  });

  it("returns null for a missing id and filters by owner", async () => {
    const repo = new InMemoryWorkspaceRepo();
    await repo.upsert(workspace({ id: "ws-1", ownerId: "a" }));
    await repo.upsert(workspace({ id: "ws-2", ownerId: "b" }));
    expect(await repo.get("missing")).toBeNull();
    const owned = await repo.listByOwner("a");
    expect(owned.map((w) => w.id)).toEqual(["ws-1"]);
  });
});

describe("InMemoryFileRepo", () => {
  it("upserts, looks up by path, and replaces on re-upsert", async () => {
    const repo = new InMemoryFileRepo();
    await repo.upsert(file());
    const byPath = await repo.getByPath("ws-1", "wiki/concepts/ownership.md");
    expect(byPath?.id).toBe("f-1");

    await repo.upsert(file({ title: "Ownership (Rust)", version: 2 }));
    const updated = await repo.get("f-1");
    expect(updated?.title).toBe("Ownership (Rust)");
    expect(updated?.version).toBe(2);
  });

  it("filters list by zone and excludes soft-deleted unless asked", async () => {
    const repo = new InMemoryFileRepo();
    await repo.upsert(file({ id: "f-1", zone: "wiki" }));
    await repo.upsert(file({ id: "f-2", path: "notes/n.md", zone: "notes" }));
    await repo.upsert(file({ id: "f-3", path: "wiki/x.md", zone: "wiki", deleted: true }));

    const wiki = await repo.list("ws-1", { zone: "wiki" });
    expect(wiki.map((f) => f.id).sort()).toEqual(["f-1"]);

    const wikiWithDeleted = await repo.list("ws-1", { zone: "wiki", includeDeleted: true });
    expect(wikiWithDeleted.map((f) => f.id).sort()).toEqual(["f-1", "f-3"]);

    const all = await repo.list("ws-1");
    expect(all.map((f) => f.id).sort()).toEqual(["f-1", "f-2"]);
  });

  it("appends versions and reads them back sorted", async () => {
    const repo = new InMemoryFileRepo();
    const v = (version: number): FileVersion => ({
      id: `v-${version}`,
      fileId: "f-1",
      version,
      content: `c${version}`,
      sha256: `sha${version}`,
      updatedBy: "agent",
      authorId: null,
      changeSetId: null,
      createdAt: NOW,
    });
    await repo.addVersion(v(2));
    await repo.addVersion(v(1));

    const versions = await repo.listVersions("f-1");
    expect(versions.map((x) => x.version)).toEqual([1, 2]);
    expect(await repo.getVersion("f-1", 2)).toMatchObject({ id: "v-2" });
    expect(await repo.getVersion("f-1", 99)).toBeNull();
  });
});

describe("InMemoryChangeSetRepo", () => {
  const changeSet = (overrides: Partial<ChangeSet> = {}): ChangeSet => ({
    id: "cs-1",
    workspaceId: "ws-1",
    kind: "ingest",
    summary: "Ingested X",
    sourceEvent: { sourceId: "s-1" },
    authorId: null,
    createdAt: NOW,
    reverted: false,
    ...overrides,
  });

  const change: FileChange = {
    id: "fc-1",
    changeSetId: "cs-1",
    fileId: "f-1",
    op: "update",
    beforeVersion: 1,
    afterVersion: 2,
    diff: "@@ -1 +1 @@",
  };

  it("stores a change-set with its file changes atomically", async () => {
    const repo = new InMemoryChangeSetRepo();
    await repo.create(changeSet(), [change]);

    expect(await repo.get("cs-1")).toMatchObject({ id: "cs-1", kind: "ingest" });
    expect(await repo.listChanges("cs-1")).toEqual([change]);
    expect(await repo.listByWorkspace("ws-1")).toHaveLength(1);
    expect(await repo.listByWorkspace("other")).toEqual([]);
  });

  it("marks a change-set reverted", async () => {
    const repo = new InMemoryChangeSetRepo();
    await repo.create(changeSet(), []);
    await repo.markReverted("cs-1");
    expect((await repo.get("cs-1"))?.reverted).toBe(true);
  });
});
