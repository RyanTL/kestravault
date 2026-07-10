import { describe, expect, it } from "vitest";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";

describe("parseFrontmatter", () => {
  it("splits YAML frontmatter from the body", () => {
    const md = "---\ntitle: Hello\ntags:\n  - a\n  - b\n---\n\nBody text.\n";
    const { data, body } = parseFrontmatter(md);
    expect(data).toEqual({ title: "Hello", tags: ["a", "b"] });
    expect(body).toBe("Body text.\n");
  });

  it("returns the whole input as the body when there is no frontmatter", () => {
    const md = "# Just a heading\n\nNo frontmatter here.\n";
    const { data, body } = parseFrontmatter(md);
    expect(data).toEqual({});
    expect(body).toBe(md);
  });
});

describe("serializeFrontmatter", () => {
  it("round-trips data through serialize then parse", () => {
    const data = { title: "Round trip", tags: ["x", "y"], n: 3 };
    const out = serializeFrontmatter(data, "Some body.");
    const reparsed = parseFrontmatter(out);
    expect(reparsed.data).toEqual(data);
    expect(reparsed.body.trim()).toBe("Some body.");
  });
});
