import type {
  ChangeSetKind,
  FileOp,
  FileType,
  UpdatedBy,
  Zone,
} from "../types/enums.js";
import type { MemberRole } from "../types/members.js";
import type { CloudPrivacyMode, PrivacyTarget } from "../privacy/index.js";

/**
 * Postgres-shaped (snake_case) row types for the canonical tables sketched in
 * plan/data-model.md. These mirror what `@supabase/supabase-js` returns over the
 * wire; the camelCase domain shapes live in ../types/entities.ts and the two are
 * bridged by ./mappers.ts.
 *
 * The eventual source of truth is the SQL migrations under `supabase/`; until
 * those land (and `supabase gen types` can replace this file), this hand-written
 * `Database` type gives the client wrapper its typed `.from(...)` surface.
 */

// NOTE: these are `type` aliases, NOT `interface`s. supabase-js requires each
// table's `Row` to satisfy `Record<string, unknown>`; a TS `interface` (which is
// open to declaration merging) is not assignable to that, so an interface here
// would silently collapse the whole typed `Database` to `never`. Object-literal
// type aliases carry an implicit index signature and satisfy the constraint.

export type WorkspaceRow = {
  id: string;
  owner_id: string;
  name: string;
  created_at: string;
  config: Record<string, unknown>;
};

export type FileRow = {
  id: string;
  workspace_id: string;
  path: string;
  zone: Zone;
  type: FileType;
  title: string;
  content: string;
  sha256: string;
  version: number;
  updated_by: UpdatedBy;
  updated_at: string;
  deleted: boolean;
};

export type FileVersionRow = {
  id: string;
  file_id: string;
  version: number;
  content: string;
  sha256: string;
  updated_by: UpdatedBy;
  author_id: string | null;
  change_set_id: string | null;
  created_at: string;
};

export type ChangeSetRow = {
  id: string;
  workspace_id: string;
  kind: ChangeSetKind;
  summary: string;
  source_event: Record<string, unknown> | null;
  author_id: string | null;
  created_at: string;
  reverted: boolean;
};

export type FileChangeRow = {
  id: string;
  change_set_id: string;
  file_id: string;
  op: FileOp;
  before_version: number | null;
  after_version: number | null;
  diff: string;
};

export type WorkspaceMemberRow = {
  workspace_id: string;
  user_id: string;
  role: MemberRole;
  created_at: string;
};

export type WorkspaceInviteRow = {
  id: string;
  token: string;
  workspace_id: string;
  invited_email: string | null;
  expires_at: string;
  redeemed_by: string | null;
  created_at: string;
};

export type AssetRow = {
  id: string;
  workspace_id: string;
  storage_path: string;
  mime: string;
  sha256: string;
  created_at: string;
};

/** One user's paid cloud+sync plan — see the entitlements migration. */
export type UserEntitlementRow = {
  user_id: string;
  plan: string;
  status: "active" | "lapsed";
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_end: string | null;
  updated_at: string;
};

/** Single-row instance config (self-hosted flag) — entitlements migration. */
export type InstanceConfigRow = {
  id: boolean;
  self_hosted: boolean;
};

/** Per-note publish state (Feature B) — see the note_publishing migration. */
export type NotePublicationRow = {
  file_id: string;
  workspace_id: string;
  published: boolean;
  public_token: string;
  published_at: string;
};

/** Path-level privacy rules synced through the workspace. `local-only` never
 *  appears here; it stays in the local `.kestravault/privacy.local.json`. */
export type PrivacyRuleRow = {
  workspace_id: string;
  path: string;
  target: PrivacyTarget;
  mode: CloudPrivacyMode;
  updated_by: string | null;
  updated_at: string;
  deleted: boolean;
};

/**
 * The narrow projection the `fetch_published_note` RPC returns to anonymous
 * readers — deliberately no ids, paths, versions, or authorship.
 */
export type PublishedNoteRow = {
  title: string;
  content: string;
  published_at: string;
  updated_at: string;
};

/**
 * One member resolved to an email — what `workspace_member_directory` returns
 * (see the member_directory migration).
 */
export type MemberDirectoryRow = {
  user_id: string;
  email: string | null;
};

/**
 * One attributed change-feed row — what `workspace_change_feed` returns: a
 * committed file version joined with file context and the author's email.
 */
export type ChangeFeedRow = {
  version_id: string;
  file_id: string;
  path: string;
  title: string;
  zone: Zone;
  version: number;
  updated_by: UpdatedBy;
  author_id: string | null;
  author_email: string | null;
  deleted: boolean;
  created_at: string;
};

/**
 * Helper that expands a row type into the `{ Row, Insert, Update, Relationships }`
 * shape the supabase-js generic expects. `Insert`/`Update` are intentionally just
 * the row shape (and a partial of it) — good enough for typed reads/writes here.
 */
interface TableShape<Row> {
  Row: Row;
  Insert: Row;
  Update: Partial<Row>;
  Relationships: [];
}

/** The generic argument for `createClient<Database>` — see ./client.ts. */
export interface Database {
  public: {
    Tables: {
      workspaces: TableShape<WorkspaceRow>;
      files: TableShape<FileRow>;
      file_versions: TableShape<FileVersionRow>;
      change_sets: TableShape<ChangeSetRow>;
      file_changes: TableShape<FileChangeRow>;
      assets: TableShape<AssetRow>;
      note_publications: TableShape<NotePublicationRow>;
      privacy_rules: TableShape<PrivacyRuleRow>;
      workspace_members: TableShape<WorkspaceMemberRow>;
      workspace_invites: TableShape<WorkspaceInviteRow>;
      user_entitlements: TableShape<UserEntitlementRow>;
      instance_config: TableShape<InstanceConfigRow>;
    };
    // Empty object types (NOT `Record<string, never>`, which would inject a
    // `[key: string]: never` index signature and poison every table lookup) —
    // this matches what `supabase gen types` emits for unused schema sections.
    Views: { [_ in never]: never };
    Functions: {
      // Token-gated anonymous read path for published notes (Feature B).
      fetch_published_note: {
        Args: { note_token: string };
        Returns: PublishedNoteRow[];
      };
      // Invite redemption is a SECURITY DEFINER function (the redeemer is not
      // yet a member, so RLS hides the invite row) — see the members migration.
      redeem_workspace_invite: {
        Args: { invite_token: string };
        Returns: WorkspaceMemberRow;
      };
      // Atomic optimistic-concurrency commit (file update + version append) —
      // the sync engine's only write path; see the sync_commit migration.
      commit_file_version: {
        Args: {
          p_file_id: string;
          p_workspace_id: string;
          p_path: string;
          p_zone: Zone;
          p_type: FileType;
          p_title: string;
          p_content: string;
          p_sha256: string;
          p_expected_version: number;
          p_updated_by: UpdatedBy;
          p_deleted: boolean;
          p_version_id: string;
          p_author_id: string | null;
          p_change_set_id: string | null;
        };
        Returns: FileRow;
      };
      // Entitlement check the triggers/policies use (self-host aware) — see
      // the entitlements migration.
      user_has_active_plan: {
        Args: { uid: string };
        Returns: boolean;
      };
      // Single-use lifetime access code → active 'lifetime' entitlement for
      // the caller (pre-Stripe beta) — see the lifetime_codes migration.
      redeem_lifetime_code: {
        Args: { access_code: string };
        Returns: boolean;
      };
      // Member id -> email resolution (clients cannot read auth.users under
      // RLS) — see the member_directory migration.
      workspace_member_directory: {
        Args: { ws_id: string };
        Returns: MemberDirectoryRow[];
      };
      // Attributed change feed: recent file versions with file context and
      // author email — see the member_directory migration.
      workspace_change_feed: {
        Args: { ws_id: string; max_rows?: number };
        Returns: ChangeFeedRow[];
      };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
}

/** Names of the canonical tables, handy for callers building queries. */
export const TABLE = {
  workspaces: "workspaces",
  files: "files",
  fileVersions: "file_versions",
  changeSets: "change_sets",
  fileChanges: "file_changes",
  assets: "assets",
  notePublications: "note_publications",
  privacyRules: "privacy_rules",
  workspaceMembers: "workspace_members",
  workspaceInvites: "workspace_invites",
  userEntitlements: "user_entitlements",
  instanceConfig: "instance_config",
} as const;
