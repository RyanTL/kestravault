import { afterEach, describe, expect, it } from "vitest";
import { buildGraph } from "@renderer/vault/graph";

function stubVault(byPath: Record<string, string>): void {
  (globalThis as { window?: unknown }).window = {
    api: { vault: { read: async (path: string) => byPath[path] ?? "" } },
  };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

const note = (path: string): { name: string; path: string } => ({
  name: path.replace(/\.md$/, ""),
  path,
});

describe("buildGraph", () => {
  it("links notes via wikilinks, collapsing mutual links to one edge", async () => {
    stubVault({
      "a.md": "I point to [[b]].",
      "b.md": "And I point back to [[a]].",
      "c.md": "I am an orphan.",
    });
    const g = await buildGraph([note("a.md"), note("b.md"), note("c.md")]);

    expect(g.edges).toHaveLength(1);
    expect(g.neighbors.get("a.md")).toEqual(new Set(["b.md"]));
    expect(g.neighbors.get("b.md")).toEqual(new Set(["a.md"]));
    expect(g.neighbors.get("c.md")).toEqual(new Set());
    expect(g.nodes.find((n) => n.id === "a.md")?.degree).toBe(1);
    expect(g.nodes.find((n) => n.id === "c.md")?.degree).toBe(0);
  });

  it("drops self-links and dedupes repeated links to the same target", async () => {
    stubVault({
      "a.md": "[[a]] linking to myself, and [[b]] twice: [[b]].",
      "b.md": "nothing here",
    });
    const g = await buildGraph([note("a.md"), note("b.md")]);
    expect(g.edges).toHaveLength(1);
    expect(g.nodes.find((n) => n.id === "a.md")?.degree).toBe(1);
  });

  it("ignores links to nonexistent notes", async () => {
    stubVault({ "a.md": "[[ghost]]" });
    const g = await buildGraph([note("a.md")]);
    expect(g.edges).toEqual([]);
    expect(g.nodes[0]?.degree).toBe(0);
  });
});
