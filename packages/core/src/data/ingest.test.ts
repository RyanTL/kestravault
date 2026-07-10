import { describe, expect, it } from "vitest";
import { INGEST_STUB_MARKER, ingestSource } from "./ingest.js";

describe("ingestSource (stub)", () => {
  const input = {
    workspaceId: "ws-1",
    sourcePath: "sources/s-2026-06-27-rust-intro.md",
    content: "# Intro to Rust ownership",
    mode: "deep" as const,
  };

  it("returns a well-formed ingest change-set", async () => {
    const changeSet = await ingestSource(input, {
      newId: () => "cs-deterministic",
      now: () => "2026-06-27T12:00:00.000Z",
    });

    expect(changeSet).toEqual({
      id: "cs-deterministic",
      workspaceId: "ws-1",
      kind: "ingest",
      summary: expect.stringContaining("sources/s-2026-06-27-rust-intro.md"),
      sourceEvent: {
        marker: INGEST_STUB_MARKER,
        sourcePath: "sources/s-2026-06-27-rust-intro.md",
        contentLength: input.content.length,
        mode: "deep",
      },
      authorId: null,
      createdAt: "2026-06-27T12:00:00.000Z",
      reverted: false,
    });
  });

  it("is deterministic for the same input/deps", async () => {
    const deps = { newId: () => "cs-1", now: () => "2026-06-27T00:00:00.000Z" };
    const a = await ingestSource(input, deps);
    const b = await ingestSource(input, deps);
    expect(a).toEqual(b);
  });

  it("defaults mode to null when omitted and generates a real id without deps", async () => {
    const changeSet = await ingestSource({
      workspaceId: "ws-1",
      sourcePath: "sources/s.md",
      content: "x",
    });
    expect(changeSet.sourceEvent).toMatchObject({ mode: null });
    expect(changeSet.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(changeSet.kind).toBe("ingest");
  });
});
