import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rankNotes, searchLines } from "@renderer/vault/search";

// rankNotes / searchLines read note bodies through window.api.vault.read.
// These tests run in plain Node, so stub that bridge with an in-memory vault.
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

const privateNote = (
  path: string,
  mode: "public" | "cloud-ai-private" | "local-only",
): { name: string; path: string; privacy: { mode: typeof mode; source: "local"; explicit: true; inherited: false } } => ({
  ...note(path),
  privacy: { mode, source: "local", explicit: true, inherited: false },
});

describe("rankNotes", () => {
  it("matches words with diacritics (regression: tokenizer dropped them)", async () => {
    stubVault({
      "trip.md": "Notes from our trip to Zürich last spring.",
      "other.md": "Unrelated grocery list.",
    });
    const matches = await rankNotes([note("trip.md"), note("other.md")], "Zürich");
    expect(matches.map((m) => m.path)).toEqual(["trip.md"]);
  });

  it("matches non-Latin scripts", async () => {
    stubVault({ "ru.md": "Заметки о Москве и погоде." });
    const matches = await rankNotes([note("ru.md")], "Москве");
    expect(matches.map((m) => m.path)).toEqual(["ru.md"]);
  });

  it("still ranks plain ASCII, weighting title matches", async () => {
    stubVault({
      "budget.md": "Monthly budget planning and expenses.",
      "misc.md": "A budget appears once here in the body.",
    });
    const matches = await rankNotes([note("misc.md"), note("budget.md")], "budget");
    // The title match on budget.md outweighs the single body hit in misc.md.
    expect(matches[0]?.path).toBe("budget.md");
  });

  it("returns nothing for queries with no term of length >= 3", async () => {
    stubVault({ "a.md": "content" });
    expect(await rankNotes([note("a.md")], "a of")).toEqual([]);
  });

  it("hides the body of a Private note from a remote provider", async () => {
    // The name is derived from the path, so it must carry the query term for
    // the note to rank at all once the body is hidden.
    const body = ["---", "private: true", "---", "my seed phrase is horse"].join("\n");
    stubVault({ "vault.md": body });
    const remote = await rankNotes([note("vault.md")], "vault", 6, false);
    expect(remote[0]?.private).toBe(true);
    expect(remote[0]?.snippet).toBe("");
    // A local provider (nothing leaves the device) may see the body.
    stubVault({ "vault.md": body });
    const local = await rankNotes([note("vault.md")], "vault", 6, true);
    expect(local[0]?.private).toBe(false);
  });

  it("uses path privacy to hide cloud-private bodies even without frontmatter", async () => {
    stubVault({ "vault.md": "my seed phrase is horse" });
    const remote = await rankNotes([privateNote("vault.md", "cloud-ai-private")], "vault", 6, false);
    expect(remote[0]?.private).toBe(true);
    expect(remote[0]?.snippet).toBe("");
  });

  it("omits local-only notes from remote AI ranking", async () => {
    stubVault({ "vault.md": "vault secret" });
    expect(await rankNotes([privateNote("vault.md", "local-only")], "vault", 6, false)).toEqual([]);
    const local = await rankNotes([privateNote("vault.md", "local-only")], "vault", 6, true);
    expect(local[0]?.path).toBe("vault.md");
  });
});

describe("searchLines", () => {
  beforeEach(() => {
    stubVault({
      "a.md": "first line\nsecond MATCH line\nthird line",
      "b.md": "another match here",
    });
  });

  it("finds every line containing the query, case-insensitively", async () => {
    const hits = await searchLines([note("a.md"), note("b.md")], "match");
    expect(hits).toEqual([
      { path: "a.md", line: 2, text: "second MATCH line" },
      { path: "b.md", line: 1, text: "another match here" },
    ]);
  });

  it("ignores queries shorter than two characters", async () => {
    expect(await searchLines([note("a.md")], "m")).toEqual([]);
  });

  it("respects the hit cap", async () => {
    stubVault({ "big.md": Array.from({ length: 10 }, () => "match").join("\n") });
    expect(await searchLines([note("big.md")], "match", 3)).toHaveLength(3);
  });
});
