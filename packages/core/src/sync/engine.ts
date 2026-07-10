import type { FileRepo } from "../data/repositories.js";
import type { FileRecord } from "../types/entities.js";
import type { IsoTimestamp, Ulid, Uuid } from "../types/ids.js";
import { merge3 } from "../merge/merge3.js";
import { sha256Hex } from "../utils/hash.js";
import { ulid } from "../utils/ulid.js";
import { deriveFileMeta } from "./derive.js";
import type {
  LocalFile,
  LocalVaultStore,
  SyncedFileState,
  SyncReport,
  SyncState,
} from "./types.js";

/**
 * The file-level sync engine — plan/architecture.md "Sync & conflicts" and
 * plan/sync-collab-open-core.md §2, made executable.
 *
 * One run reconciles a local vault mirror with the canonical store:
 *
 *   * remote-only changes are pulled into the mirror;
 *   * local-only changes are committed (optimistically — the commit succeeds
 *     only against the exact version it was based on);
 *   * changes on both sides are 3-way merged against their common ancestor
 *     (the version recorded at the last sync);
 *   * genuinely overlapping edits resolve FIRST-COMMITTER-WINS: the committed
 *     (remote) content stays canonical and the local edit is preserved as a
 *     `*.conflict.md` copy — flagged, synced to everyone, never silently lost;
 *   * deletes are soft and edits beat deletes (a file edited on one device and
 *     deleted on another comes back).
 *
 * The engine is stateless between runs except for the {@link SyncState} the
 * host persists; it is safe to re-run at any time (every branch converges).
 * Multiple concurrent writers (other devices, other members, the cloud agent)
 * are the design assumption, not an edge case.
 */

export interface SyncDeps {
  files: FileRepo;
  local: LocalVaultStore;
  /** Auth user attributed with pushed versions (null = anonymous/local-only). */
  authorId?: Uuid | null;
  /** False for paths that should be removed from / ignored by canonical sync. */
  shouldSyncPath?: (path: string) => boolean;
  newId?: () => Ulid;
  now?: () => IsoTimestamp;
}

export async function syncVault(state: SyncState, deps: SyncDeps): Promise<SyncReport> {
  const run = new SyncRun(state, deps);
  return run.execute();
}

class SyncRun {
  private readonly files: FileRepo;
  private readonly local: LocalVaultStore;
  private readonly authorId: Uuid | null;
  private readonly shouldSyncPath: (path: string) => boolean;
  private readonly newId: () => Ulid;
  private readonly now: () => IsoTimestamp;

  private readonly workspaceId: Ulid;
  private readonly prev: SyncState;
  private readonly next: SyncState;
  private readonly report: SyncReport;

  private localByPath = new Map<string, LocalFile>();
  private remoteLiveByPath = new Map<string, FileRecord>();
  private remoteById = new Map<Ulid, FileRecord>();
  /** Paths claimed this run (conflict copies) so they are minted once. */
  private readonly claimedPaths = new Set<string>();

  constructor(state: SyncState, deps: SyncDeps) {
    this.files = deps.files;
    this.local = deps.local;
    this.authorId = deps.authorId ?? null;
    this.shouldSyncPath = deps.shouldSyncPath ?? (() => true);
    this.newId = deps.newId ?? (() => ulid());
    this.now = deps.now ?? (() => new Date().toISOString());
    this.workspaceId = state.workspaceId;
    this.prev = state;
    this.next = { workspaceId: state.workspaceId, files: {} };
    this.report = {
      state: this.next,
      pulled: [],
      pushed: [],
      merged: [],
      conflicts: [],
      deletedLocal: [],
      deletedRemote: [],
      deferred: [],
      errors: [],
    };
  }

  async execute(): Promise<SyncReport> {
    const remoteAll = await this.files.list(this.workspaceId, { includeDeleted: true });
    for (const record of remoteAll) {
      this.remoteById.set(record.id, record);
      if (!record.deleted) this.remoteLiveByPath.set(record.path, record);
    }
    for (const file of await this.local.list()) {
      this.localByPath.set(file.path, file);
    }

    const paths = new Set<string>([
      ...this.localByPath.keys(),
      ...this.remoteLiveByPath.keys(),
      ...Object.keys(this.prev.files),
    ]);
    // Deterministic order keeps runs reproducible (and tests stable).
    for (const path of [...paths].sort()) {
      try {
        await this.reconcilePath(path);
      } catch (error) {
        this.report.errors.push({
          path,
          message: error instanceof Error ? error.message : String(error),
        });
        // Keep whatever we knew — the next run retries from the same base.
        const st = this.prev.files[path];
        if (st) this.next.files[path] = st;
      }
    }
    return this.report;
  }

  private async reconcilePath(path: string): Promise<void> {
    const st = this.prev.files[path];
    const loc = this.localByPath.get(path) ?? null;
    const rem = this.remoteLiveByPath.get(path) ?? null;

    // Local-only privacy: never pull remote content back to this device, and
    // remove any existing canonical copy so future devices/members cannot read
    // it through the cloud. The local store's list() should already omit these
    // paths, but this branch also handles remote-only copies.
    if (!this.shouldSyncPath(path)) {
      if (rem) await this.pushDelete(rem, st ?? (await this.stateFor(rem)), path);
      return;
    }

    // ── Untracked path: new on one side or both ─────────────────────────────
    if (!st) {
      if (loc && !rem) {
        await this.pushCreate(loc);
      } else if (!loc && rem) {
        await this.pull(rem);
      } else if (loc && rem) {
        if (loc.content === rem.content) {
          await this.adopt(rem);
        } else {
          // Same new path on both sides with different content: the committed
          // side already won; the local draft becomes a conflict copy.
          await this.keepRemoteSaveLocalCopy(loc, rem);
        }
      }
      return;
    }

    // ── Tracked path ────────────────────────────────────────────────────────
    const tracked = this.remoteById.get(st.fileId) ?? null;
    const localSha = loc ? await sha256Hex(loc.content) : null;
    const localChanged = loc !== null && localSha !== st.sha256;
    const localDeleted = loc === null;

    // The tracked file no longer lives at this path (deleted, moved, or gone),
    // possibly with a different live file now occupying the path.
    const trackedGone = !tracked || tracked.deleted || tracked.path !== path;
    if (trackedGone) {
      const replacement = rem && rem.id !== st.fileId ? rem : null;
      if (replacement) {
        if (localDeleted || !localChanged) {
          await this.pull(replacement);
        } else {
          await this.keepRemoteSaveLocalCopy(loc, replacement);
        }
        return;
      }
      if (localDeleted) {
        return; // gone on both sides — just forget it
      }
      if (!localChanged) {
        await this.local.remove(path);
        this.report.deletedLocal.push(path);
        return;
      }
      // Edits beat deletes: bring the file back with the local content.
      if (tracked && tracked.deleted) {
        await this.resurrect(loc, tracked, st);
      } else {
        // Hard-deleted or moved away — push the local content as a new file.
        await this.pushCreate(loc);
      }
      return;
    }

    // Tracked and live at this path.
    const remote = tracked as FileRecord;
    const remoteChanged = remote.version !== st.version;

    if (localDeleted) {
      if (remoteChanged) {
        await this.pull(remote); // edits beat deletes
      } else {
        await this.pushDelete(remote, st, path);
      }
      return;
    }

    if (!localChanged && !remoteChanged) {
      this.next.files[path] = st;
      return;
    }
    if (localChanged && !remoteChanged) {
      await this.pushUpdate(loc, remote, st);
      return;
    }
    if (!localChanged && remoteChanged) {
      await this.pull(remote);
      return;
    }
    await this.mergeBothChanged(loc, remote, st);
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  private async stateFor(record: FileRecord): Promise<SyncedFileState> {
    // Recompute the hash rather than trusting the stored column, so the state
    // is always self-consistent with what this engine would compute next run.
    return {
      fileId: record.id,
      version: record.version,
      sha256: await sha256Hex(record.content),
    };
  }

  private async adopt(record: FileRecord): Promise<void> {
    this.next.files[record.path] = await this.stateFor(record);
  }

  private async pull(record: FileRecord): Promise<void> {
    const existing = this.localByPath.get(record.path);
    if (!existing || existing.content !== record.content) {
      await this.local.write(record.path, record.content);
    }
    await this.adopt(record);
    this.report.pulled.push(record.path);
  }

  private nextRecord(loc: LocalFile, base: { id: Ulid; version: number }): Promise<FileRecord> {
    return (async () => {
      const meta = deriveFileMeta(loc.path, loc.content);
      return {
        id: base.id,
        workspaceId: this.workspaceId,
        path: loc.path,
        zone: meta.zone,
        type: meta.type,
        title: meta.title,
        content: loc.content,
        sha256: await sha256Hex(loc.content),
        version: base.version + 1,
        updatedBy: "human",
        updatedAt: this.now(),
        deleted: false,
      };
    })();
  }

  private async pushCreate(loc: LocalFile): Promise<void> {
    const file = await this.nextRecord(loc, { id: this.newId(), version: 0 });
    const result = await this.files.commit(file, {
      versionId: this.newId(),
      expectedVersion: 0,
      authorId: this.authorId,
    });
    if (result.status === "committed") {
      this.next.files[loc.path] = await this.stateFor(result.file);
      this.report.pushed.push(loc.path);
      return;
    }
    // A create raced a create. The winner is canonical; ours becomes a copy.
    const current = result.current;
    if (current && !current.deleted && current.path === loc.path) {
      if (current.content === loc.content) {
        await this.adopt(current);
      } else {
        await this.keepRemoteSaveLocalCopy(loc, current);
      }
      return;
    }
    this.report.deferred.push(loc.path);
  }

  private async pushUpdate(
    loc: LocalFile,
    remote: FileRecord,
    st: SyncedFileState,
  ): Promise<void> {
    const file = await this.nextRecord(loc, { id: remote.id, version: remote.version });
    const result = await this.files.commit(file, {
      versionId: this.newId(),
      expectedVersion: remote.version,
      authorId: this.authorId,
    });
    if (result.status === "committed") {
      this.next.files[loc.path] = await this.stateFor(result.file);
      this.report.pushed.push(loc.path);
      return;
    }
    // Lost the race: someone committed between our read and our write. Merge
    // against the fresh winner (still using our recorded ancestor) right away.
    if (result.current && !result.current.deleted) {
      await this.mergeBothChanged(loc, result.current, st);
      return;
    }
    this.next.files[loc.path] = st;
    this.report.deferred.push(loc.path);
  }

  private async pushDelete(
    remote: FileRecord,
    st: SyncedFileState,
    path: string,
  ): Promise<void> {
    const result = await this.files.commit(
      {
        ...remote,
        version: remote.version + 1,
        updatedBy: "human",
        updatedAt: this.now(),
        deleted: true,
      },
      {
        versionId: this.newId(),
        expectedVersion: remote.version,
        authorId: this.authorId,
      },
    );
    if (result.status === "committed") {
      this.report.deletedRemote.push(path);
      return; // no next-state entry — the file is gone
    }
    // Someone changed it while we were deleting: keep the state so the next
    // run sees local-deleted vs remote-changed and pulls the edit back.
    this.next.files[path] = st;
    this.report.deferred.push(path);
  }

  private async resurrect(
    loc: LocalFile,
    deletedRemote: FileRecord,
    st: SyncedFileState,
  ): Promise<void> {
    const file = await this.nextRecord(loc, {
      id: deletedRemote.id,
      version: deletedRemote.version,
    });
    const result = await this.files.commit(file, {
      versionId: this.newId(),
      expectedVersion: deletedRemote.version,
      authorId: this.authorId,
    });
    if (result.status === "committed") {
      this.next.files[loc.path] = await this.stateFor(result.file);
      this.report.pushed.push(loc.path);
      return;
    }
    this.next.files[loc.path] = st;
    this.report.deferred.push(loc.path);
  }

  private async mergeBothChanged(
    loc: LocalFile,
    remote: FileRecord,
    st: SyncedFileState,
  ): Promise<void> {
    const base = await this.files.getVersion(st.fileId, st.version);
    if (!base) {
      // No common ancestor to merge through — resolve as a plain clash.
      await this.keepRemoteSaveLocalCopy(loc, remote);
      return;
    }
    const merge = merge3(base.content, loc.content, remote.content, {
      ourLabel: "local",
      theirLabel: "remote",
    });
    if (!merge.clean) {
      // True clash: first committer (remote) wins; local edit saved aside.
      await this.keepRemoteSaveLocalCopy(loc, remote);
      return;
    }
    if (merge.merged === remote.content) {
      // The remote side already contains everything local had.
      await this.pull(remote);
      return;
    }
    await this.local.write(loc.path, merge.merged);
    const merged: LocalFile = { path: loc.path, content: merge.merged };
    const file = await this.nextRecord(merged, { id: remote.id, version: remote.version });
    const result = await this.files.commit(file, {
      versionId: this.newId(),
      expectedVersion: remote.version,
      authorId: this.authorId,
    });
    if (result.status === "committed") {
      this.next.files[loc.path] = await this.stateFor(result.file);
      this.report.merged.push(loc.path);
      return;
    }
    if (result.current && !result.current.deleted) {
      // Raced again — merge once more against the newest winner.
      await this.mergeBothChanged(merged, result.current, st);
      return;
    }
    this.next.files[loc.path] = st;
    this.report.deferred.push(loc.path);
  }

  /**
   * First-committer-wins resolution: the remote (already committed) content
   * stays at the contested path; the local edit is written — and pushed — as a
   * `*.conflict.md` sibling so no one's work is silently lost (plan §2; O8).
   */
  private async keepRemoteSaveLocalCopy(loc: LocalFile, remote: FileRecord): Promise<void> {
    await this.local.write(remote.path, remote.content);
    await this.adopt(remote);

    const conflictPath = this.mintConflictPath(loc.path);
    await this.local.write(conflictPath, loc.content);
    await this.pushCreate({ path: conflictPath, content: loc.content });
    this.report.conflicts.push({ path: loc.path, conflictPath });
  }

  private mintConflictPath(path: string): string {
    const stem = path.replace(/\.md$/i, "");
    const taken = (candidate: string): boolean =>
      this.claimedPaths.has(candidate) ||
      this.localByPath.has(candidate) ||
      this.remoteLiveByPath.has(candidate) ||
      candidate in this.next.files ||
      candidate in this.prev.files;
    let candidate = `${stem}.conflict.md`;
    for (let i = 2; taken(candidate); i++) {
      candidate = `${stem}.conflict ${i}.md`;
    }
    this.claimedPaths.add(candidate);
    return candidate;
  }
}
