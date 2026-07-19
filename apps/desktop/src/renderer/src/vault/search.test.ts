import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rankNotes, retrieveNotesForContext, searchLines } from "@renderer/vault/search";

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
): {
  name: string;
  path: string;
  privacy: { mode: typeof mode; source: "local"; explicit: true; inherited: false };
} => ({
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
    const remote = await rankNotes(
      [privateNote("vault.md", "cloud-ai-private")],
      "vault",
      6,
      false,
    );
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

describe("retrieveNotesForContext", () => {
  it("uses one supplied fresh snapshot without issuing per-file reads", async () => {
    let reads = 0;
    (globalThis as { window?: unknown }).window = {
      api: {
        vault: {
          read: async () => {
            reads++;
            return "stale";
          },
        },
      },
    };
    const snapshot = new Map([
      ["index.md", "# Index\n- [[pricing]]"],
      ["pricing.md", "# Pricing\nFresh snapshot pricing details"],
    ]);

    const { matches } = await retrieveNotesForContext(
      [note("index.md"), note("pricing.md")],
      "pricing",
      { snapshot },
    );

    expect(reads).toBe(0);
    expect(matches.find((match) => match.path === "pricing.md")?.snippet).toContain(
      "Fresh snapshot",
    );
  });

  it("caps retrieval at six notes, 5,000 per note, and 20,000 total", async () => {
    const files = Array.from({ length: 8 }, (_, i) => note(`topic-${i}.md`));
    const snapshot = new Map(files.map((file) => [file.path, `topic ${"x".repeat(7_000)}`]));
    const { matches } = await retrieveNotesForContext(files, "topic", { snapshot });
    expect(matches.length).toBeLessThanOrEqual(6);
    expect(matches.every((match) => match.snippet.length <= 5_000)).toBe(true);
    expect(matches.reduce((sum, match) => sum + match.snippet.length, 0)).toBeLessThanOrEqual(
      20_000,
    );
  });

  it("always includes the index, expands matching index links, and follows one hop", async () => {
    stubVault({
      "index.md": "# Index\n- [[pricing]] — packaging and revenue\n- [[hiring]] — team plan",
      "pricing.md": "# Pricing\nOur current packaging decision. See [[customer-calls]].",
      "customer-calls.md":
        "# Customer calls\nCustomers prefer the annual plan because procurement is easier.",
      "hiring.md": "# Hiring\nUnrelated staffing notes.",
    });
    const files = [
      note("index.md"),
      note("pricing.md"),
      note("customer-calls.md"),
      note("hiring.md"),
    ];
    const { matches } = await retrieveNotesForContext(
      files,
      "What do customers say about pricing?",
    );
    expect(matches.map((match) => match.path)).toEqual([
      "index.md",
      "pricing.md",
      "customer-calls.md",
    ]);
    expect(matches.find((match) => match.path === "customer-calls.md")?.snippet).toContain(
      "procurement is easier",
    );
  });

  it("keeps private and local-only bodies out of remote context", async () => {
    stubVault({
      "index.md": "# Index\n- [[passwords]]\n- [[offline]]",
      "passwords.md": "Secret password body links to [[bank-account]]",
      "offline.md": "Never upload this",
      "bank-account.md": "Public bank details that were only linked from the private note",
    });
    const files = [
      note("index.md"),
      privateNote("passwords.md", "cloud-ai-private"),
      privateNote("offline.md", "local-only"),
      note("bank-account.md"),
    ];
    const { matches } = await retrieveNotesForContext(files, "passwords offline", {
      aiIsLocal: false,
    });
    expect(matches.find((match) => match.path === "passwords.md")?.snippet).toBe("");
    expect(matches.some((match) => match.path === "offline.md")).toBe(false);
    expect(matches.some((match) => match.path === "bank-account.md")).toBe(false);
  });
});
