import { describe, expect, it } from "vitest";
import { baseName, dirName, flattenFiles, noteName, resolveWikiLink } from "@renderer/vault/paths";
import type { VaultNode } from "@renderer/vault/types";

const PUBLIC_PRIVACY = {
  mode: "public" as const,
  source: "default" as const,
  explicit: false,
  inherited: false,
};

describe("baseName / dirName", () => {
  it("splits a nested path", () => {
    expect(baseName("wiki/concepts/x.md")).toBe("x.md");
    expect(dirName("wiki/concepts/x.md")).toBe("wiki/concepts");
  });

  it("handles a top-level path (no directory)", () => {
    expect(baseName("x.md")).toBe("x.md");
    expect(dirName("x.md")).toBe("");
  });
});

describe("noteName", () => {
  it("strips the .md extension case-insensitively", () => {
    expect(noteName("notes/Ideas.md")).toBe("Ideas");
    expect(noteName("notes/Ideas.MD")).toBe("Ideas");
  });

  it("leaves non-markdown names intact", () => {
    expect(noteName("assets/pic.png")).toBe("pic.png");
  });
});

describe("flattenFiles", () => {
  it("walks folders depth-first, emitting only files", () => {
    const tree: VaultNode[] = [
      {
        kind: "dir",
        name: "wiki",
        path: "wiki",
        privacy: PUBLIC_PRIVACY,
        children: [{ kind: "file", name: "a", path: "wiki/a.md", privacy: PUBLIC_PRIVACY }],
      },
      { kind: "file", name: "b", path: "b.md", privacy: PUBLIC_PRIVACY },
    ];
    expect(flattenFiles(tree)).toEqual([
      { name: "a", path: "wiki/a.md", privacy: PUBLIC_PRIVACY, private: undefined },
      { name: "b", path: "b.md", privacy: PUBLIC_PRIVACY, private: undefined },
    ]);
  });
});

describe("resolveWikiLink", () => {
  const files = [
    { name: "Alpha", path: "wiki/Alpha.md" },
    { name: "Beta", path: "notes/Beta.md" },
  ];

  it("resolves a bare note name case-insensitively", () => {
    expect(resolveWikiLink("alpha", files)).toBe("wiki/Alpha.md");
  });

  it("resolves an exact relative path", () => {
    expect(resolveWikiLink("notes/Beta", files)).toBe("notes/Beta.md");
  });

  it("tolerates an explicit .md in the target", () => {
    expect(resolveWikiLink("Alpha.md", files)).toBe("wiki/Alpha.md");
  });

  it("returns null when nothing matches", () => {
    expect(resolveWikiLink("Gamma", files)).toBeNull();
  });

  it("prefers an exact path over a same-named note elsewhere", () => {
    const dupes = [
      { name: "Note", path: "a/Note.md" },
      { name: "Note", path: "b/Note.md" },
    ];
    expect(resolveWikiLink("b/Note", dupes)).toBe("b/Note.md");
  });
});
