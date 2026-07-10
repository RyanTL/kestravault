import { describe, expect, it } from "vitest";
import {
  isPrivate,
  isPrivateNote,
  noteDescription,
  noteTags,
} from "@renderer/vault/notePrivacy";

describe("isPrivate", () => {
  it("is true only for the exact boolean true", () => {
    expect(isPrivate({ private: true })).toBe(true);
    expect(isPrivate({ private: "true" })).toBe(false);
    expect(isPrivate({ private: 1 })).toBe(false);
    expect(isPrivate({})).toBe(false);
  });

  it("tolerates non-object data (arrays, null, primitives)", () => {
    expect(isPrivate(null)).toBe(false);
    expect(isPrivate([1, 2])).toBe(false);
    expect(isPrivate("nope")).toBe(false);
  });
});

describe("isPrivateNote", () => {
  it("reads the flag from raw markdown frontmatter", () => {
    expect(isPrivateNote("---\nprivate: true\n---\nbody")).toBe(true);
    expect(isPrivateNote("no frontmatter here")).toBe(false);
  });
});

describe("noteDescription", () => {
  it("returns a trimmed string description or empty", () => {
    expect(noteDescription({ description: "  hello  " })).toBe("hello");
    expect(noteDescription({ description: 42 })).toBe("");
    expect(noteDescription(null)).toBe("");
  });
});

describe("noteTags", () => {
  it("coerces a tag array to strings", () => {
    expect(noteTags({ tags: ["a", 2, true] })).toEqual(["a", "2", "true"]);
  });

  it("returns an empty array when tags are missing or not an array", () => {
    expect(noteTags({ tags: "a,b" })).toEqual([]);
    expect(noteTags({})).toEqual([]);
    expect(noteTags(null)).toEqual([]);
  });
});
