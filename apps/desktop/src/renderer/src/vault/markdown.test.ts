import { describe, expect, it } from "vitest";
import { extractWikiLinks, stripFrontmatter } from "@renderer/vault/markdown";

describe("stripFrontmatter", () => {
  it("removes a leading YAML block and returns the body", () => {
    const md = ["---", "title: X", "---", "body line"].join("\n");
    expect(stripFrontmatter(md)).toBe("body line");
  });

  it("leaves text without frontmatter untouched", () => {
    expect(stripFrontmatter("just body")).toBe("just body");
  });

  it("returns the input when the block is never closed", () => {
    const md = "---\ntitle: X\nno close";
    expect(stripFrontmatter(md)).toBe(md);
  });
});

describe("extractWikiLinks", () => {
  it("finds bare and aliased links, ignoring frontmatter", () => {
    const md = [
      "---",
      "title: [[NotALink]]",
      "---",
      "See [[Alpha]] and [[Beta|the beta]].",
    ].join("\n");
    expect(extractWikiLinks(md)).toEqual([
      { target: "Alpha", alias: "Alpha" },
      { target: "Beta", alias: "the beta" },
    ]);
  });

  it("trims whitespace inside targets and aliases", () => {
    expect(extractWikiLinks("[[ Spaced Note | Nice Alias ]]")).toEqual([
      { target: "Spaced Note", alias: "Nice Alias" },
    ]);
  });

  it("returns an empty list when there are no links", () => {
    expect(extractWikiLinks("plain text")).toEqual([]);
  });
});
