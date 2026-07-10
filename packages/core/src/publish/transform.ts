import { parseFrontmatter } from "../utils/frontmatter.js";

/**
 * Note publishing — the pure "published view" transform (Feature B,
 * plan/sync-collab-open-core.md §3). Takes a notes-zone markdown document and
 * produces what an anonymous reader is allowed to see. No DOM, no network, no
 * clock — deterministic given the input and the injected asset-URL minter.
 *
 * The load-bearing rule is ZERO GRAPH LEAK: publishing one note must never
 * expose the titles/existence/contents of anything it links to. Concretely:
 *   - `[[wikilinks]]` are flattened to plain display text — no href, no
 *     resolution. `[[title|alias]]` renders only the alias; `[[page#Section]]`
 *     renders only `page` (the section heading is the private page's internal
 *     structure, so it is dropped — conservative choice).
 *   - embeds (`![[img.png]]`) and relative markdown images resolve through the
 *     injected minter to per-asset public URLs; anything the minter does not
 *     recognize is dropped entirely — a workspace path never reaches the output.
 *   - relative markdown links (`[text](../wiki/page.md)`) flatten to their text;
 *     only absolute external links (http/https/mailto) are kept.
 *   - frontmatter is stripped — ids, tags, and dates stay private; only the
 *     title survives, as the page title.
 * Code fences and inline code spans are left untouched (they are literal text
 * the author wrote into this note, not resolved links).
 */

/** Thrown when the input is not a publishable notes-zone document. */
export class NotPublishableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotPublishableError";
  }
}

export interface PublishTransformDeps {
  /**
   * Mint a public URL for an asset reference as written in the note (e.g.
   * `assets/diagram.png`). Return `null` when the ref is not a known asset of
   * this workspace — the reference is then dropped from the published view.
   * Injected so the transform stays pure; the real minter (Supabase Storage
   * signed/public paths) lives with the backend.
   */
  resolveAssetUrl(ref: string): string | null;
}

/** An asset actually referenced by the note, with its minted public URL. */
export interface PublishedAsset {
  /** The reference exactly as written in the note. */
  ref: string;
  /** The public URL it was rewritten to. */
  url: string;
}

/** What an anonymous reader gets: title + flattened markdown + minted assets. */
export interface PublishedView {
  title: string;
  /** Frontmatter-free markdown with wikilinks flattened and assets rewritten. */
  markdown: string;
  /**
   * Only the assets actually referenced by the note (deduped, in order of first
   * appearance). Nothing else in the workspace is ever exposed.
   */
  assets: PublishedAsset[];
}

const EXTERNAL_URL = /^(https?:\/\/|mailto:)/i;

// Obsidian-style syntax. Inner text of [[...]] cannot contain brackets; markdown
// image/link URLs stop at whitespace or a closing paren (optional "title" part).
const EMBED = /!\[\[([^\][]+)\]\]/g;
const WIKILINK = /\[\[([^\][]+)\]\]/g;
const MD_IMAGE = /!\[([^\]]*)\]\(\s*([^()\s]+)(?:\s+"[^"]*")?\s*\)/g;
const MD_LINK = /(?<!!)\[([^\]]*)\]\(\s*([^()\s]+)(?:\s+"[^"]*")?\s*\)/g;
// Reference-style link definition, e.g. `[label]: notes/private.md "title"`.
const REF_DEFINITION = /^ {0,3}\[([^\]]+)\]:\s+(\S+).*$/gm;

/** Memoizing wrapper around the injected minter that records what it exposed. */
class AssetLedger {
  private readonly seen = new Map<string, string | null>();
  readonly assets: PublishedAsset[] = [];

  constructor(private readonly deps: PublishTransformDeps) {}

  resolve(ref: string): string | null {
    if (this.seen.has(ref)) return this.seen.get(ref) ?? null;
    const url = this.deps.resolveAssetUrl(ref);
    this.seen.set(ref, url);
    if (url !== null) this.assets.push({ ref, url });
    return url;
  }
}

/**
 * The display text a wikilink flattens to. Alias wins; otherwise the target
 * title with any `#heading` / `#^block` fragment dropped (a private page's
 * section names are its internal structure). A pure in-note anchor
 * (`[[#Heading]]`) keeps the heading text — it is this note's own, already
 * public, content.
 */
function wikilinkDisplayText(inner: string): string {
  const pipe = inner.indexOf("|");
  if (pipe >= 0) {
    const alias = inner.slice(pipe + 1).trim();
    if (alias) return alias;
  }
  const target = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
  const hash = target.indexOf("#");
  if (hash === 0) return target.slice(1).replace(/^\^/, "").trim();
  if (hash > 0) return target.slice(0, hash).trim();
  return target;
}

function basename(ref: string): string {
  return ref.split("/").pop() ?? ref;
}

/** Transform one run of plain prose (no code fences / code spans inside). */
function transformProse(text: string, ledger: AssetLedger): string {
  let out = text;

  // Embeds first (they start with `![[`, a superset of the wikilink syntax).
  // A resolvable asset becomes a standard image pointing at its minted URL; an
  // unresolvable embed (unknown asset, or a note transclusion — which would
  // inline private content) is dropped entirely so no path or content leaks.
  out = out.replace(EMBED, (_match, inner: string) => {
    const pipe = inner.indexOf("|");
    const ref = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
    const url = ledger.resolve(ref);
    if (url === null) return "";
    const alias = pipe >= 0 ? inner.slice(pipe + 1).trim() : "";
    // Obsidian uses the alias slot for sizes too (`|300` / `|300x200`); those
    // are not alt text.
    const alt = alias && !/^\d+(x\d+)?$/.test(alias) ? alias : basename(ref);
    return `![${alt}](${url})`;
  });

  // Wikilinks flatten to plain display text — no href, no resolution.
  out = out.replace(WIKILINK, (_match, inner: string) => wikilinkDisplayText(inner));

  // Markdown images: external URLs pass through untouched; workspace-relative
  // paths mint through the ledger; unknown refs collapse to the (author-written,
  // safe) alt text so the path never appears in the output.
  out = out.replace(MD_IMAGE, (match, alt: string, src: string) => {
    if (EXTERNAL_URL.test(src)) return match;
    const url = ledger.resolve(src);
    return url === null ? alt : `![${alt}](${url})`;
  });

  // Markdown links: keep absolute external links; flatten everything else
  // (relative paths, in-workspace files, anchors) to their display text.
  out = out.replace(MD_LINK, (match, text: string, href: string) =>
    EXTERNAL_URL.test(href) ? match : text,
  );

  return out;
}

/** Apply `transform` to the parts of `text` outside inline code spans. */
function outsideCodeSpans(text: string, transform: (chunk: string) => string): string {
  const span = /(`+)[\s\S]*?\1/g;
  let out = "";
  let last = 0;
  for (let match = span.exec(text); match !== null; match = span.exec(text)) {
    out += transform(text.slice(last, match.index)) + match[0];
    last = match.index + match[0].length;
  }
  return out + transform(text.slice(last));
}

interface BodySegment {
  lines: string[];
  code: boolean;
}

/** Split the body into fenced-code segments and prose segments, line-wise. */
function splitFencedSegments(body: string): BodySegment[] {
  const segments: BodySegment[] = [];
  let buffer: string[] = [];
  let inFence = false;
  let fence = "";

  const flush = (code: boolean) => {
    if (buffer.length > 0) {
      segments.push({ lines: buffer, code });
      buffer = [];
    }
  };

  for (const line of body.split("\n")) {
    const opener = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (!inFence && opener) {
      flush(false);
      inFence = true;
      fence = opener[1] ?? "";
      buffer.push(line);
    } else if (inFence) {
      buffer.push(line);
      const closer = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (closer && closer[1] && closer[1][0] === fence[0] && closer[1].length >= fence.length) {
        inFence = false;
        flush(true);
      }
    } else {
      buffer.push(line);
    }
  }
  // An unterminated fence stays protected (treated as code to the end).
  flush(inFence);
  return segments;
}

function firstHeading(body: string): string | null {
  const match = /^#{1,6}\s+(.+?)\s*$/m.exec(body);
  return match?.[1] ?? null;
}

/**
 * Build the public read-only view of a notes-zone markdown document.
 *
 * Input is the full document (frontmatter + body) as stored canonically. Throws
 * {@link NotPublishableError} unless the frontmatter proves `zone: notes` —
 * wiki/ and sources/ files are never publishable, and a document that cannot
 * prove its zone is rejected rather than trusted (conservative default; the
 * caller can pre-check `FileRecord.zone` for friendlier errors).
 *
 * Pure and deterministic: same document + same deps → same view. The injected
 * `resolveAssetUrl` is invoked at most once per distinct referenced asset, so
 * the returned `assets` list is exactly what the note exposes — never more.
 */
export function toPublishedView(document: string, deps: PublishTransformDeps): PublishedView {
  const { data, body } = parseFrontmatter<Record<string, unknown>>(document);

  if (data.zone !== "notes") {
    throw new NotPublishableError(
      "only notes/ files are publishable; refusing a document whose frontmatter " +
        `does not declare zone: notes (got ${JSON.stringify(data.zone ?? null)})`,
    );
  }

  const ledger = new AssetLedger(deps);
  const markdown = splitFencedSegments(body)
    .map((segment) => {
      const text = segment.lines.join("\n");
      if (segment.code) return text;
      // Drop reference-style link definitions pointing inside the workspace
      // before the prose pass, so `[label]: notes/private.md` never survives.
      const withoutInternalRefs = text.replace(
        REF_DEFINITION,
        (match, _label: string, url: string) => (EXTERNAL_URL.test(url) ? match : ""),
      );
      return outsideCodeSpans(withoutInternalRefs, (chunk) => transformProse(chunk, ledger));
    })
    .join("\n");

  const title =
    typeof data.title === "string" && data.title.trim()
      ? data.title.trim()
      : (firstHeading(body) ?? "Untitled");

  return { title, markdown, assets: ledger.assets };
}
