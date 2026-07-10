import type {
  ChangeSet,
  FileChange,
  FileRecord,
  FileVersion,
  Workspace,
} from "../types/entities.js";
import type { Ulid, Uuid } from "../types/ids.js";
import type {
  ChangeFeedEntry,
  MemberDirectoryEntry,
  WorkspaceInvite,
  WorkspaceMember,
} from "../types/members.js";
import type { PrivacyRuleRecord } from "../privacy/index.js";
import { WORKSPACE_MEMBER_CAP } from "../types/members.js";
import type {
  ChangeSetRepo,
  CommitFileOptions,
  CommitFileResult,
  FileQuery,
  FileRepo,
  MembershipRepo,
  PrivacyRuleQuery,
  PrivacyRuleRepo,
  WorkspaceRepo,
} from "./repositories.js";

/**
 * In-memory repository implementations so `@kestravault/core` has NO live-network
 * dependency in CI. They store plain clones of the entities and implement the
 * exact same interfaces as the Supabase-backed repos, so tests (and local dev)
 * can run the same code paths deterministically.
 */

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryWorkspaceRepo implements WorkspaceRepo {
  private readonly byId = new Map<Ulid, Workspace>();

  async get(id: Ulid): Promise<Workspace | null> {
    const found = this.byId.get(id);
    return found ? clone(found) : null;
  }

  async listByOwner(ownerId: Ulid): Promise<Workspace[]> {
    return [...this.byId.values()].filter((w) => w.ownerId === ownerId).map(clone);
  }

  async upsert(workspace: Workspace): Promise<Workspace> {
    this.byId.set(workspace.id, clone(workspace));
    return clone(workspace);
  }
}

export class InMemoryFileRepo implements FileRepo {
  private readonly byId = new Map<Ulid, FileRecord>();
  private readonly versions = new Map<Ulid, FileVersion[]>();

  async get(id: Ulid): Promise<FileRecord | null> {
    const found = this.byId.get(id);
    return found ? clone(found) : null;
  }

  async getByPath(workspaceId: Ulid, path: string): Promise<FileRecord | null> {
    for (const file of this.byId.values()) {
      if (file.workspaceId === workspaceId && file.path === path) {
        return clone(file);
      }
    }
    return null;
  }

  async list(workspaceId: Ulid, query: FileQuery = {}): Promise<FileRecord[]> {
    return [...this.byId.values()]
      .filter((file) => file.workspaceId === workspaceId)
      .filter((file) => (query.zone ? file.zone === query.zone : true))
      .filter((file) => (query.includeDeleted ? true : !file.deleted))
      .map(clone);
  }

  async upsert(file: FileRecord): Promise<FileRecord> {
    this.byId.set(file.id, clone(file));
    return clone(file);
  }

  async commit(file: FileRecord, opts: CommitFileOptions): Promise<CommitFileResult> {
    // Mirrors the commit_file_version Postgres function: version check, then
    // file upsert + version append as one unit. Callers own id/clock minting.
    if (file.version !== opts.expectedVersion + 1) {
      throw new Error(
        `commit failed: file.version (${file.version}) must be expectedVersion + 1 ` +
          `(${opts.expectedVersion + 1})`,
      );
    }
    const existing = this.byId.get(file.id);
    if (opts.expectedVersion === 0) {
      if (existing) return { status: "conflict", current: clone(existing) };
      // A create also loses to a live file already occupying the path
      // (the partial unique index on (workspace_id, path) where deleted = false).
      const atPath = await this.getByPath(file.workspaceId, file.path);
      if (atPath && !atPath.deleted) return { status: "conflict", current: atPath };
    } else {
      if (!existing || existing.version !== opts.expectedVersion) {
        return { status: "conflict", current: existing ? clone(existing) : null };
      }
    }
    this.byId.set(file.id, clone(file));
    await this.addVersion({
      id: opts.versionId,
      fileId: file.id,
      version: file.version,
      content: file.content,
      sha256: file.sha256,
      updatedBy: file.updatedBy,
      authorId: opts.authorId,
      changeSetId: opts.changeSetId ?? null,
      createdAt: file.updatedAt,
    });
    return { status: "committed", file: clone(file) };
  }

  async addVersion(version: FileVersion): Promise<FileVersion> {
    const list = this.versions.get(version.fileId) ?? [];
    list.push(clone(version));
    this.versions.set(version.fileId, list);
    return clone(version);
  }

  async listVersions(fileId: Ulid): Promise<FileVersion[]> {
    return (this.versions.get(fileId) ?? []).map(clone).sort((a, b) => a.version - b.version);
  }

  async getVersion(fileId: Ulid, version: number): Promise<FileVersion | null> {
    const found = (this.versions.get(fileId) ?? []).find((v) => v.version === version);
    return found ? clone(found) : null;
  }
}

export class InMemoryChangeSetRepo implements ChangeSetRepo {
  private readonly byId = new Map<Ulid, ChangeSet>();
  private readonly changes = new Map<Ulid, FileChange[]>();

  async get(id: Ulid): Promise<ChangeSet | null> {
    const found = this.byId.get(id);
    return found ? clone(found) : null;
  }

  async listByWorkspace(workspaceId: Ulid): Promise<ChangeSet[]> {
    return [...this.byId.values()].filter((cs) => cs.workspaceId === workspaceId).map(clone);
  }

  async create(changeSet: ChangeSet, changes: FileChange[]): Promise<ChangeSet> {
    this.byId.set(changeSet.id, clone(changeSet));
    this.changes.set(changeSet.id, changes.map(clone));
    return clone(changeSet);
  }

  async listChanges(changeSetId: Ulid): Promise<FileChange[]> {
    return (this.changes.get(changeSetId) ?? []).map(clone);
  }

  async addChanges(changes: FileChange[]): Promise<void> {
    for (const change of changes) {
      const list = this.changes.get(change.changeSetId) ?? [];
      list.push(clone(change));
      this.changes.set(change.changeSetId, list);
    }
  }

  async markReverted(id: Ulid): Promise<void> {
    const found = this.byId.get(id);
    if (found) {
      found.reverted = true;
    }
  }
}

export class InMemoryMembershipRepo implements MembershipRepo {
  /** workspaceId -> userId -> membership. */
  private readonly members = new Map<Ulid, Map<Uuid, WorkspaceMember>>();
  private readonly invitesByToken = new Map<string, WorkspaceInvite>();
  /** userId -> email, the in-memory stand-in for auth.users (see setEmail). */
  private readonly emails = new Map<Uuid, string>();

  /**
   * `now` is injectable so expiry tests are deterministic; `files` backs the
   * change feed (the Supabase implementation joins file_versions + files
   * server-side — here we read the same data through the FileRepo interface).
   */
  constructor(
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly files?: FileRepo,
  ) {}

  /** Test helper: register the email behind a user id (mirrors auth.users). */
  setEmail(userId: Uuid, email: string): void {
    this.emails.set(userId, email);
  }

  async listMembers(workspaceId: Ulid): Promise<WorkspaceMember[]> {
    return [...(this.members.get(workspaceId)?.values() ?? [])].map(clone);
  }

  async addMember(member: WorkspaceMember): Promise<WorkspaceMember> {
    // Mirrors the Postgres guards: unique (workspace_id, user_id), one owner
    // row per workspace, and the hard 3-member cap trigger.
    const roster = this.members.get(member.workspaceId) ?? new Map<Uuid, WorkspaceMember>();
    if (roster.has(member.userId)) {
      throw new Error(`already a member of workspace ${member.workspaceId}`);
    }
    const existing = [...roster.values()];
    if (member.role === "owner" && existing.some((m) => m.role === "owner")) {
      throw new Error(`workspace ${member.workspaceId} already has an owner`);
    }
    if (
      member.role === "member" &&
      existing.filter((m) => m.role === "member").length >= WORKSPACE_MEMBER_CAP
    ) {
      throw new Error(
        `member cap exceeded: workspace ${member.workspaceId} already has ` +
          `${WORKSPACE_MEMBER_CAP} members (owner + ${WORKSPACE_MEMBER_CAP} people maximum)`,
      );
    }
    roster.set(member.userId, clone(member));
    this.members.set(member.workspaceId, roster);
    return clone(member);
  }

  async createInvite(invite: WorkspaceInvite): Promise<WorkspaceInvite> {
    if (this.invitesByToken.has(invite.token)) {
      throw new Error(`invite token already exists`);
    }
    this.invitesByToken.set(invite.token, clone(invite));
    return clone(invite);
  }

  async redeemInvite(token: string, userId: Uuid): Promise<WorkspaceMember> {
    const invite = this.invitesByToken.get(token);
    if (!invite) {
      throw new Error("invalid invite token");
    }
    if (invite.redeemedBy !== null) {
      throw new Error("invite already redeemed (invites are single-use)");
    }
    const now = this.now();
    if (invite.expiresAt <= now) {
      throw new Error(`invite expired at ${invite.expiresAt}`);
    }
    // addMember enforces the cap and duplicate membership; on failure the
    // token is NOT burned (mirrors the transactional server behavior).
    const member = await this.addMember({
      workspaceId: invite.workspaceId,
      userId,
      role: "member",
      createdAt: now,
    });
    invite.redeemedBy = userId;
    return member;
  }

  async checkAccess(workspaceId: Ulid, userId: Uuid): Promise<boolean> {
    return this.members.get(workspaceId)?.has(userId) ?? false;
  }

  async memberDirectory(workspaceId: Ulid): Promise<MemberDirectoryEntry[]> {
    return [...(this.members.get(workspaceId)?.values() ?? [])].map((m) => ({
      userId: m.userId,
      email: this.emails.get(m.userId) ?? null,
    }));
  }

  async changeFeed(workspaceId: Ulid, limit = 50): Promise<ChangeFeedEntry[]> {
    if (!this.files) return [];
    const entries: ChangeFeedEntry[] = [];
    for (const file of await this.files.list(workspaceId, { includeDeleted: true })) {
      for (const v of await this.files.listVersions(file.id)) {
        entries.push({
          versionId: v.id,
          fileId: file.id,
          path: file.path,
          title: file.title,
          zone: file.zone,
          version: v.version,
          updatedBy: v.updatedBy,
          authorId: v.authorId,
          authorEmail: v.authorId ? (this.emails.get(v.authorId) ?? null) : null,
          deleted: file.deleted,
          createdAt: v.createdAt,
        });
      }
    }
    // Newest first, capped the same way the SQL function clamps max_rows.
    return entries
      .sort(
        (a, b) => b.createdAt.localeCompare(a.createdAt) || b.versionId.localeCompare(a.versionId),
      )
      .slice(0, Math.max(1, Math.min(limit, 200)));
  }
}

export class InMemoryPrivacyRuleRepo implements PrivacyRuleRepo {
  private readonly byKey = new Map<string, PrivacyRuleRecord>();

  private key(rule: Pick<PrivacyRuleRecord, "workspaceId" | "target" | "path">): string {
    return `${rule.workspaceId}:${rule.target}:${rule.path}`;
  }

  async list(workspaceId: Ulid, query: PrivacyRuleQuery = {}): Promise<PrivacyRuleRecord[]> {
    return [...this.byKey.values()]
      .filter((rule) => rule.workspaceId === workspaceId)
      .filter((rule) => (query.includeDeleted ? true : !rule.deleted))
      .map(clone);
  }

  async upsert(rule: PrivacyRuleRecord): Promise<PrivacyRuleRecord> {
    this.byKey.set(this.key(rule), clone(rule));
    return clone(rule);
  }
}
