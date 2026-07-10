import type { PostgrestError } from "@supabase/supabase-js";
import type { NotePublication, PublishedNote } from "../types/publishing.js";
import type { IsoTimestamp, Ulid } from "../types/ids.js";
import type { KestravaultSupabaseClient } from "./client.js";
import { TABLE } from "./database.types.js";
import type { NotePublicationRow, PublishedNoteRow } from "./database.types.js";
import type { FileRepo } from "./repositories.js";

/**
 * Note-publishing persistence (Feature B — plan/sync-collab-open-core.md §3).
 * Self-contained on purpose (interface + mappers + in-memory + Supabase impls in
 * one module) so it composes with, but never edits, the canonical repo files
 * another agent may be touching. Same conventions as ./repositories.ts et al.
 */

export interface NotePublishRepo {
  /**
   * Publish a notes-zone file: create-or-refresh its publication with a freshly
   * minted token (tokens are never reused across publish cycles — a previously
   * revoked link must never come back to life). Rejects non-notes files.
   */
  publish(fileId: Ulid, workspaceId: Ulid): Promise<NotePublication>;
  /** Revoke: the token stops resolving immediately. Idempotent. */
  unpublish(fileId: Ulid): Promise<void>;
  /** Owner-side view of a note's publish state (any state, or null). */
  getPublication(fileId: Ulid): Promise<NotePublication | null>;
  /**
   * The anonymous read path: resolve a public token to the published note, or
   * null when the token is unknown, revoked, or its file is gone. Returns the
   * narrow {@link PublishedNote} projection only — never the row.
   */
  fetchPublishedByToken(token: string): Promise<PublishedNote | null>;
}

/** Injectable token/clock so both impls stay deterministic in tests. */
export interface NotePublishDeps {
  newToken?: () => string;
  now?: () => IsoTimestamp;
}

/**
 * Mint an unguessable public token: 32 bytes of CSPRNG randomness as 64 hex
 * chars. Deliberately NOT a ULID (ULIDs lead with a timestamp and carry only
 * 80 random bits — guessability matters here, sortability does not).
 */
export function mintPublicToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// --- mappers (same row<->entity bridging as ./mappers.ts) -------------------

export function rowToNotePublication(row: NotePublicationRow): NotePublication {
  return {
    fileId: row.file_id,
    workspaceId: row.workspace_id,
    published: row.published,
    publicToken: row.public_token,
    publishedAt: row.published_at,
  };
}

export function notePublicationToRow(publication: NotePublication): NotePublicationRow {
  return {
    file_id: publication.fileId,
    workspace_id: publication.workspaceId,
    published: publication.published,
    public_token: publication.publicToken,
    published_at: publication.publishedAt,
  };
}

export function rowToPublishedNote(row: PublishedNoteRow): PublishedNote {
  return {
    title: row.title,
    content: row.content,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
  };
}

// --- in-memory (tests / local dev; no network) -------------------------------

export class InMemoryNotePublishRepo implements NotePublishRepo {
  private readonly byFileId = new Map<Ulid, NotePublication>();

  constructor(
    private readonly files: FileRepo,
    private readonly deps: NotePublishDeps = {},
  ) {}

  private mintToken(): string {
    return (this.deps.newToken ?? mintPublicToken)();
  }

  private timestamp(): IsoTimestamp {
    return (this.deps.now ?? (() => new Date().toISOString()))();
  }

  async publish(fileId: Ulid, workspaceId: Ulid): Promise<NotePublication> {
    // Mirrors the DB trigger: only live notes-zone files are publishable.
    const file = await this.files.get(fileId);
    if (!file || file.workspaceId !== workspaceId || file.deleted) {
      throw new Error(`publish failed: file ${fileId} not found in workspace ${workspaceId}`);
    }
    if (file.zone !== "notes") {
      throw new Error(
        `publish failed: only notes/ files are publishable (${file.path} is in ${file.zone}/)`,
      );
    }
    const publication: NotePublication = {
      fileId,
      workspaceId,
      published: true,
      publicToken: this.mintToken(),
      publishedAt: this.timestamp(),
    };
    this.byFileId.set(fileId, structuredClone(publication));
    return publication;
  }

  async unpublish(fileId: Ulid): Promise<void> {
    const publication = this.byFileId.get(fileId);
    if (publication) {
      publication.published = false;
    }
  }

  async getPublication(fileId: Ulid): Promise<NotePublication | null> {
    const found = this.byFileId.get(fileId);
    return found ? structuredClone(found) : null;
  }

  async fetchPublishedByToken(token: string): Promise<PublishedNote | null> {
    if (!token) return null;
    for (const publication of this.byFileId.values()) {
      if (publication.publicToken !== token || !publication.published) continue;
      const file = await this.files.get(publication.fileId);
      if (!file || file.deleted || file.zone !== "notes") return null;
      return {
        title: file.title,
        content: file.content,
        publishedAt: publication.publishedAt,
        updatedAt: file.updatedAt,
      };
    }
    return null;
  }
}

// --- Supabase (production) ---------------------------------------------------

function fail(context: string, error: PostgrestError): never {
  throw new Error(`Supabase ${context} failed: ${error.message}`);
}

export class SupabaseNotePublishRepo implements NotePublishRepo {
  constructor(
    private readonly client: KestravaultSupabaseClient,
    private readonly deps: NotePublishDeps = {},
  ) {}

  async publish(fileId: Ulid, workspaceId: Ulid): Promise<NotePublication> {
    const row: NotePublicationRow = {
      file_id: fileId,
      workspace_id: workspaceId,
      published: true,
      public_token: (this.deps.newToken ?? mintPublicToken)(),
      published_at: (this.deps.now ?? (() => new Date().toISOString()))(),
    };
    const { data, error } = await this.client
      .from(TABLE.notePublications)
      .upsert(row)
      .select("*")
      .single();
    if (error) fail("note_publications.publish", error);
    return rowToNotePublication(data);
  }

  async unpublish(fileId: Ulid): Promise<void> {
    const { error } = await this.client
      .from(TABLE.notePublications)
      .update({ published: false })
      .eq("file_id", fileId);
    if (error) fail("note_publications.unpublish", error);
  }

  async getPublication(fileId: Ulid): Promise<NotePublication | null> {
    const { data, error } = await this.client
      .from(TABLE.notePublications)
      .select("*")
      .eq("file_id", fileId)
      .maybeSingle();
    if (error) fail("note_publications.getPublication", error);
    return data ? rowToNotePublication(data) : null;
  }

  async fetchPublishedByToken(token: string): Promise<PublishedNote | null> {
    if (!token) return null;
    // The token-gated anonymous read path: a SECURITY DEFINER function that
    // returns the narrow projection for a live publication (see the
    // note_publishing migration). Anonymous clients cannot select the
    // publications table itself, so tokens are never enumerable.
    const { data, error } = await this.client.rpc("fetch_published_note", {
      note_token: token,
    });
    if (error) fail("fetch_published_note", error);
    const row = data?.[0];
    return row ? rowToPublishedNote(row) : null;
  }
}
