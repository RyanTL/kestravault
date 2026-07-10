import type { PostgrestError } from "@supabase/supabase-js";
import type { UserEntitlement } from "../types/entitlements.js";
import type { IsoTimestamp, Uuid } from "../types/ids.js";
import type { KestravaultSupabaseClient } from "./client.js";
import { TABLE } from "./database.types.js";
import type { UserEntitlementRow } from "./database.types.js";

/**
 * Entitlement reads for the clients (self-contained module, same shape as
 * ./publishing.ts). Writes happen ONLY server-side: the Stripe billing webhook
 * (supabase/functions/billing-webhook) updates `user_entitlements` under the
 * service role, and enforcement lives in Postgres triggers/policies — these
 * repos exist so the apps can *display* plan state and fail fast in the UI,
 * never as the enforcement.
 */

export interface EntitlementRepo {
  /** The caller's own entitlement row, or null if they never subscribed. */
  getForUser(userId: Uuid): Promise<UserEntitlement | null>;
  /**
   * Server-truth answer to "does this user hold an active paid plan?" —
   * true on self-hosted instances regardless of entitlement rows.
   */
  hasActivePlan(userId: Uuid): Promise<boolean>;
  /**
   * Redeem a single-use lifetime access code for the SIGNED-IN user (the
   * server derives the beneficiary from auth.uid(), never from an argument).
   * Rejects with the server's message when the code is invalid or spent.
   */
  redeemLifetimeCode(code: string): Promise<void>;
}

// --- mappers ------------------------------------------------------------------

export function rowToUserEntitlement(row: UserEntitlementRow): UserEntitlement {
  return {
    userId: row.user_id,
    plan: row.plan,
    status: row.status,
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    currentPeriodEnd: row.current_period_end,
    updatedAt: row.updated_at,
  };
}

export function userEntitlementToRow(entitlement: UserEntitlement): UserEntitlementRow {
  return {
    user_id: entitlement.userId,
    plan: entitlement.plan,
    status: entitlement.status,
    stripe_customer_id: entitlement.stripeCustomerId,
    stripe_subscription_id: entitlement.stripeSubscriptionId,
    current_period_end: entitlement.currentPeriodEnd,
    updated_at: entitlement.updatedAt,
  };
}

// --- in-memory (tests / local dev) --------------------------------------------

export class InMemoryEntitlementRepo implements EntitlementRepo {
  private readonly byUser = new Map<Uuid, UserEntitlement>();
  private readonly unredeemedCodes = new Set<string>();

  /** Stand-in for auth.uid(): who redeemLifetimeCode grants to. Tests set it. */
  actingUserId: Uuid | null = null;

  /** `selfHosted` mirrors instance_config.self_hosted; `now` is injectable. */
  constructor(
    private readonly selfHosted = false,
    private readonly now: () => IsoTimestamp = () => new Date().toISOString(),
  ) {}

  /** Test/webhook seam — the production writer is the billing webhook. */
  set(entitlement: UserEntitlement): void {
    this.byUser.set(entitlement.userId, structuredClone(entitlement));
  }

  /** Test seam — register a mintable code (the server does this at mint time). */
  addCode(code: string): void {
    this.unredeemedCodes.add(normalizeLifetimeCode(code));
  }

  async getForUser(userId: Uuid): Promise<UserEntitlement | null> {
    const found = this.byUser.get(userId);
    return found ? structuredClone(found) : null;
  }

  async hasActivePlan(userId: Uuid): Promise<boolean> {
    if (this.selfHosted) return true;
    const entitlement = this.byUser.get(userId);
    if (!entitlement || entitlement.status !== "active") return false;
    return (
      entitlement.currentPeriodEnd === null || entitlement.currentPeriodEnd > this.now()
    );
  }

  async redeemLifetimeCode(code: string): Promise<void> {
    if (!this.actingUserId) throw new Error("redeeming a code requires a signed-in user");
    const normalized = normalizeLifetimeCode(code);
    if (!normalized || !this.unredeemedCodes.has(normalized)) {
      throw new Error("invalid or already redeemed code");
    }
    this.unredeemedCodes.delete(normalized); // single-use
    this.byUser.set(this.actingUserId, {
      userId: this.actingUserId,
      plan: "lifetime",
      status: "active",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      currentPeriodEnd: null,
      updatedAt: this.now(),
    });
  }
}

/** Same normalization the server applies (normalize_lifetime_code). */
export function normalizeLifetimeCode(raw: string): string {
  return raw.replace(/\s/g, "").toUpperCase();
}

// --- Supabase (production) -----------------------------------------------------

function fail(context: string, error: PostgrestError): never {
  throw new Error(`Supabase ${context} failed: ${error.message}`);
}

export class SupabaseEntitlementRepo implements EntitlementRepo {
  constructor(private readonly client: KestravaultSupabaseClient) {}

  async getForUser(userId: Uuid): Promise<UserEntitlement | null> {
    const { data, error } = await this.client
      .from(TABLE.userEntitlements)
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) fail("user_entitlements.getForUser", error);
    return data ? rowToUserEntitlement(data) : null;
  }

  async hasActivePlan(userId: Uuid): Promise<boolean> {
    // The SECURITY DEFINER check the triggers/policies use, so the answer
    // matches enforcement exactly (including the self-hosted bypass).
    const { data, error } = await this.client.rpc("user_has_active_plan", {
      uid: userId,
    });
    if (error) fail("user_has_active_plan", error);
    return data === true;
  }

  async redeemLifetimeCode(code: string): Promise<void> {
    // SECURITY DEFINER RPC: claims the code atomically and upserts the
    // caller's entitlement — see the lifetime_codes migration.
    const { error } = await this.client.rpc("redeem_lifetime_code", {
      access_code: normalizeLifetimeCode(code),
    });
    if (error) fail("redeem_lifetime_code", error);
  }
}
