import type {
  Asset,
  ChangeSet,
  FileChange,
  FileRecord,
  FileVersion,
  Workspace,
  WorkspaceConfig,
} from "../types/entities.js";
import type { IngestMode, RunMode } from "../types/enums.js";
import type { WorkspaceInvite, WorkspaceMember } from "../types/members.js";
import type { PrivacyRuleRecord } from "../privacy/index.js";
import type {
  AssetRow,
  ChangeSetRow,
  FileChangeRow,
  FileRow,
  FileVersionRow,
  PrivacyRuleRow,
  WorkspaceInviteRow,
  WorkspaceMemberRow,
  WorkspaceRow,
} from "./database.types.js";

/**
 * Pure, total mappers between Postgres rows (snake_case, ./database.types.ts) and
 * the camelCase domain shapes in ../types/entities.ts. They carry data across the
 * boundary only — no I/O, no defaulting beyond the documented `config` fallback —
 * so they're cheap to unit-test and reuse from both the Supabase repos and tests.
 */

const DEFAULT_WORKSPACE_CONFIG: WorkspaceConfig = {
  ingestMode: "async",
  runMode: "default",
  scaffold: ["entities", "concepts", "topics", "sources"],
};

function readWorkspaceConfig(raw: Record<string, unknown>): WorkspaceConfig {
  const ingestMode = raw.ingestMode;
  const runMode = raw.runMode;
  const scaffold = raw.scaffold;
  return {
    ingestMode: (ingestMode as IngestMode) ?? DEFAULT_WORKSPACE_CONFIG.ingestMode,
    runMode: (runMode as RunMode) ?? DEFAULT_WORKSPACE_CONFIG.runMode,
    scaffold: Array.isArray(scaffold)
      ? (scaffold as string[])
      : DEFAULT_WORKSPACE_CONFIG.scaffold,
  };
}

export function rowToWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    createdAt: row.created_at,
    config: readWorkspaceConfig(row.config ?? {}),
  };
}

export function workspaceToRow(workspace: Workspace): WorkspaceRow {
  return {
    id: workspace.id,
    owner_id: workspace.ownerId,
    name: workspace.name,
    created_at: workspace.createdAt,
    config: { ...workspace.config },
  };
}

export function rowToFile(row: FileRow): FileRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    path: row.path,
    zone: row.zone,
    type: row.type,
    title: row.title,
    content: row.content,
    sha256: row.sha256,
    version: row.version,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
    deleted: row.deleted,
  };
}

export function fileToRow(file: FileRecord): FileRow {
  return {
    id: file.id,
    workspace_id: file.workspaceId,
    path: file.path,
    zone: file.zone,
    type: file.type,
    title: file.title,
    content: file.content,
    sha256: file.sha256,
    version: file.version,
    updated_by: file.updatedBy,
    updated_at: file.updatedAt,
    deleted: file.deleted,
  };
}

export function rowToFileVersion(row: FileVersionRow): FileVersion {
  return {
    id: row.id,
    fileId: row.file_id,
    version: row.version,
    content: row.content,
    sha256: row.sha256,
    updatedBy: row.updated_by,
    authorId: row.author_id,
    changeSetId: row.change_set_id,
    createdAt: row.created_at,
  };
}

export function fileVersionToRow(version: FileVersion): FileVersionRow {
  return {
    id: version.id,
    file_id: version.fileId,
    version: version.version,
    content: version.content,
    sha256: version.sha256,
    updated_by: version.updatedBy,
    author_id: version.authorId,
    change_set_id: version.changeSetId,
    created_at: version.createdAt,
  };
}

export function rowToChangeSet(row: ChangeSetRow): ChangeSet {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    summary: row.summary,
    sourceEvent: row.source_event,
    authorId: row.author_id,
    createdAt: row.created_at,
    reverted: row.reverted,
  };
}

export function changeSetToRow(changeSet: ChangeSet): ChangeSetRow {
  return {
    id: changeSet.id,
    workspace_id: changeSet.workspaceId,
    kind: changeSet.kind,
    summary: changeSet.summary,
    source_event: changeSet.sourceEvent,
    author_id: changeSet.authorId,
    created_at: changeSet.createdAt,
    reverted: changeSet.reverted,
  };
}

export function rowToFileChange(row: FileChangeRow): FileChange {
  return {
    id: row.id,
    changeSetId: row.change_set_id,
    fileId: row.file_id,
    op: row.op,
    beforeVersion: row.before_version,
    afterVersion: row.after_version,
    diff: row.diff,
  };
}

export function fileChangeToRow(change: FileChange): FileChangeRow {
  return {
    id: change.id,
    change_set_id: change.changeSetId,
    file_id: change.fileId,
    op: change.op,
    before_version: change.beforeVersion,
    after_version: change.afterVersion,
    diff: change.diff,
  };
}

export function rowToWorkspaceMember(row: WorkspaceMemberRow): WorkspaceMember {
  return {
    workspaceId: row.workspace_id,
    userId: row.user_id,
    role: row.role,
    createdAt: row.created_at,
  };
}

export function workspaceMemberToRow(member: WorkspaceMember): WorkspaceMemberRow {
  return {
    workspace_id: member.workspaceId,
    user_id: member.userId,
    role: member.role,
    created_at: member.createdAt,
  };
}

export function rowToWorkspaceInvite(row: WorkspaceInviteRow): WorkspaceInvite {
  return {
    id: row.id,
    token: row.token,
    workspaceId: row.workspace_id,
    invitedEmail: row.invited_email,
    expiresAt: row.expires_at,
    redeemedBy: row.redeemed_by,
    createdAt: row.created_at,
  };
}

export function rowToPrivacyRule(row: PrivacyRuleRow): PrivacyRuleRecord {
  return {
    workspaceId: row.workspace_id,
    path: row.path,
    target: row.target,
    mode: row.mode,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
    deleted: row.deleted,
    source: "cloud",
  };
}

export function privacyRuleToRow(rule: PrivacyRuleRecord): PrivacyRuleRow {
  if (rule.mode === "local-only") {
    throw new Error("local-only privacy rules are local-only and cannot be serialized to Postgres");
  }
  return {
    workspace_id: rule.workspaceId,
    path: rule.path,
    target: rule.target,
    mode: rule.mode,
    updated_by: rule.updatedBy,
    updated_at: rule.updatedAt,
    deleted: rule.deleted,
  };
}

export function workspaceInviteToRow(invite: WorkspaceInvite): WorkspaceInviteRow {
  return {
    id: invite.id,
    token: invite.token,
    workspace_id: invite.workspaceId,
    invited_email: invite.invitedEmail,
    expires_at: invite.expiresAt,
    redeemed_by: invite.redeemedBy,
    created_at: invite.createdAt,
  };
}

export function rowToAsset(row: AssetRow): Asset {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    storagePath: row.storage_path,
    mime: row.mime,
    sha256: row.sha256,
    createdAt: row.created_at,
  };
}

export function assetToRow(asset: Asset): AssetRow {
  return {
    id: asset.id,
    workspace_id: asset.workspaceId,
    storage_path: asset.storagePath,
    mime: asset.mime,
    sha256: asset.sha256,
    created_at: asset.createdAt,
  };
}
