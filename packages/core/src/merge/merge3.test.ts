import { describe, expect, it } from "vitest";
import { merge3 } from "./merge3.js";

describe("merge3 — trivial / one-sided", () => {
  it("returns the content unchanged when all three are identical", () => {
    const text = "a\nb\nc\n";
    expect(merge3(text, text, text)).toEqual({ merged: text, clean: true, conflicts: 0 });
  });

  it("takes ours when only ours changed", () => {
    expect(merge3("a\nb\n", "a\nB\n", "a\nb\n")).toEqual({
      merged: "a\nB\n",
      clean: true,
      conflicts: 0,
    });
  });

  it("takes theirs when only theirs changed", () => {
    expect(merge3("a\nb\n", "a\nb\n", "a\nB\n")).toEqual({
      merged: "a\nB\n",
      clean: true,
      conflicts: 0,
    });
  });

  it("takes either side when both made the identical change", () => {
    // ours === theirs short-circuits to a byte-faithful result.
    expect(merge3("a\nb\n", "a\nB\n", "a\nB\n")).toEqual({
      merged: "a\nB\n",
      clean: true,
      conflicts: 0,
    });
  });
});

describe("merge3 — clean (non-conflicting) merges", () => {
  it("combines edits on different lines separated by context", () => {
    const base = "a\nb\nc\nd\ne\n";
    const ours = "a\nB\nc\nd\ne\n"; // b -> B
    const theirs = "a\nb\nc\nD\ne\n"; // d -> D
    expect(merge3(base, ours, theirs)).toEqual({
      merged: "a\nB\nc\nD\ne\n",
      clean: true,
      conflicts: 0,
    });
  });

  it("combines edits on adjacent lines with no separating context", () => {
    // ours changes line 1, theirs changes line 2 — disjoint base lines, so clean.
    expect(merge3("a\nb\n", "A\nb\n", "a\nB\n")).toEqual({
      merged: "A\nB\n",
      clean: true,
      conflicts: 0,
    });
  });

  it("interleaves an insertion from one side with an edit from the other", () => {
    const base = "h1\na\nh2\n";
    const ours = "h1\nNEW\na\nh2\n"; // insert NEW before a
    const theirs = "h1\nA\nh2\n"; // a -> A
    expect(merge3(base, ours, theirs)).toEqual({
      merged: "h1\nNEW\nA\nh2\n",
      clean: true,
      conflicts: 0,
    });
  });

  it("merges an edit on one side with an end-of-file append on the other", () => {
    const base = "a\nb\n";
    const ours = "a\nb\nc\n"; // append c
    const theirs = "A\nb\n"; // a -> A
    expect(merge3(base, ours, theirs)).toEqual({
      merged: "A\nb\nc\n",
      clean: true,
      conflicts: 0,
    });
  });

  it("merges an edit on one side with an end-of-file deletion on the other", () => {
    const base = "a\nb\nc\n";
    const ours = "a\nb\n"; // delete c
    const theirs = "A\nb\nc\n"; // a -> A
    expect(merge3(base, ours, theirs)).toEqual({
      merged: "A\nb\n",
      clean: true,
      conflicts: 0,
    });
  });

  it("does not duplicate an identical append both sides made", () => {
    const base = "a\nm\n";
    const ours = "A\nm\nx\n"; // a -> A, append x
    const theirs = "a\nm\nx\n"; // append x
    expect(merge3(base, ours, theirs)).toEqual({
      merged: "A\nm\nx\n",
      clean: true,
      conflicts: 0,
    });
  });

  it("collapses an identical edit in an overlapping region while taking a one-sided edit elsewhere", () => {
    const base = "a\nb\nM\nc\n";
    const ours = "Z\nM\nc\n"; // a,b -> Z
    const theirs = "Z\nM\nC\n"; // a,b -> Z (same) and c -> C
    expect(merge3(base, ours, theirs)).toEqual({
      merged: "Z\nM\nC\n",
      clean: true,
      conflicts: 0,
    });
  });
});

describe("merge3 — true conflicts", () => {
  it("emits standard markers when both sides change the same line differently", () => {
    const result = merge3("a\nb\nc\n", "a\nX\nc\n", "a\nY\nc\n");
    expect(result.clean).toBe(false);
    expect(result.conflicts).toBe(1);
    expect(result.merged).toBe(
      ["a", "<<<<<<< ours", "X", "=======", "Y", ">>>>>>> theirs", "c", ""].join("\n"),
    );
  });

  it("honors custom conflict labels", () => {
    const result = merge3("a\nb\nc\n", "a\nX\nc\n", "a\nY\nc\n", {
      ourLabel: "local",
      theirLabel: "remote",
    });
    expect(result.merged).toContain("<<<<<<< local");
    expect(result.merged).toContain(">>>>>>> remote");
  });

  it("counts two independent conflicts", () => {
    const base = "a\nb\nc\nd\ne\n";
    const ours = "a\nB1\nc\nD1\ne\n";
    const theirs = "a\nB2\nc\nD2\ne\n";
    const result = merge3(base, ours, theirs);
    expect(result.clean).toBe(false);
    expect(result.conflicts).toBe(2);
    expect(result.merged).toBe(
      [
        "a",
        "<<<<<<< ours",
        "B1",
        "=======",
        "B2",
        ">>>>>>> theirs",
        "c",
        "<<<<<<< ours",
        "D1",
        "=======",
        "D2",
        ">>>>>>> theirs",
        "e",
        "",
      ].join("\n"),
    );
  });

  it("conflicts when a deletion overlaps an edit (one side may be empty)", () => {
    const base = "a\nb\n";
    const ours = ""; // delete everything
    const theirs = "a\nB\n"; // b -> B
    const result = merge3(base, ours, theirs);
    expect(result.clean).toBe(false);
    expect(result.conflicts).toBe(1);
    expect(result.merged).toBe(
      ["<<<<<<< ours", "=======", "a", "B", ">>>>>>> theirs", ""].join("\n"),
    );
  });
});

describe("merge3 — file ends (additions / deletions)", () => {
  it("conflicts when both sides append different lines", () => {
    const result = merge3("a\n", "a\nb\n", "a\nc\n");
    expect(result.conflicts).toBe(1);
    expect(result.merged).toBe(
      ["a", "<<<<<<< ours", "b", "=======", "c", ">>>>>>> theirs", ""].join("\n"),
    );
  });

  it("cleanly merges deletions at the start and additions at the end", () => {
    const base = "x\na\nb\nc\n";
    const ours = "a\nb\nc\n"; // delete leading x
    const theirs = "x\na\nb\nc\nd\n"; // append d
    expect(merge3(base, ours, theirs)).toEqual({
      merged: "a\nb\nc\nd\n",
      clean: true,
      conflicts: 0,
    });
  });
});

describe("merge3 — empty inputs", () => {
  it("merges three empty strings", () => {
    expect(merge3("", "", "")).toEqual({ merged: "", clean: true, conflicts: 0 });
  });

  it("takes the non-empty side when one side leaves base untouched", () => {
    expect(merge3("", "", "x\n")).toEqual({ merged: "x\n", clean: true, conflicts: 0 });
    expect(merge3("", "x\n", "")).toEqual({ merged: "x\n", clean: true, conflicts: 0 });
  });

  it("conflicts when both sides add different content to an empty base", () => {
    const result = merge3("", "x\n", "y\n");
    expect(result.conflicts).toBe(1);
    expect(result.merged).toBe(
      ["<<<<<<< ours", "x", "=======", "y", ">>>>>>> theirs", ""].join("\n"),
    );
  });
});

describe("merge3 — trailing newline handling", () => {
  it("keeps a trailing newline when ours has one", () => {
    const base = "x\ny"; // no trailing newline
    const ours = "x\nY\n"; // y -> Y, add trailing newline
    const theirs = "X\ny"; // x -> X, no trailing newline
    expect(merge3(base, ours, theirs).merged).toBe("X\nY\n");
  });

  it("drops a trailing newline when ours omits it (ours wins the final-newline flag)", () => {
    const base = "a\nb"; // no trailing newline
    const ours = "a\nB"; // b -> B, still no trailing newline
    const theirs = "a\nb\n"; // only adds a trailing newline (no content change)
    expect(merge3(base, ours, theirs).merged).toBe("a\nB");
  });
});

describe("merge3 — CRLF / LF", () => {
  it("preserves CRLF endings through a clean merge", () => {
    const base = "a\r\nb\r\nc\r\n";
    const ours = "a\r\nB\r\nc\r\n"; // b -> B
    const theirs = "a\r\nb\r\nC\r\n"; // c -> C
    expect(merge3(base, ours, theirs)).toEqual({
      merged: "a\r\nB\r\nC\r\n",
      clean: true,
      conflicts: 0,
    });
  });

  it("does not conflict purely because the two sides use different line endings", () => {
    const base = "a\nb\n"; // LF
    const ours = "A\nb\n"; // a -> A, LF
    const theirs = "a\r\nB\r\n"; // b -> B, CRLF
    // Content merges cleanly; output follows ours' (LF) line ending.
    expect(merge3(base, ours, theirs)).toEqual({
      merged: "A\nB\n",
      clean: true,
      conflicts: 0,
    });
  });
});
