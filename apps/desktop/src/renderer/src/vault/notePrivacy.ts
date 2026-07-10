import { parseFrontmatter } from "@kestravault/core";

// A note's **Private** flag (`private: true` in frontmatter) hides its body from
// a *remote* AI provider while keeping it findable by title/description/tags.
// See aiPrompts.ts (context redaction) and search.ts (ranking) for how it's
// applied, and Properties.tsx for the toggle.
//
// "Remote vs local" is decided by the active provider: Ollama / LM Studio run on
// the user's machine (PROVIDERS[].local in useSettings.ts), so nothing leaves
// the device and the restriction is relaxed there.
//
// This is the fine-grained, per-note control. It's intentionally orthogonal to
// the future "local-only source/subtree" idea (which depends on cloud sync, not
// built yet): both can coexist — a note is shared with a remote provider only if
// it is neither Private nor inside a local-only source.

export const PRIVATE_KEY = "private";
export const DESCRIPTION_KEY = "description";
export const TAGS_KEY = "tags";

type Data = Record<string, unknown>;

function asData(value: unknown): Data | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Data) : null;
}

/** True when parsed frontmatter marks the note Private. */
export function isPrivate(data: unknown): boolean {
  const d = asData(data);
  return d ? d[PRIVATE_KEY] === true : false;
}

/** Convenience for callers that hold raw markdown rather than parsed data. */
export function isPrivateNote(content: string): boolean {
  return isPrivate(parseFrontmatter(content).data);
}

/** The note's short `description` — safe to show the AI even when Private. */
export function noteDescription(data: unknown): string {
  const d = asData(data);
  const desc = d ? d[DESCRIPTION_KEY] : undefined;
  return typeof desc === "string" ? desc.trim() : "";
}

/** The note's `tags` as a flat string list — also safe metadata when Private. */
export function noteTags(data: unknown): string[] {
  const d = asData(data);
  const tags = d ? d[TAGS_KEY] : undefined;
  return Array.isArray(tags) ? tags.map((t) => String(t)) : [];
}
