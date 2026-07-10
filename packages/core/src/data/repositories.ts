import type {
  ChangeSet,
  FileChange,
  FileRecord,
  FileVersion,
  Workspace,
} from "../types/entities.js";
import type { Ulid, Uuid } from "../types/ids.js";
import type { Zone } from "../types/enums.js";
import type {
  ChangeFeedEntry,
  MemberDirectoryEntry,
  WorkspaceInvite,
  WorkspaceMember,
} from "../types/members.js";
import type { PrivacyRuleRecord } from "../privacy/index.js";

/**
 * Persistence boundaries for the canonical entities. Apps and the orchestrator
 * depend on these interfaces, not on Supabase directly, so the backing store is
 * swappable (Supabase in production — ./supabase-repositories.ts; an in-memory
 * map in tests — ./in-memory.ts). All methods are async to match a network store.
 */

export interface WorkspaceRepo {
  get(id: Ulid): Promise<Workspace | null>;
  listByOwner(ownerId: Ulid): Promise<Workspace[]>;
  /** Insert or replace a workspace by id; returns the stored record. */
  upsert(workspace: Workspace): Promise<Workspace>;
}

/** Filters for listing files within a workspace. */
export interface FileQuery {
  zone?: Zone;
  /** When omitted/false, soft-deleted files are excluded. */
  includeDeleted?: boolean;
}

/** Options for {@link FileRepo.commit} — ids/attribution minted by the caller. */
export interface CommitFileOptions {
  /** Id for the appended `file_versions` row. */
  versionId: Ulid;
  /**
   * The version the caller believes is currently stored (0 when creating a new
   * file). The commit succeeds only if the store still holds exactly this
   * version — this is how "first committer wins" is decided (plan
   * /sync-collab-open-core.md §2 "Concurrent edits").
   */
  expectedVersion: number;
  /** Auth user attributed with this write (null = system/agent). */
  authorId: Uuid | null;
  /** Change-set this write belongs to, or null for a plain edit. */
  changeSetId?: Ulid | null;
}

/** Outcome of an optimistic {@link FileRepo.commit}. */
export type CommitFileResult =
  | { status: "committed"; file: FileRecord }
  | {
      /**
       * Someone else committed first. `current` is the state that won (by id,
       * or the live file occupying the same path on a create race); null when
       * it could not be re-read. The caller re-merges against it and retries.
       */
      status: "conflict";
      current: FileRecord | null;
    };

export interface FileRepo {
  get(id: Ulid): Promise<FileRecord | null>;
  getByPath(workspaceId: Ulid, path: string): Promise<FileRecord | null>;
  list(workspaceId: Ulid, query?: FileQuery): Promise<FileRecord[]>;
  /** Insert or replace the current state of a file by id; returns it. */
  upsert(file: FileRecord): Promise<FileRecord>;

  /**
   * Atomically write the next state of a file AND append its version row, but
   * only if the stored version still equals `expectedVersion` (optimistic
   * concurrency — the sync engine's only write path). `file.version` must be
   * `expectedVersion + 1`. Returns a conflict instead of throwing when another
   * writer got there first, so callers can merge and retry.
   */
  commit(file: FileRecord, opts: CommitFileOptions): Promise<CommitFileResult>;

  /** Append an immutable historical version (backs 3-way merge + undo). */
  addVersion(version: FileVersion): Promise<FileVersion>;
  listVersions(fileId: Ulid): Promise<FileVersion[]>;
  getVersion(fileId: Ulid, version: number): Promise<FileVersion | null>;
}

export interface ChangeSetRepo {
  get(id: Ulid): Promise<ChangeSet | null>;
  listByWorkspace(workspaceId: Ulid): Promise<ChangeSet[]>;
  /**
   * Record a change-set together with its per-file changes as one unit — every
   * agent run is one atomic change-set (see plan/data-model.md).
   */
  create(changeSet: ChangeSet, changes: FileChange[]): Promise<ChangeSet>;
  listChanges(changeSetId: Ulid): Promise<FileChange[]>;
  /** Append per-file changes to an existing change-set. */
  addChanges(changes: FileChange[]): Promise<void>;
  /** Mark a change-set reverted (the inverse application is the caller's job). */
  markReverted(id: Ulid): Promise<void>;
}

/**
 * Shared-workspace membership (Feature A — plan/sync-collab-open-core.md §2).
 * Access is governed by membership, not ownership; the hard 3-member cap and
 * invite single-use/expiry rules are enforced server-side (Postgres triggers +
 * the redeem function), and these methods surface those rejections as errors.
 */
export interface MembershipRepo {
  listMembers(workspaceId: Ulid): Promise<WorkspaceMember[]>;
  /**
   * Add a member directly (owner-managed). Rejects when the workspace already
   * has 3 non-owner members (owner + 3 = 4 people, the hard cap).
   */
  addMember(member: WorkspaceMember): Promise<WorkspaceMember>;
  /**
   * Record a single-use, expiring invite. TODO(entitlements): once billing is
   * live, inviting requires the owner to hold an active paid cloud+sync plan.
   */
  createInvite(invite: WorkspaceInvite): Promise<WorkspaceInvite>;
  /**
   * Redeem an invite token for `userId`, adding them as a `member`. Fails if
   * the token is unknown, already redeemed, expired, or the workspace is full.
   * `userId` must be the caller's authenticated user id — the Supabase
   * implementation derives it server-side from the session.
   */
  redeemInvite(token: string, userId: Uuid): Promise<WorkspaceMember>;
  /** Is this user a member (any role)? The client-side mirror of the RLS scope. */
  checkAccess(workspaceId: Ulid, userId: Uuid): Promise<boolean>;
  /**
   * Resolve the workspace's member user ids to emails (the members list shows
   * people, not ids). Returns [] when the caller is not a member; servers
   * without the member_directory migration throw — callers degrade to ids.
   */
  memberDirectory(workspaceId: Ulid): Promise<MemberDirectoryEntry[]>;
  /**
   * The attributed change feed: recent committed file versions (newest first)
   * with file context and author email. Returns [] when the caller is not a
   * member. `limit` is clamped server-side (default 50, max 200).
   */
  changeFeed(workspaceId: Ulid, limit?: number): Promise<ChangeFeedEntry[]>;
}

export interface PrivacyRuleQuery {
  /** When omitted/false, deleted tombstones are excluded. */
  includeDeleted?: boolean;
}

export interface PrivacyRuleRepo {
  list(workspaceId: Ulid, query?: PrivacyRuleQuery): Promise<PrivacyRuleRecord[]>;
  upsert(rule: PrivacyRuleRecord): Promise<PrivacyRuleRecord>;
}
