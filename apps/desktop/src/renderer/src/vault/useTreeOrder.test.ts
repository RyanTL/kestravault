import { describe, expect, it } from "vitest";
import type { VaultNode } from "./types";
import { sortTree } from "./useTreeOrder";

const privacy = {
  mode: "public",
  source: "default",
  inherited: false,
  explicit: false,
} as const;

const tree: VaultNode[] = [
  { kind: "file", name: "Alpha.md", path: "Alpha.md", privacy },
  { kind: "dir", name: "Beta", path: "Beta", privacy, children: [] },
  { kind: "file", name: "Zulu.md", path: "Zulu.md", privacy },
  { kind: "dir", name: "Archive", path: "Archive", privacy, children: [] },
];

describe("file tree sorting", () => {
  it("keeps folders first and sorts names ascending", () => {
    expect(sortTree(tree, {}, "", "name-asc").map((node) => node.name)).toEqual([
      "Archive",
      "Beta",
      "Alpha.md",
      "Zulu.md",
    ]);
  });

  it("keeps folders first and sorts names descending", () => {
    expect(sortTree(tree, {}, "", "name-desc").map((node) => node.name)).toEqual([
      "Beta",
      "Archive",
      "Zulu.md",
      "Alpha.md",
    ]);
  });

  it("respects manual ordering in custom mode", () => {
    expect(
      sortTree(tree, { "": ["Zulu.md", "Archive"] }, "", "custom").map(
        (node) => node.name,
      ),
    ).toEqual(["Zulu.md", "Archive", "Beta", "Alpha.md"]);
  });
});
