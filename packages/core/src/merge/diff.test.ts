import { describe, expect, it } from "vitest";
import { diffLines, lcsLines } from "./diff.js";

describe("lcsLines", () => {
  it("matches every line when both sides are identical", () => {
    expect(lcsLines(["a", "b", "c"], ["a", "b", "c"])).toEqual([
      { baseIndex: 0, sideIndex: 0 },
      { baseIndex: 1, sideIndex: 1 },
      { baseIndex: 2, sideIndex: 2 },
    ]);
  });

  it("returns no matches when nothing is common", () => {
    expect(lcsLines(["a", "b"], ["x", "y"])).toEqual([]);
  });

  it("matches across an inserted line", () => {
    // base a,b ; side a,INS,b -> a and b still match.
    expect(lcsLines(["a", "b"], ["a", "INS", "b"])).toEqual([
      { baseIndex: 0, sideIndex: 0 },
      { baseIndex: 1, sideIndex: 2 },
    ]);
  });

  it("keeps prefix and suffix anchors around a changed middle", () => {
    expect(lcsLines(["a", "b", "c"], ["a", "B", "c"])).toEqual([
      { baseIndex: 0, sideIndex: 0 },
      { baseIndex: 2, sideIndex: 2 },
    ]);
  });

  it("handles empty inputs", () => {
    expect(lcsLines([], [])).toEqual([]);
    expect(lcsLines([], ["a"])).toEqual([]);
    expect(lcsLines(["a"], [])).toEqual([]);
  });
});

describe("diffLines", () => {
  it("produces no hunks for identical inputs", () => {
    expect(diffLines(["a", "b"], ["a", "b"])).toEqual([]);
  });

  it("describes a single-line replacement", () => {
    expect(diffLines(["a", "b", "c"], ["a", "B", "c"])).toEqual([
      { baseStart: 1, baseEnd: 2, sideStart: 1, sideEnd: 2 },
    ]);
  });

  it("describes a pure insertion as a zero-width base range", () => {
    expect(diffLines(["a", "b"], ["a", "INS", "b"])).toEqual([
      { baseStart: 1, baseEnd: 1, sideStart: 1, sideEnd: 2 },
    ]);
  });

  it("describes a pure deletion as a zero-width side range", () => {
    expect(diffLines(["a", "b", "c"], ["a", "c"])).toEqual([
      { baseStart: 1, baseEnd: 2, sideStart: 1, sideEnd: 1 },
    ]);
  });

  it("describes an append at the end of the file", () => {
    expect(diffLines(["a"], ["a", "b"])).toEqual([
      { baseStart: 1, baseEnd: 1, sideStart: 1, sideEnd: 2 },
    ]);
  });

  it("treats a full replacement from empty base as one hunk", () => {
    expect(diffLines([], ["a", "b"])).toEqual([
      { baseStart: 0, baseEnd: 0, sideStart: 0, sideEnd: 2 },
    ]);
  });

  it("reports two separate hunks for two disjoint edits", () => {
    expect(diffLines(["a", "b", "c", "d", "e"], ["A", "b", "c", "D", "e"])).toEqual([
      { baseStart: 0, baseEnd: 1, sideStart: 0, sideEnd: 1 },
      { baseStart: 3, baseEnd: 4, sideStart: 3, sideEnd: 4 },
    ]);
  });
});
