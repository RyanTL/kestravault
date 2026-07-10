// KestraVault — `billing-webhook` edge function.
//
// The ONLY writer of `public.user_entitlements` (see the entitlements
// migration): Stripe calls this endpoint on subscription lifecycle events and
// we mirror them into the entitlement row that the Postgres triggers/policies
// enforce against (create-vault gate, 3-vault cap, sharing gate, lapsed →
// read-only). Nothing else in the product mutates entitlements.
//
// Event mapping (one paid plan today — 'cloud'):
//   checkout.session.completed                → active (first purchase)
//   customer.subscription.created / .updated  → active while Stripe says
//                                               active/trialing, else lapsed
//   customer.subscription.deleted             → lapsed
//
// The Supabase auth user is resolved from `metadata.user_id` on the
// subscription (falling back to the checkout session's client_reference_id) —
// the checkout link MUST be created with those set (see NEEDS-RYAN.md).
//
// Secrets (set via `supabase secrets set`, never committed):
//   STRIPE_SECRET_KEY       — sk_… (only used to init the SDK for verification)
//   STRIPE_WEBHOOK_SECRET   — whsec_… for THIS endpoint
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — provided by the platform
//
// NOTE: not deployed against a live project at authoring time (needs Ryan's
// Stripe account + price). Runs on Deno (Supabase Edge Runtime).

import Stripe from "npm:stripe@^18";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const cryptoProvider = Stripe.createSubtleCryptoProvider();

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  const signature = req.headers.get("stripe-signature");
  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  const apiKey = Deno.env.get("STRIPE_SECRET_KEY");
  if (!signature || !webhookSecret || !apiKey) {
    return json({ error: "webhook not configured" }, 500);
  }

  const stripe = new Stripe(apiKey);
  let event: Stripe.Event;
  try {
    // Async variant — SubtleCrypto is async-only on the edge runtime.
    event = await stripe.webhooks.constructEventAsync(
      await req.text(),
      signature,
      webhookSecret,
      undefined,
      cryptoProvider,
    );
  } catch (err) {
    return json({ error: `signature verification failed: ${messageOf(err)}` }, 400);
  }

  const supabase = serviceClient();

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const userId = session.metadata?.user_id ?? session.client_reference_id;
        if (!userId) throw new Error("checkout session has no user_id/client_reference_id");
        // The subscription object carries period end; fetch it when present.
        const subscriptionId =
          typeof session.subscription === "string"
            ? session.subscription
            : (session.subscription?.id ?? null);
        const subscription = subscriptionId
          ? await stripe.subscriptions.retrieve(subscriptionId)
          : null;
        await upsertEntitlement(supabase, {
          userId,
          status: "active",
          customerId: customerIdOf(session.customer),
          subscriptionId,
          currentPeriodEnd: periodEndOf(subscription),
        });
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const subscription = event.data.object;
        const userId = subscription.metadata?.user_id;
        if (!userId) {
          // Without a user mapping there is nothing safe to update; surface it
          // so the misconfigured checkout link gets fixed.
          throw new Error(`subscription ${subscription.id} has no metadata.user_id`);
        }
        const active =
          event.type !== "customer.subscription.deleted" &&
          (subscription.status === "active" || subscription.status === "trialing");
        await upsertEntitlement(supabase, {
          userId,
          status: active ? "active" : "lapsed",
          customerId: customerIdOf(subscription.customer),
          subscriptionId: subscription.id,
          currentPeriodEnd: periodEndOf(subscription),
        });
        break;
      }
      default:
        // Not an event we act on — acknowledge so Stripe stops retrying.
        break;
    }
  } catch (err) {
    return json({ error: messageOf(err) }, 500);
  }

  return json({ received: true });
});

interface EntitlementUpdate {
  userId: string;
  status: "active" | "lapsed";
  customerId: string | null;
  subscriptionId: string | null;
  currentPeriodEnd: string | null;
}

async function upsertEntitlement(
  supabase: SupabaseClient,
  update: EntitlementUpdate,
): Promise<void> {
  const { error } = await supabase.from("user_entitlements").upsert({
    user_id: update.userId,
    plan: "cloud",
    status: update.status,
    stripe_customer_id: update.customerId,
    stripe_subscription_id: update.subscriptionId,
    current_period_end: update.currentPeriodEnd,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(`failed to upsert entitlement: ${error.message}`);
}

function customerIdOf(customer: string | { id: string } | null): string | null {
  if (!customer) return null;
  return typeof customer === "string" ? customer : customer.id;
}

function periodEndOf(subscription: Stripe.Subscription | null): string | null {
  const item = subscription?.items?.data?.[0];
  const end = item?.current_period_end;
  return typeof end === "number" ? new Date(end * 1000).toISOString() : null;
}

function serviceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
