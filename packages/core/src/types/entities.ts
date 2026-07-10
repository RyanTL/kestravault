import type { IsoTimestamp, Sha256, Ulid, Uuid } from "./ids.js";
import type {
  ChangeSetKind,
  FileOp,
  FileType,
  IngestMode,
  RunMode,
  UpdatedBy,
  Zone,
} from "./enums.js";

/**
 * Canonical data model — mirrors the Supabase Postgres schema sketched in
 * plan/data-model.md. These are the shapes `packages/core` exposes to the
 * clients; the SQL migrations are the source of truth for the columns.
 */

export interface WorkspaceConfig {
  /** Default ingestion mode for new sources. */
  ingestMode: IngestMode;
  /** Default model tier for agent runs. */
  runMode: RunMode;
  /** Wiki sub-folders scaffolded at onboarding (e.g. entities, concepts, topics). */
  scaffold: string[];
}

/** A "brain": an isolated tree of sources/wiki/notes the agent never crosses. */
export interface Workspace {
  id: Ulid;
  ownerId: Ulid;
  name: string;
  createdAt: IsoTimestamp;
  config: WorkspaceConfig;
}

/** The current state of one markdown file in a workspace. */
export interface FileRecord {
  id: Ulid;
  workspaceId: Ulid;
  /** Workspace-relative path, e.g. `wiki/concepts/ownership.md`. */
  path: string;
  zone: Zone;
  type: FileType;
  title: string;
  content: string;
  sha256: Sha256;
  version: number;
  updatedBy: UpdatedBy;
  updatedAt: IsoTimestamp;
  deleted: boolean;
}

/** An immutable historical version of a file (backs sync's 3-way merge + undo). */
export interface FileVersion {
  id: Ulid;
  fileId: Ulid;
  version: number;
  content: string;
  sha256: Sha256;
  updatedBy: UpdatedBy;
  /**
   * The auth user who wrote this version — per-author attribution in shared
   * workspaces (plan/sync-collab-open-core.md §2). Null for agent/system writes
   * and for versions that predate attribution.
   */
  authorId: Uuid | null;
  /** The change-set this version belongs to, or null for plain human edits. */
  changeSetId: Ulid | null;
  createdAt: IsoTimestamp;
}

/** One atomic agent run, recorded as a unit so it can be shown and undone. */
export interface ChangeSet {
  id: Ulid;
  workspaceId: Ulid;
  kind: ChangeSetKind;
  summary: string;
  /** The triggering event (e.g. the source id + content hash), if any. */
  sourceEvent: Record<string, unknown> | null;
  /** The auth user whose action produced this change-set (null = system/agent). */
  authorId: Uuid | null;
  createdAt: IsoTimestamp;
  reverted: boolean;
}

/** A single file's change within a change-set, with a unified diff. */
export interface FileChange {
  id: Ulid;
  changeSetId: Ulid;
  fileId: Ulid;
  op: FileOp;
  beforeVersion: number | null;
  afterVersion: number | null;
  diff: string;
}

/** A binary attachment (image, PDF source, …) stored in Supabase Storage. */
export interface Asset {
  id: Ulid;
  workspaceId: Ulid;
  storagePath: string;
  mime: string;
  sha256: Sha256;
  createdAt: IsoTimestamp;
}
