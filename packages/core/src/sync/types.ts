import type { Sha256, Ulid } from "../types/ids.js";

/**
 * Shapes shared by the sync engine (./engine.ts) and its hosts. The engine is
 * platform-agnostic; each app supplies a {@link LocalVaultStore} over its local
 * mirror (desktop: the real vault folder; tests: an in-memory map) and persists
 * the {@link SyncState} between runs (desktop: `.kestravault/sync-state.json`).
 */

/** One markdown file as it exists in the local mirror (POSIX-relative path). */
export interface LocalFile {
  path: string;
  content: string;
}

/** Platform adapter over the local vault mirror. Markdown files only. */
export interface LocalVaultStore {
  /** Every synced markdown file in the vault, with content. */
  list(): Promise<LocalFile[]>;
  /** Write (create or replace) a file, creating parent folders as needed. */
  write(path: string, content: string): Promise<void>;
  /** Remove a file. Must not throw if it is already gone. */
  remove(path: string): Promise<void>;
}

/** What the last successful sync recorded about one file. */
export interface SyncedFileState {
  /** Canonical file id this path is bound to. */
  fileId: Ulid;
  /** Remote version the local copy is based on — the 3-way-merge ancestor. */
  version: number;
  /** Hash of the content both sides agreed on then; detects local edits. */
  sha256: Sha256;
}

/** The engine's memory between runs, persisted by the host per vault. */
export interface SyncState {
  workspaceId: Ulid;
  /** Keyed by workspace-relative POSIX path. */
  files: Record<string, SyncedFileState>;
}

/** A fresh state for a vault that has never synced. */
export function emptySyncState(workspaceId: Ulid): SyncState {
  return { workspaceId, files: {} };
}

/** An overlapping edit resolved first-committer-wins (plan §2). */
export interface SyncConflict {
  /** The contested path — now holding the first-committed (remote) content. */
  path: string;
  /** Where the losing local edit was preserved (`*.conflict.md`). */
  conflictPath: string;
}

/** A per-file failure that did not stop the rest of the run. */
export interface SyncError {
  path: string;
  message: string;
}

/** What one {@link syncVault} run did. */
export interface SyncReport {
  /** The state to persist and feed into the next run. */
  state: SyncState;
  /** Remote → local writes. */
  pulled: string[];
  /** Local → remote commits (creates, edits, resurrections). */
  pushed: string[];
  /** Both sides changed and merged cleanly (written to both sides). */
  merged: string[];
  /** Overlapping edits: remote kept canonical, local copy saved aside. */
  conflicts: SyncConflict[];
  /** Removed locally because the file was deleted remotely. */
  deletedLocal: string[];
  /** Soft-deleted remotely because the file was deleted locally. */
  deletedRemote: string[];
  /** Left for the next run after losing a commit race mid-run. */
  deferred: string[];
  /** Per-file failures (the run continues past them). */
  errors: SyncError[];
}
