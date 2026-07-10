import type { IsoTimestamp, Ulid } from "./ids.js";

/**
 * Note-publishing domain shapes (Feature B — plan/sync-collab-open-core.md §3).
 * Mirrors the `note_publications` table added by the note_publishing migration.
 */

/** Per-note publish state. Only notes-zone files can carry one (DB-enforced). */
export interface NotePublication {
  fileId: Ulid;
  workspaceId: Ulid;
  /** Live switch: false = revoked; the token stops resolving immediately. */
  published: boolean;
  /**
   * Unguessable capability in the public URL. Minted fresh on every publish —
   * never reused across publish cycles, so a revoked link stays dead forever.
   */
  publicToken: string;
  publishedAt: IsoTimestamp;
}

/**
 * The narrow projection an anonymous reader gets for a valid token — nothing
 * about the workspace, paths, versions, or authorship. This is the raw note;
 * the render route must still pass it through `publish/toPublishedView` before
 * showing it (wikilink flattening, asset minting).
 */
export interface PublishedNote {
  title: string;
  content: string;
  publishedAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}
