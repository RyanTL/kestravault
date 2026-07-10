import type { IsoTimestamp, Ulid, Uuid } from "./ids.js";
import type { UpdatedBy, Zone } from "./enums.js";

/**
 * Shared-workspace membership (Feature A — plan/sync-collab-open-core.md §2).
 * Mirrors the `workspace_members` / `workspace_invites` tables added in
 * supabase/migrations/20260703000000_workspace_members.sql.
 */

/**
 * The two workspace roles — deliberately only two. The owner holds the paid
 * plan and manages membership; members have equal read/write to sources/,
 * wiki/, notes/. Richer roles are the Teams generalization (O6), not this.
 */
export type MemberRole = "owner" | "member";

/**
 * Maximum number of invited members per workspace (owner + 3 = 4 people).
 * Enforced server-side by a Postgres trigger; this constant is the client-side
 * mirror for early feedback, never the enforcement.
 */
export const WORKSPACE_MEMBER_CAP = 3;

/** One person's membership in a workspace (exactly one owner, ≤3 members). */
export interface WorkspaceMember {
  workspaceId: Ulid;
  /** Supabase auth user id (`auth.users.id`). */
  userId: Uuid;
  role: MemberRole;
  createdAt: IsoTimestamp;
}

/**
 * One member's directory entry: user id resolved to their account email via
 * the `workspace_member_directory` SECURITY DEFINER function (clients cannot
 * read `auth.users` under RLS). Email is null when the account has none.
 */
export interface MemberDirectoryEntry {
  userId: Uuid;
  email: string | null;
}

/**
 * One row of the attributed change feed (`workspace_change_feed`): a committed
 * file version joined with its file's current path/title and the author's
 * email. Agent/system writes have a null author.
 */
export interface ChangeFeedEntry {
  versionId: Ulid;
  fileId: Ulid;
  path: string;
  title: string;
  zone: Zone;
  version: number;
  updatedBy: UpdatedBy;
  authorId: Uuid | null;
  authorEmail: string | null;
  /** True when the file has since been (soft-)deleted. */
  deleted: boolean;
  createdAt: IsoTimestamp;
}

/** A single-use, expiring invite to join a workspace as a member. */
export interface WorkspaceInvite {
  id: Ulid;
  /** App-generated, high-entropy secret — the invite link IS the token. */
  token: string;
  workspaceId: Ulid;
  /** Null = invite-by-link; non-null = redeemable only by that email's account. */
  invitedEmail: string | null;
  expiresAt: IsoTimestamp;
  /** Null until redeemed; set once, never reused (single-use). */
  redeemedBy: Uuid | null;
  createdAt: IsoTimestamp;
}
