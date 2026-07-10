import type { PostgrestError } from "@supabase/supabase-js";
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
import type { KestravaultSupabaseClient } from "./client.js";
import { TABLE } from "./database.types.js";
import {
  changeSetToRow,
  fileChangeToRow,
  fileToRow,
  fileVersionToRow,
  rowToChangeSet,
  rowToFile,
  rowToFileChange,
  rowToFileVersion,
  rowToPrivacyRule,
  rowToWorkspace,
  rowToWorkspaceInvite,
  rowToWorkspaceMember,
  privacyRuleToRow,
  workspaceInviteToRow,
  workspaceMemberToRow,
  workspaceToRow,
} from "./mappers.js";
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
import type { PrivacyRuleRecord } from "../privacy/index.js";

/**
 * Supabase-backed implementations of the repository interfaces, built on the
 * typed client wrapper (./client.ts) and the row<->entity mappers (./mappers.ts).
 * These are the production stores; tests use ./in-memory.ts instead so core has
 * no live-network dependency in CI. Errors surface as thrown `Error`s.
 *
 * NOTE: cross-table atomicity (a change-set + its file_changes) ultimately wants
 * a Postgres function / edge function; until that lands, `create` writes both
 * tables sequentially. Tracked alongside the migrations in `supabase/`.
 */

function fail(context: string, error: PostgrestError): never {
  throw new Error(`Supabase ${context} failed: ${error.message}`);
}

export class SupabaseWorkspaceRepo implements WorkspaceRepo {
  constructor(private readonly client: KestravaultSupabaseClient) {}

  async get(id: Ulid): Promise<Workspace | null> {
    const { data, error } = await this.client
      .from(TABLE.workspaces)
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) fail("workspaces.get", error);
    return data ? rowToWorkspace(data) : null;
  }

  async listByOwner(ownerId: Ulid): Promise<Workspace[]> {
    const { data, error } = await this.client
      .from(TABLE.workspaces)
      .select("*")
      .eq("owner_id", ownerId);
    if (error) fail("workspaces.listByOwner", error);
    return (data ?? []).map(rowToWorkspace);
  }

  async upsert(workspace: Workspace): Promise<Workspace> {
    const { data, error } = await this.client
      .from(TABLE.workspaces)
      .upsert(workspaceToRow(workspace))
      .select("*")
      .single();
    if (error) fail("workspaces.upsert", error);
    return rowToWorkspace(data);
  }
}

export class SupabaseFileRepo implements FileRepo {
  constructor(private readonly client: KestravaultSupabaseClient) {}

  async get(id: Ulid): Promise<FileRecord | null> {
    const { data, error } = await this.client
      .from(TABLE.files)
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) fail("files.get", error);
    return data ? rowToFile(data) : null;
  }

  async getByPath(workspaceId: Ulid, path: string): Promise<FileRecord | null> {
    const { data, error } = await this.client
      .from(TABLE.files)
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("path", path)
      .maybeSingle();
    if (error) fail("files.getByPath", error);
    return data ? rowToFile(data) : null;
  }

  async list(workspaceId: Ulid, query: FileQuery = {}): Promise<FileRecord[]> {
    let builder = this.client.from(TABLE.files).select("*").eq("workspace_id", workspaceId);
    if (query.zone) {
      builder = builder.eq("zone", query.zone);
    }
    if (!query.includeDeleted) {
      builder = builder.eq("deleted", false);
    }
    const { data, error } = await builder;
    if (error) fail("files.list", error);
    return (data ?? []).map(rowToFile);
  }

  async upsert(file: FileRecord): Promise<FileRecord> {
    const { data, error } = await this.client
      .from(TABLE.files)
      .upsert(fileToRow(file))
      .select("*")
      .single();
    if (error) fail("files.upsert", error);
    return rowToFile(data);
  }

  async commit(file: FileRecord, opts: CommitFileOptions): Promise<CommitFileResult> {
    if (file.version !== opts.expectedVersion + 1) {
      throw new Error(
        `commit failed: file.version (${file.version}) must be expectedVersion + 1 ` +
          `(${opts.expectedVersion + 1})`,
      );
    }
    // One Postgres function so the version check, the files update, and the
    // file_versions append are a single transaction (see the sync_commit
    // migration). It raises 'version_conflict'/unique violations when another
    // writer got there first; those surface here as a conflict result.
    const { data, error } = await this.client.rpc("commit_file_version", {
      p_file_id: file.id,
      p_workspace_id: file.workspaceId,
      p_path: file.path,
      p_zone: file.zone,
      p_type: file.type,
      p_title: file.title,
      p_content: file.content,
      p_sha256: file.sha256,
      p_expected_version: opts.expectedVersion,
      p_updated_by: file.updatedBy,
      p_deleted: file.deleted,
      p_version_id: opts.versionId,
      p_author_id: opts.authorId,
      p_change_set_id: opts.changeSetId ?? null,
    });
    if (error) {
      const lost =
        error.message.includes("version_conflict") ||
        // Create racing a create: the partial unique index on (workspace_id,
        // path) where deleted = false rejects the second insert.
        error.message.includes("files_workspace_path_idx") ||
        error.message.includes("duplicate key");
      if (lost) {
        const current =
          (await this.get(file.id)) ?? (await this.getByPath(file.workspaceId, file.path));
        return { status: "conflict", current };
      }
      fail("files.commit", error);
    }
    return { status: "committed", file: rowToFile(data) };
  }

  async addVersion(version: FileVersion): Promise<FileVersion> {
    const { data, error } = await this.client
      .from(TABLE.fileVersions)
      .insert(fileVersionToRow(version))
      .select("*")
      .single();
    if (error) fail("file_versions.addVersion", error);
    return rowToFileVersion(data);
  }

  async listVersions(fileId: Ulid): Promise<FileVersion[]> {
    const { data, error } = await this.client
      .from(TABLE.fileVersions)
      .select("*")
      .eq("file_id", fileId)
      .order("version", { ascending: true });
    if (error) fail("file_versions.listVersions", error);
    return (data ?? []).map(rowToFileVersion);
  }

  async getVersion(fileId: Ulid, version: number): Promise<FileVersion | null> {
    const { data, error } = await this.client
      .from(TABLE.fileVersions)
      .select("*")
      .eq("file_id", fileId)
      .eq("version", version)
      .maybeSingle();
    if (error) fail("file_versions.getVersion", error);
    return data ? rowToFileVersion(data) : null;
  }
}

export class SupabaseChangeSetRepo implements ChangeSetRepo {
  constructor(private readonly client: KestravaultSupabaseClient) {}

  async get(id: Ulid): Promise<ChangeSet | null> {
    const { data, error } = await this.client
      .from(TABLE.changeSets)
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) fail("change_sets.get", error);
    return data ? rowToChangeSet(data) : null;
  }

  async listByWorkspace(workspaceId: Ulid): Promise<ChangeSet[]> {
    const { data, error } = await this.client
      .from(TABLE.changeSets)
      .select("*")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false });
    if (error) fail("change_sets.listByWorkspace", error);
    return (data ?? []).map(rowToChangeSet);
  }

  async create(changeSet: ChangeSet, changes: FileChange[]): Promise<ChangeSet> {
    const { data, error } = await this.client
      .from(TABLE.changeSets)
      .insert(changeSetToRow(changeSet))
      .select("*")
      .single();
    if (error) fail("change_sets.create", error);
    if (changes.length > 0) {
      const { error: changesError } = await this.client
        .from(TABLE.fileChanges)
        .insert(changes.map(fileChangeToRow));
      if (changesError) fail("file_changes.create", changesError);
    }
    return rowToChangeSet(data);
  }

  async listChanges(changeSetId: Ulid): Promise<FileChange[]> {
    const { data, error } = await this.client
      .from(TABLE.fileChanges)
      .select("*")
      .eq("change_set_id", changeSetId);
    if (error) fail("file_changes.listChanges", error);
    return (data ?? []).map(rowToFileChange);
  }

  async addChanges(changes: FileChange[]): Promise<void> {
    if (changes.length === 0) return;
    const { error } = await this.client
      .from(TABLE.fileChanges)
      .insert(changes.map(fileChangeToRow));
    if (error) fail("file_changes.addChanges", error);
  }

  async markReverted(id: Ulid): Promise<void> {
    const { error } = await this.client
      .from(TABLE.changeSets)
      .update({ reverted: true })
      .eq("id", id);
    if (error) fail("change_sets.markReverted", error);
  }
}

export class SupabaseMembershipRepo implements MembershipRepo {
  constructor(private readonly client: KestravaultSupabaseClient) {}

  async listMembers(workspaceId: Ulid): Promise<WorkspaceMember[]> {
    const { data, error } = await this.client
      .from(TABLE.workspaceMembers)
      .select("*")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: true });
    if (error) fail("workspace_members.listMembers", error);
    return (data ?? []).map(rowToWorkspaceMember);
  }

  async addMember(member: WorkspaceMember): Promise<WorkspaceMember> {
    // The hard 3-member cap (and the one-owner invariant) live in Postgres —
    // a BEFORE INSERT trigger rejects the 4th member and the error surfaces here.
    const { data, error } = await this.client
      .from(TABLE.workspaceMembers)
      .insert(workspaceMemberToRow(member))
      .select("*")
      .single();
    if (error) fail("workspace_members.addMember", error);
    return rowToWorkspaceMember(data);
  }

  async createInvite(invite: WorkspaceInvite): Promise<WorkspaceInvite> {
    // TODO(entitlements): once billing lands, creating an invite requires the
    // owner to hold an active paid cloud+sync plan (plan §2 "Entitlement").
    const { data, error } = await this.client
      .from(TABLE.workspaceInvites)
      .insert(workspaceInviteToRow(invite))
      .select("*")
      .single();
    if (error) fail("workspace_invites.createInvite", error);
    return rowToWorkspaceInvite(data);
  }

  async redeemInvite(token: string, userId: Uuid): Promise<WorkspaceMember> {
    // SECURITY DEFINER rpc — the redeemer is not yet a member, so RLS hides the
    // invite row; the server derives the user from the session (auth.uid()).
    const { data, error } = await this.client.rpc("redeem_workspace_invite", {
      invite_token: token,
    });
    if (error) fail("workspace_invites.redeemInvite", error);
    const member = rowToWorkspaceMember(data);
    if (member.userId !== userId) {
      throw new Error(
        `Supabase workspace_invites.redeemInvite failed: invite was redeemed by the ` +
          `authenticated session (${member.userId}), which does not match ${userId}`,
      );
    }
    return member;
  }

  async checkAccess(workspaceId: Ulid, userId: Uuid): Promise<boolean> {
    const { data, error } = await this.client
      .from(TABLE.workspaceMembers)
      .select("workspace_id")
      .eq("workspace_id", workspaceId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) fail("workspace_members.checkAccess", error);
    return data !== null;
  }

  async memberDirectory(workspaceId: Ulid): Promise<MemberDirectoryEntry[]> {
    // SECURITY DEFINER rpc (clients cannot read auth.users); returns [] when
    // the caller is not a member of this workspace.
    const { data, error } = await this.client.rpc("workspace_member_directory", {
      ws_id: workspaceId,
    });
    if (error) fail("workspace_member_directory", error);
    return (data ?? []).map((row) => ({ userId: row.user_id, email: row.email }));
  }

  async changeFeed(workspaceId: Ulid, limit?: number): Promise<ChangeFeedEntry[]> {
    const { data, error } = await this.client.rpc("workspace_change_feed", {
      ws_id: workspaceId,
      ...(limit !== undefined ? { max_rows: limit } : {}),
    });
    if (error) fail("workspace_change_feed", error);
    return (data ?? []).map((row) => ({
      versionId: row.version_id,
      fileId: row.file_id,
      path: row.path,
      title: row.title,
      zone: row.zone,
      version: row.version,
      updatedBy: row.updated_by,
      authorId: row.author_id,
      authorEmail: row.author_email,
      deleted: row.deleted,
      createdAt: row.created_at,
    }));
  }
}

export class SupabasePrivacyRuleRepo implements PrivacyRuleRepo {
  constructor(private readonly client: KestravaultSupabaseClient) {}

  async list(workspaceId: Ulid, query: PrivacyRuleQuery = {}): Promise<PrivacyRuleRecord[]> {
    let builder = this.client
      .from(TABLE.privacyRules)
      .select("*")
      .eq("workspace_id", workspaceId);
    if (!query.includeDeleted) builder = builder.eq("deleted", false);
    const { data, error } = await builder;
    if (error) fail("privacy_rules.list", error);
    return (data ?? []).map(rowToPrivacyRule);
  }

  async upsert(rule: PrivacyRuleRecord): Promise<PrivacyRuleRecord> {
    const { data, error } = await this.client
      .from(TABLE.privacyRules)
      .upsert(privacyRuleToRow(rule), { onConflict: "workspace_id,path,target" })
      .select("*")
      .single();
    if (error) fail("privacy_rules.upsert", error);
    return rowToPrivacyRule(data);
  }
}
