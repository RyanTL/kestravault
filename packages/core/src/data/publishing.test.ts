import { beforeEach, describe, expect, it } from "vitest";
import type { FileRecord } from "../types/entities.js";
import { InMemoryFileRepo } from "./in-memory.js";
import { InMemoryNotePublishRepo, mintPublicToken } from "./publishing.js";

const WORKSPACE = "01J8ZWORKSPACE00000000000A";

function makeFile(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    id: "01J8ZFILE00000000000000001",
    workspaceId: WORKSPACE,
    path: "notes/2026-06-27-standup.md",
    zone: "notes",
    type: "note",
    title: "Standup notes",
    content: "Talked about [[Secret Project]].",
    sha256: "ab".repeat(32),
    version: 1,
    updatedBy: "human",
    updatedAt: "2026-07-01T10:00:00.000Z",
    deleted: false,
    ...overrides,
  };
}

describe("mintPublicToken", () => {
  it("mints 64-hex-char tokens that do not repeat", () => {
    const a = mintPublicToken();
    const b = mintPublicToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});

describe("InMemoryNotePublishRepo", () => {
  let files: InMemoryFileRepo;
  let repo: InMemoryNotePublishRepo;
  let tokenCounter: number;

  beforeEach(() => {
    files = new InMemoryFileRepo();
    tokenCounter = 0;
    repo = new InMemoryNotePublishRepo(files, {
      newToken: () => `token-${++tokenCounter}`.padEnd(32, "0"),
      now: () => "2026-07-03T09:00:00.000Z",
    });
  });

  it("publishes a notes-zone file and a valid token fetches it", async () => {
    const file = await files.upsert(makeFile());
    const publication = await repo.publish(file.id, WORKSPACE);
    expect(publication.published).toBe(true);

    const fetched = await repo.fetchPublishedByToken(publication.publicToken);
    expect(fetched).toEqual({
      title: "Standup notes",
      content: "Talked about [[Secret Project]].",
      publishedAt: "2026-07-03T09:00:00.000Z",
      updatedAt: "2026-07-01T10:00:00.000Z",
    });
  });

  it("exposes ONLY the narrow reader projection — no ids, paths, or workspace", async () => {
    const file = await files.upsert(makeFile());
    const { publicToken } = await repo.publish(file.id, WORKSPACE);
    const fetched = await repo.fetchPublishedByToken(publicToken);
    expect(Object.keys(fetched ?? {}).sort()).toEqual([
      "content",
      "publishedAt",
      "title",
      "updatedAt",
    ]);
  });

  it("is LIVE: fetch reflects the current note content, not a snapshot", async () => {
    const file = await files.upsert(makeFile());
    const { publicToken } = await repo.publish(file.id, WORKSPACE);
    await files.upsert({ ...file, content: "Edited after publishing.", version: 2 });
    const fetched = await repo.fetchPublishedByToken(publicToken);
    expect(fetched?.content).toBe("Edited after publishing.");
  });

  it("returns null for an unknown token", async () => {
    const file = await files.upsert(makeFile());
    await repo.publish(file.id, WORKSPACE);
    expect(await repo.fetchPublishedByToken("no-such-token")).toBeNull();
    expect(await repo.fetchPublishedByToken("")).toBeNull();
  });

  it("returns null after unpublishing — revocation is immediate", async () => {
    const file = await files.upsert(makeFile());
    const { publicToken } = await repo.publish(file.id, WORKSPACE);
    await repo.unpublish(file.id);
    expect(await repo.fetchPublishedByToken(publicToken)).toBeNull();
    const publication = await repo.getPublication(file.id);
    expect(publication?.published).toBe(false);
  });

  it("re-publishing mints a FRESH token; the revoked link stays dead", async () => {
    const file = await files.upsert(makeFile());
    const first = await repo.publish(file.id, WORKSPACE);
    await repo.unpublish(file.id);
    const second = await repo.publish(file.id, WORKSPACE);

    expect(second.publicToken).not.toBe(first.publicToken);
    expect(await repo.fetchPublishedByToken(first.publicToken)).toBeNull();
    expect(await repo.fetchPublishedByToken(second.publicToken)).not.toBeNull();
  });

  it.each(["wiki", "sources"] as const)("refuses to publish a %s-zone file", async (zone) => {
    const file = await files.upsert(
      makeFile({ id: "01J8ZFILE0000000000000000X", zone, path: `${zone}/page.md` }),
    );
    await expect(repo.publish(file.id, WORKSPACE)).rejects.toThrow(
      /only notes\/ files are publishable/,
    );
  });

  it("refuses to publish a missing, foreign, or deleted file", async () => {
    await expect(repo.publish("01J8ZNOSUCHFILE00000000000", WORKSPACE)).rejects.toThrow(
      /not found/,
    );
    const foreign = await files.upsert(makeFile({ id: "01J8ZFILE0000000000000000F" }));
    await expect(repo.publish(foreign.id, "01J8ZOTHERWORKSPACE0000000")).rejects.toThrow(
      /not found/,
    );
    const deleted = await files.upsert(
      makeFile({ id: "01J8ZFILE0000000000000000D", deleted: true }),
    );
    await expect(repo.publish(deleted.id, WORKSPACE)).rejects.toThrow(/not found/);
  });

  it("returns null for a token whose file was since deleted", async () => {
    const file = await files.upsert(makeFile());
    const { publicToken } = await repo.publish(file.id, WORKSPACE);
    await files.upsert({ ...file, deleted: true });
    expect(await repo.fetchPublishedByToken(publicToken)).toBeNull();
  });

  it("never exposes anything a published note links to", async () => {
    const target = await files.upsert(
      makeFile({
        id: "01J8ZFILE0000000000000000T",
        zone: "wiki",
        path: "wiki/concepts/secret-project.md",
        title: "Secret Project",
        content: "The private details.",
      }),
    );
    const note = await files.upsert(makeFile());
    const { publicToken } = await repo.publish(note.id, WORKSPACE);

    // The only anonymous read path is token -> note; the linked wiki page has
    // no publication row and therefore no reachable token.
    const fetched = await repo.fetchPublishedByToken(publicToken);
    expect(fetched?.content).toContain("[[Secret Project]]");
    expect(await repo.getPublication(target.id)).toBeNull();
  });
});
