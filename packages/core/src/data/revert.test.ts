import { describe, expect, it } from "vitest";
import type { ChangeSet, FileChange, FileRecord } from "../types/entities.js";
import { sha256Hex } from "../utils/hash.js";
import { deriveFileMeta } from "../sync/derive.js";
import { InMemoryChangeSetRepo, InMemoryFileRepo } from "./in-memory.js";
import { revertChangeSet, RevertChangeSetError } from "./revert.js";

const WS = "ws-1";
const NOW = "2026-07-08T12:00:00.000Z";
const ALICE = "00000000-0000-4000-8000-00000000000a";

function idSource(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

function changeSet(overrides: Partial<ChangeSet> = {}): ChangeSet {
  return {
    id: "cs-agent",
    workspaceId: WS,
    kind: "ingest",
    summary: "Ingested Rust notes",
    sourceEvent: { sourceId: "source-1" },
    authorId: null,
    createdAt: NOW,
    reverted: false,
    ...overrides,
  };
}

function fileChange(overrides: Partial<FileChange> = {}): FileChange {
  return {
    id: "fc-1",
    changeSetId: "cs-agent",
    fileId: "f-1",
    op: "update",
    beforeVersion: 1,
    afterVersion: 2,
    diff: "",
    ...overrides,
  };
}

async function commitFile(
  files: InMemoryFileRepo,
  input: {
    id: string;
    path: string;
    content: string;
    expectedVersion: number;
    updatedBy: "human" | "agent";
    deleted?: boolean;
    changeSetId?: string | null;
  },
): Promise<FileRecord> {
  const meta = deriveFileMeta(input.path, input.content);
  const record: FileRecord = {
    id: input.id,
    workspaceId: WS,
    path: input.path,
    ...meta,
    content: input.content,
    sha256: await sha256Hex(input.content),
    version: input.expectedVersion + 1,
    updatedBy: input.updatedBy,
    updatedAt: NOW,
    deleted: input.deleted ?? false,
  };
  const result = await files.commit(record, {
    versionId: `${input.id}-v${record.version}`,
    expectedVersion: input.expectedVersion,
    authorId: input.updatedBy === "human" ? ALICE : null,
    changeSetId: input.changeSetId ?? null,
  });
  if (result.status !== "committed") throw new Error("seed commit failed");
  return result.file;
}

function deps(files: InMemoryFileRepo, changeSets: InMemoryChangeSetRepo) {
  return {
    files,
    changeSets,
    authorId: ALICE,
    newId: idSource("id"),
    now: () => NOW,
  };
}

describe("revertChangeSet", () => {
  it("restores an update to the previous file version and marks the original reverted", async () => {
    const files = new InMemoryFileRepo();
    const changeSets = new InMemoryChangeSetRepo();
    const original = await commitFile(files, {
      id: "f-1",
      path: "wiki/rust.md",
      content: "# Rust\n\nBefore\n",
      expectedVersion: 0,
      updatedBy: "human",
    });
    await changeSets.create(changeSet(), [fileChange({ fileId: original.id })]);
    await commitFile(files, {
      id: original.id,
      path: original.path,
      content: "# Rust\n\nAfter agent\n",
      expectedVersion: 1,
      updatedBy: "agent",
      changeSetId: "cs-agent",
    });

    const result = await revertChangeSet("cs-agent", deps(files, changeSets));

    expect(result).toMatchObject({
      status: "reverted",
      changeSetId: "cs-agent",
      files: [{ fileId: original.id, path: original.path, beforeVersion: 2, afterVersion: 3 }],
    });
    expect(await files.get(original.id)).toMatchObject({
      content: "# Rust\n\nBefore\n",
      version: 3,
      updatedBy: "human",
      deleted: false,
    });
    expect((await files.getVersion(original.id, 3))?.authorId).toBe(ALICE);
    expect((await changeSets.get("cs-agent"))?.reverted).toBe(true);
    const revertSet = await changeSets.get(
      result.status === "reverted" ? result.revertChangeSetId : "",
    );
    expect(revertSet).toMatchObject({
      kind: "manual",
      summary: "Reverted: Ingested Rust notes",
      sourceEvent: { revertsChangeSetId: "cs-agent" },
    });
    expect(await changeSets.listChanges(revertSet!.id)).toMatchObject([
      { fileId: original.id, op: "update", beforeVersion: 2, afterVersion: 3 },
    ]);
  });

  it("reverts an agent-created file by soft-deleting it", async () => {
    const files = new InMemoryFileRepo();
    const changeSets = new InMemoryChangeSetRepo();
    await changeSets.create(changeSet(), [
      fileChange({ op: "create", beforeVersion: null, afterVersion: 1 }),
    ]);
    await commitFile(files, {
      id: "f-1",
      path: "wiki/new.md",
      content: "# New\n",
      expectedVersion: 0,
      updatedBy: "agent",
      changeSetId: "cs-agent",
    });

    await revertChangeSet("cs-agent", deps(files, changeSets));

    expect(await files.get("f-1")).toMatchObject({
      path: "wiki/new.md",
      content: "# New\n",
      version: 2,
      deleted: true,
    });
    expect(await changeSets.listChanges("id-1")).toMatchObject([
      { fileId: "f-1", op: "delete", beforeVersion: 1, afterVersion: null },
    ]);
  });

  it("reverts an agent delete by restoring the previous version", async () => {
    const files = new InMemoryFileRepo();
    const changeSets = new InMemoryChangeSetRepo();
    const original = await commitFile(files, {
      id: "f-1",
      path: "wiki/old.md",
      content: "# Old\n",
      expectedVersion: 0,
      updatedBy: "human",
    });
    await changeSets.create(changeSet(), [
      fileChange({ fileId: original.id, op: "delete", beforeVersion: 1, afterVersion: null }),
    ]);
    await commitFile(files, {
      id: original.id,
      path: original.path,
      content: original.content,
      expectedVersion: 1,
      updatedBy: "agent",
      deleted: true,
      changeSetId: "cs-agent",
    });

    await revertChangeSet("cs-agent", deps(files, changeSets));

    expect(await files.get(original.id)).toMatchObject({
      content: "# Old\n",
      version: 3,
      deleted: false,
    });
  });

  it("refuses to revert when a touched file has newer work", async () => {
    const files = new InMemoryFileRepo();
    const changeSets = new InMemoryChangeSetRepo();
    const original = await commitFile(files, {
      id: "f-1",
      path: "wiki/rust.md",
      content: "Before\n",
      expectedVersion: 0,
      updatedBy: "human",
    });
    await changeSets.create(changeSet(), [fileChange({ fileId: original.id })]);
    await commitFile(files, {
      id: original.id,
      path: original.path,
      content: "Agent\n",
      expectedVersion: 1,
      updatedBy: "agent",
      changeSetId: "cs-agent",
    });
    await commitFile(files, {
      id: original.id,
      path: original.path,
      content: "Human later\n",
      expectedVersion: 2,
      updatedBy: "human",
    });

    await expect(revertChangeSet("cs-agent", deps(files, changeSets))).rejects.toThrow(
      RevertChangeSetError,
    );
    expect((await changeSets.get("cs-agent"))?.reverted).toBe(false);
    expect(await files.get(original.id)).toMatchObject({
      content: "Human later\n",
      version: 3,
    });
  });

  it("is idempotent after the original change-set is marked reverted", async () => {
    const files = new InMemoryFileRepo();
    const changeSets = new InMemoryChangeSetRepo();
    await changeSets.create(changeSet({ reverted: true }), [fileChange()]);

    await expect(revertChangeSet("cs-agent", deps(files, changeSets))).resolves.toEqual({
      status: "already_reverted",
      changeSetId: "cs-agent",
      revertChangeSetId: null,
      files: [],
    });
  });
});
