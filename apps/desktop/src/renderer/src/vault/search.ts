import { parseFrontmatter } from "@kestravault/core";
import { remoteAiAccessForPrivacy, type EffectivePrivacy } from "@kestravault/core";
import { isPrivate, noteDescription, noteTags } from "@renderer/vault/notePrivacy";
import { noteName } from "@renderer/vault/paths";

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

async function readSafe(path: string): Promise<string> {
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
): Promise<NoteMatch[]> {
  const terms = query
    .toLowerCase()
    // Split on anything that isn't a Unicode letter or number, so words with
    // diacritics ("Zürich", "naïve") or in non-Latin scripts tokenize intact
    // instead of being shredded into sub-3-char fragments and dropped.
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 3);
  if (terms.length === 0) return [];

  const matches: NoteMatch[] = [];
  for (const f of files) {
    const text = await readSafe(f.path);
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
    matches.push({ path: f.path, name, snippet, score, private: hidden, description, privacy: f.privacy });
  }
  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, limit);
}
