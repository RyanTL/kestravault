import { parseFrontmatter } from "@kestravault/core";
import { remoteAiAccessForPrivacy, type EffectivePrivacy } from "@kestravault/core";
import { isPrivate, noteDescription, noteTags } from "@renderer/vault/notePrivacy";
import { extractWikiLinks } from "@renderer/vault/markdown";
import { noteName, resolveWikiLink } from "@renderer/vault/paths";

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

export interface NoteMatch {
  path: string;
  name: string;
  /** Best matching lines, joined — used as AI context and as a preview. Empty when private. */
  snippet: string;
  score: number;
  /** Body is hidden from the AI: the note is Private and the provider is remote. */
  private?: boolean;
  /** Short frontmatter description — shown to the AI even when the body is hidden. */
  description?: string;
  privacy?: EffectivePrivacy;
}

const CONTEXT_NOTE_LIMIT = 6;
const CONTEXT_CHAR_BUDGET = 20_000;
const PER_NOTE_CHAR_LIMIT = 5_000;

export type VaultContentSnapshot = ReadonlyMap<string, string>;

const QUERY_STOP_WORDS = new Set([
  "about",
  "and",
  "are",
  "can",
  "could",
  "did",
  "does",
  "for",
  "from",
  "have",
  "how",
  "into",
  "its",
  "not",
  "should",
  "that",
  "the",
  "this",
  "was",
  "what",
  "when",
  "where",
  "which",
  "with",
  "would",
]);

function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length >= 3 && !QUERY_STOP_WORDS.has(term));
}

async function readSafe(path: string, snapshot?: VaultContentSnapshot): Promise<string> {
  if (snapshot) return snapshot.get(path) ?? "";
  // Read through for each sweep — cheap for a personal vault, and always fresh.
  try {
    return await window.api.vault.read(path);
  } catch {
    return "";
  }
}

/** Line-level full-text search, like the search modal's, returning every hit. */
export async function searchLines(
  files: { name: string; path: string }[],
  query: string,
  cap = 200,
): Promise<SearchHit[]> {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const hits: SearchHit[] = [];
  for (const f of files) {
    const text = await readSafe(f.path);
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i] ?? "";
      if (ln.toLowerCase().includes(q)) {
        hits.push({ path: f.path, line: i + 1, text: ln.trim() });
        if (hits.length >= cap) return hits;
      }
    }
  }
  return hits;
}

/**
 * Rank notes for a natural-language query: score by how many query terms appear
 * (title matches weighted heavily), and return a short snippet per note. Used to
 * feed the AI relevant context without giving it filesystem tools.
 */
export async function rankNotes(
  files: { name: string; path: string; privacy?: EffectivePrivacy }[],
  query: string,
  limit = 6,
  aiIsLocal = false,
  snapshot?: VaultContentSnapshot,
): Promise<NoteMatch[]> {
  // Split on anything that isn't a Unicode letter or number, so words with
  // diacritics ("Zürich", "naïve") or in non-Latin scripts tokenize intact.
  // Common question glue is ignored so "what should I do about pricing" ranks
  // pricing knowledge rather than every note containing "what".
  const terms = queryTerms(query);
  if (terms.length === 0) return [];

  const matches: NoteMatch[] = [];
  for (const f of files) {
    const text = await readSafe(f.path, snapshot);
    const { data, body } = parseFrontmatter(text);
    const name = noteName(f.path);
    const nameLower = name.toLowerCase();
    const description = noteDescription(data);
    const mode = f.privacy?.mode ?? (isPrivate(data) ? "cloud-ai-private" : "public");
    const access = remoteAiAccessForPrivacy(mode, { aiIsLocal });
    // Local-only + remote: the note is entirely out of AI retrieval. Cloud-AI
    // private stays findable by title/description/tags, but body/snippets are
    // hidden. Local providers (nothing leaves the device) treat it like any
    // other note.
    if (access === "none") continue;
    const hidden = access === "metadata";
    const searchable = hidden ? `${name}\n${description}\n${noteTags(data).join(" ")}` : text;
    const lower = searchable.toLowerCase();

    let score = 0;
    for (const t of terms) {
      if (nameLower.includes(t)) score += 5;
      let idx = lower.indexOf(t);
      let count = 0;
      while (idx !== -1 && count < 50) {
        score += 1;
        count++;
        idx = lower.indexOf(t, idx + t.length);
      }
    }
    if (score === 0) continue;

    // Grab a few representative body lines for the snippet — never for a hidden note.
    let snippet = "";
    if (!hidden) {
      const hitLines = new Set<string>();
      for (const ln of body.split("\n")) {
        const l = ln.toLowerCase();
        if (terms.some((t) => l.includes(t)) && ln.trim()) {
          hitLines.add(ln.trim());
          if (hitLines.size >= 4) break;
        }
      }
      snippet = [...hitLines].join(" … ").slice(0, 500);
    }
    matches.push({
      path: f.path,
      name,
      snippet,
      score,
      private: hidden,
      description,
      privacy: f.privacy,
    });
  }
  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, limit);
}

export interface VaultContextResult {
  matches: NoteMatch[];
}

/**
 * Build grounded chat context without depending on a particular model's tool
 * protocol. The index is always included when available, keyword-ranked notes
 * are included with their full bodies, and one hop of wikilinks is followed.
 * A total budget prevents large vaults from flooding the model's context.
 */
export async function retrieveNotesForContext(
  files: { name: string; path: string; privacy?: EffectivePrivacy }[],
  query: string,
  opts: {
    aiIsLocal?: boolean;
    excludePaths?: string[];
    snapshot?: VaultContentSnapshot;
  } = {},
): Promise<VaultContextResult> {
  const aiIsLocal = opts.aiIsLocal ?? false;
  const excluded = new Set(opts.excludePaths ?? []);
  const byPath = new Map(files.map((file) => [file.path, file]));
  const contentCache = new Map<string, string>();
  const read = async (path: string): Promise<string> => {
    const cached = contentCache.get(path);
    if (cached !== undefined) return cached;
    const content = await readSafe(path, opts.snapshot);
    contentCache.set(path, content);
    return content;
  };
  const accessFor = async (path: string): Promise<"full" | "metadata" | "none"> => {
    const file = byPath.get(path);
    if (!file) return "none";
    const { data } = parseFrontmatter(await read(path));
    const mode = file.privacy?.mode ?? (isPrivate(data) ? "cloud-ai-private" : "public");
    return remoteAiAccessForPrivacy(mode, { aiIsLocal });
  };

  const ranked = await rankNotes(files, query, CONTEXT_NOTE_LIMIT * 2, aiIsLocal, opts.snapshot);
  const rankedByPath = new Map(ranked.map((match) => [match.path, match]));
  const candidates: string[] = [];
  const queued = new Set<string>();
  const enqueue = (path: string | null): void => {
    if (!path || excluded.has(path) || queued.has(path) || !byPath.has(path)) return;
    queued.add(path);
    candidates.push(path);
  };

  // The user's index is the retrieval map. Give it to the model on every
  // vault-scoped question, then prioritize links from index lines that match
  // the question before falling back to whole-vault lexical ranking.
  const indexPath = files.find((file) => file.path.toLowerCase() === "index.md")?.path ?? null;
  enqueue(indexPath);
  if (indexPath && (await accessFor(indexPath)) === "full") {
    const index = await read(indexPath);
    const terms = queryTerms(query);
    const matchingLines = index
      .split("\n")
      .map((line) => ({
        line,
        score: terms.filter((term) => line.toLowerCase().includes(term)).length,
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);
    for (const { line } of matchingLines) {
      for (const link of extractWikiLinks(line)) enqueue(resolveWikiLink(link.target, files));
    }
  }
  for (const match of ranked) enqueue(match.path);

  // Follow one hop from the strongest matches. This captures supporting source,
  // person, project, and concept pages that keyword-only retrieval would miss.
  for (const path of candidates.filter((candidate) => candidate !== indexPath).slice(0, 6)) {
    if ((await accessFor(path)) !== "full") continue;
    const content = await read(path);
    for (const link of extractWikiLinks(content)) enqueue(resolveWikiLink(link.target, files));
  }

  const matches: NoteMatch[] = [];
  let remaining = CONTEXT_CHAR_BUDGET;
  for (const path of candidates) {
    if (matches.length >= CONTEXT_NOTE_LIMIT || remaining <= 0) break;
    const file = byPath.get(path);
    if (!file) continue;
    const content = await read(path);
    const { data, body } = parseFrontmatter(content);
    const description = noteDescription(data);
    const access = await accessFor(path);
    if (access === "none") continue;
    const hidden = access === "metadata";
    const available = Math.min(PER_NOTE_CHAR_LIMIT, remaining);
    const fullBody = hidden ? "" : body.trim().slice(0, available);
    if (!hidden && !fullBody) continue;
    remaining -= fullBody.length;
    matches.push({
      path,
      name: noteName(path),
      snippet: fullBody,
      score: rankedByPath.get(path)?.score ?? (path === indexPath ? Number.MAX_SAFE_INTEGER : 0),
      private: hidden,
      description,
      privacy: file.privacy,
    });
  }

  return { matches };
}
