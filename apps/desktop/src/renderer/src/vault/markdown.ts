// Markdown helpers shared by the renderer. The Reading view was replaced by an
// in-editor Live Preview (see vault/livePreview.ts), so this no longer renders
// HTML — it just parses frontmatter and extracts wikilinks for backlinks/search.

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

/** A `[[target]]` or `[[target|alias]]` reference found in note text. */
export interface WikiLink {
  target: string;
  alias: string;
}

function splitTargetAlias(inner: string): WikiLink {
  const pipe = inner.indexOf("|");
  if (pipe === -1) {
    const t = inner.trim();
    return { target: t, alias: t };
  }
  return { target: inner.slice(0, pipe).trim(), alias: inner.slice(pipe + 1).trim() };
}

/** Strip a leading YAML frontmatter block, returning the body. */
export function stripFrontmatter(md: string): string {
  if (!md.startsWith("---")) return md;
  const end = md.indexOf("\n---", 3);
  if (end === -1) return md;
  const after = md.indexOf("\n", end + 1);
  return after === -1 ? "" : md.slice(after + 1);
}

/** All wikilinks in a document (frontmatter excluded). */
export function extractWikiLinks(md: string): WikiLink[] {
  const body = stripFrontmatter(md);
  const out: WikiLink[] = [];
  for (const m of body.matchAll(WIKILINK_RE)) {
    out.push(splitTargetAlias(m[1] ?? ""));
  }
  return out;
}
