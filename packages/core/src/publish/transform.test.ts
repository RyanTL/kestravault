import { describe, expect, it, vi } from "vitest";
import { NotPublishableError, toPublishedView, type PublishTransformDeps } from "./transform.js";

/** A publishable notes-zone document around the given body. */
function noteDoc(body: string, extraFrontmatter = ""): string {
  return [
    "---",
    "id: 01J8ZSECRETULID0000000000",
    'title: "Standup notes"',
    "type: note",
    "zone: notes",
    "tags: [secret-tag]",
    extraFrontmatter,
    "---",
    "",
    body,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

const noAssets: PublishTransformDeps = { resolveAssetUrl: () => null };

describe("toPublishedView — zero graph leak", () => {
  it("flattens a bare wikilink to its display text with no link syntax", () => {
    const view = toPublishedView(noteDoc("See [[Ownership (Rust)]] for details."), noAssets);
    expect(view.markdown).toContain("See Ownership (Rust) for details.");
    expect(view.markdown).not.toContain("[[");
    expect(view.markdown).not.toContain("]]");
  });

  it("renders ONLY the alias of an aliased link — the private title never appears", () => {
    const view = toPublishedView(
      noteDoc("Ask [[Secret Acquisition Target|the partner]] about it."),
      noAssets,
    );
    expect(view.markdown).toContain("Ask the partner about it.");
    expect(view.markdown).not.toContain("Secret Acquisition Target");
  });

  it("drops a private page's #section from an unaliased heading link", () => {
    const view = toPublishedView(noteDoc("See [[Roadmap#Unannounced Products]]."), noAssets);
    expect(view.markdown).toContain("See Roadmap.");
    expect(view.markdown).not.toContain("Unannounced Products");
  });

  it("renders the alias of a heading link without the target or section", () => {
    const view = toPublishedView(
      noteDoc("See [[Roadmap#Unannounced Products|next steps]]."),
      noAssets,
    );
    expect(view.markdown).toContain("See next steps.");
    expect(view.markdown).not.toContain("Roadmap");
    expect(view.markdown).not.toContain("Unannounced Products");
  });

  it("keeps in-note anchors ([[#Heading]]) as the heading text — it is this note's own content", () => {
    const view = toPublishedView(noteDoc("Jump to [[#Action items]]."), noAssets);
    expect(view.markdown).toContain("Jump to Action items.");
  });

  it("emits no href for any wikilink — nothing resolvable remains", () => {
    const view = toPublishedView(
      noteDoc("[[A]], [[B|b]], and [[C#s|c]] walk into a bar."),
      noAssets,
    );
    expect(view.markdown).toBe("A, b, and c walk into a bar.");
  });

  it("flattens relative markdown links to their text (no workspace path survives)", () => {
    const view = toPublishedView(
      noteDoc("Details in [the plan](../wiki/concepts/secret-plan.md)."),
      noAssets,
    );
    expect(view.markdown).toContain("Details in the plan.");
    expect(view.markdown).not.toContain("secret-plan");
  });

  it("keeps absolute external links untouched", () => {
    const body = "Read [the docs](https://example.com/docs) or [mail us](mailto:hi@example.com).";
    const view = toPublishedView(noteDoc(body), noAssets);
    expect(view.markdown).toBe(body);
  });

  it("removes reference-style definitions that point inside the workspace", () => {
    const view = toPublishedView(
      noteDoc("Some prose.\n\n[secret]: notes/private-note.md\n[ok]: https://example.com"),
      noAssets,
    );
    expect(view.markdown).not.toContain("private-note");
    expect(view.markdown).toContain("[ok]: https://example.com");
  });

  it("leaves code fences and inline code untouched", () => {
    const body = [
      "Prose with [[Private Page]] link.",
      "```md",
      "A fenced [[Fenced Target]] stays literal.",
      "```",
      "And `an inline [[Inline Target]] span` too.",
    ].join("\n");
    const view = toPublishedView(noteDoc(body), noAssets);
    expect(view.markdown).toContain("Prose with Private Page link.");
    expect(view.markdown).toContain("A fenced [[Fenced Target]] stays literal.");
    expect(view.markdown).toContain("`an inline [[Inline Target]] span`");
  });
});

describe("toPublishedView — frontmatter", () => {
  it("strips the frontmatter: id, tags, and zone never reach the output", () => {
    const view = toPublishedView(noteDoc("Hello world."), noAssets);
    expect(view.markdown).toBe("Hello world.");
    expect(view.markdown).not.toContain("01J8ZSECRETULID");
    expect(view.markdown).not.toContain("secret-tag");
    expect(view.markdown).not.toContain("zone:");
  });

  it("uses the frontmatter title as the page title", () => {
    const view = toPublishedView(noteDoc("Body."), noAssets);
    expect(view.title).toBe("Standup notes");
  });

  it("falls back to the first heading, then to 'Untitled'", () => {
    const withHeading = ["---", "zone: notes", "---", "", "# From Heading", "text"].join("\n");
    expect(toPublishedView(withHeading, noAssets).title).toBe("From Heading");
    const bare = ["---", "zone: notes", "---", "", "just text"].join("\n");
    expect(toPublishedView(bare, noAssets).title).toBe("Untitled");
  });
});

describe("toPublishedView — zone restriction", () => {
  it.each(["wiki", "sources"])("refuses a %s-zone document", (zone) => {
    const doc = ["---", `zone: ${zone}`, "title: Nope", "---", "", "body"].join("\n");
    expect(() => toPublishedView(doc, noAssets)).toThrow(NotPublishableError);
  });

  it("refuses a document that cannot prove zone: notes (conservative default)", () => {
    expect(() => toPublishedView("no frontmatter at all", noAssets)).toThrow(NotPublishableError);
  });
});

describe("toPublishedView — assets", () => {
  const minter: PublishTransformDeps = {
    resolveAssetUrl: (ref) =>
      ref === "assets/diagram.png" || ref === "assets/photo.jpg"
        ? `https://public.example/minted/${ref.split("/").pop()}`
        : null,
  };

  it("rewrites embeds to the injected public URL", () => {
    const view = toPublishedView(noteDoc("Look: ![[assets/diagram.png]]"), minter);
    expect(view.markdown).toContain("![diagram.png](https://public.example/minted/diagram.png)");
    expect(view.assets).toEqual([
      { ref: "assets/diagram.png", url: "https://public.example/minted/diagram.png" },
    ]);
  });

  it("rewrites relative markdown images and keeps the author's alt text", () => {
    const view = toPublishedView(noteDoc("![my sketch](assets/photo.jpg)"), minter);
    expect(view.markdown).toContain("![my sketch](https://public.example/minted/photo.jpg)");
  });

  it("keeps external images untouched and does not report them as assets", () => {
    const body = "![ext](https://elsewhere.example/pic.png)";
    const view = toPublishedView(noteDoc(body), minter);
    expect(view.markdown).toBe(body);
    expect(view.assets).toEqual([]);
  });

  it("drops unresolvable embeds entirely — the workspace path never leaks", () => {
    const view = toPublishedView(noteDoc("Before ![[assets/not-mine.png]] after."), minter);
    expect(view.markdown).toBe("Before  after.");
    expect(view.markdown).not.toContain("not-mine");
  });

  it("drops a note transclusion (![[Other Note]]) without leaking its content or title as a link", () => {
    const view = toPublishedView(noteDoc("Context: ![[Private Meeting Note]] end."), minter);
    expect(view.markdown).toBe("Context:  end.");
    expect(view.markdown).not.toContain("Private Meeting Note");
  });

  it("collapses an unresolvable relative image to its alt text only", () => {
    const view = toPublishedView(noteDoc("See ![chart](assets/unknown.png) here."), minter);
    expect(view.markdown).toBe("See chart here.");
    expect(view.markdown).not.toContain("unknown.png");
  });

  it("only consults the minter for refs the note actually contains, deduped", () => {
    const resolveAssetUrl = vi.fn((ref: string) => `https://public.example/${ref}`);
    const view = toPublishedView(
      noteDoc("![[assets/a.png]] and again ![[assets/a.png]] and ![b](assets/b.png)"),
      { resolveAssetUrl },
    );
    expect(resolveAssetUrl).toHaveBeenCalledTimes(2);
    expect(resolveAssetUrl.mock.calls.map(([ref]) => ref)).toEqual([
      "assets/a.png",
      "assets/b.png",
    ]);
    expect(view.assets).toHaveLength(2);
  });

  it("uses the embed alias as alt text but ignores Obsidian size aliases", () => {
    const view = toPublishedView(
      noteDoc("![[assets/diagram.png|the flow]] and ![[assets/photo.jpg|300]]"),
      minter,
    );
    expect(view.markdown).toContain("![the flow](https://public.example/minted/diagram.png)");
    expect(view.markdown).toContain("![photo.jpg](https://public.example/minted/photo.jpg)");
  });
});

describe("toPublishedView — determinism", () => {
  it("returns byte-identical output for the same input and deps", () => {
    const doc = noteDoc(
      "[[A|b]] text ![[assets/diagram.png]] more [c](../d.md) and [e](https://f.example).",
    );
    const deps: PublishTransformDeps = {
      resolveAssetUrl: (ref) => `https://public.example/${ref}`,
    };
    const first = toPublishedView(doc, deps);
    const second = toPublishedView(doc, deps);
    expect(second).toEqual(first);
  });
});
