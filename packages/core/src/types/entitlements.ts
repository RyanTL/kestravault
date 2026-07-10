import type { IsoTimestamp, Uuid } from "./ids.js";

/**
 * Paid cloud+sync entitlements (plan/sync-collab-open-core.md §2 "Entitlement"
 * + the 2026-07-03 vault-cap decision). Mirrors the `user_entitlements` /
 * `instance_config` tables in supabase/migrations/20260703160000_entitlements.sql.
 *
 * The model: the OWNER pays for the cloud. One plan covers hosting/sync for all
 * of that owner's cloud vaults — personal and shared — up to
 * {@link CLOUD_VAULT_CAP}. Members of a shared vault ride free (account + their
 * own AI key). Self-hosted instances bypass every entitlement check.
 */

/** `active` = paid and current; `lapsed` = subscription ended (read-only). */
export type EntitlementStatus = "active" | "lapsed";

/**
 * Maximum number of cloud vaults (workspaces) one paid plan covers. Enforced
 * server-side by a Postgres trigger; this constant is the client-side mirror
 * for early feedback, never the enforcement.
 */
export const CLOUD_VAULT_CAP = 3;

/** One user's paid cloud+sync plan, as written by the billing webhook. */
export interface UserEntitlement {
  userId: Uuid;
  /** Plan identifier — 'cloud' is the only paid plan today. */
  plan: string;
  status: EntitlementStatus;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  /** End of the already-paid period; active past this instant means lapsed. */
  currentPeriodEnd: IsoTimestamp | null;
  updatedAt: IsoTimestamp;
}
