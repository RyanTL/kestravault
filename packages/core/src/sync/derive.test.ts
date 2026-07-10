import { describe, expect, it } from "vitest";
import { deriveFileMeta, deriveZone } from "./derive.js";

describe("deriveZone", () => {
  it("maps the top folder to its zone", () => {
    expect(deriveZone("sources/x.md")).toBe("sources");
    expect(deriveZone("wiki/concepts/x.md")).toBe("wiki");
    expect(deriveZone("notes/x.md")).toBe("notes");
  });

  it("treats anything outside the three zones as notes", () => {
    expect(deriveZone("random/x.md")).toBe("notes");
    expect(deriveZone("x.md")).toBe("notes");
  });
});

describe("deriveFileMeta", () => {
  it("defaults type by zone and title from the filename stem", () => {
    expect(deriveFileMeta("sources/paper.md", "")).toEqual({
      zone: "sources",
      type: "source",
      title: "paper",
    });
    expect(deriveFileMeta("wiki/Neural Nets.md", "")).toEqual({
      zone: "wiki",
      type: "concept",
      title: "Neural Nets",
    });
    expect(deriveFileMeta("notes/todo.md", "")).toEqual({
      zone: "notes",
      type: "note",
      title: "todo",
    });
  });

  it("honors a valid frontmatter type and title", () => {
    const md = ["---", "type: overview", "title: The Big Picture", "---", "body"].join("\n");
    expect(deriveFileMeta("wiki/x.md", md)).toEqual({
      zone: "wiki",
      type: "overview",
      title: "The Big Picture",
    });
  });

  it("falls back to the zone default for an unknown type", () => {
    const md = ["---", "type: bogus", "---"].join("\n");
    expect(deriveFileMeta("wiki/x.md", md).type).toBe("concept");
  });

  it("falls back to the filename when the title is blank or non-string", () => {
    expect(deriveFileMeta("notes/kept.md", "---\ntitle:   \n---").title).toBe("kept");
    expect(deriveFileMeta("notes/kept.md", "---\ntitle: 42\n---").title).toBe("kept");
  });

  it("degrades to defaults on malformed frontmatter instead of throwing", () => {
    const bad = "---\ntitle: [unterminated\n---\nbody";
    expect(() => deriveFileMeta("wiki/x.md", bad)).not.toThrow();
    const meta = deriveFileMeta("wiki/x.md", bad);
    expect(meta.zone).toBe("wiki");
    expect(meta.type).toBe("concept");
    expect(meta.title).toBe("x");
  });
});
