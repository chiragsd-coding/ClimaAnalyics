/**
 * Billing provider abstraction (env-selected: Stripe or Razorpay).
 *
 * The owner connects real credentials via environment variables only — nothing
 * is ever hardcoded or committed (see .env.example at the repo root). When the
 * selected provider's credentials are absent or clearly dummy, billing is in
 * an honest "being connected" state: no checkout URL is fabricated and no tier
 * ever changes without a signature-verified provider webhook.
 *
 * Providers are implemented over plain fetch REST calls (no SDK dependency),
 * consistent with the other integrations in this codebase.
 */
import type { SafeUser } from "~/lib/auth";
import { db } from "~/lib/db";
import { createStripeProvider } from "./stripe";
import { createRazorpayProvider } from "./razorpay";
// Re-export implementations so consumers can import the whole gateway from here.
export { createStripeProvider, createRazorpayProvider };

export type ProviderId = "stripe" | "razorpay";

/** A hosted checkout for Pro, hosted by the payment provider. */
export type CheckoutResult = { provider: ProviderId; url: string };

/** Webhook inputs/outputs shared by every provider implementation. */
export type WebhookEvent = {
  /** Provider event id — used for idempotent storage (may be synthesized). */
  id: string;
  type: string;
  payload: Record<string, unknown>;
};
export type WebhookVerification =
  | { ok: true; event: WebhookEvent }
  | { ok: false; reason: string };

export interface BillingProvider {
  id: ProviderId;
  /** Create a provider-hosted checkout session for the Pro plan. */
  createCheckoutSession(user: SafeUser, origin: string): Promise<CheckoutResult>;
  /** Verify the webhook signature over the RAW body. Never trusts parsed JSON alone. */
  verifyWebhook(rawBody: string, signature: string | null): WebhookVerification;
}

// ---------------------------------------------------------------------------
// Env-selected configuration (names documented in .env.example — never values)
// ---------------------------------------------------------------------------

/** Required env var names per provider, in one place for honest diagnostics. */
export const BILLING_ENV_VARS: Record<ProviderId, string[]> = {
  stripe: ["STRIPE_SECRET_KEY", "STRIPE_PRICE_ID", "STRIPE_WEBHOOK_SECRET"],
  razorpay: ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"],
};

/**
 * A value counts as configured only when it is non-empty and not an obvious
 * placeholder (e.g. `DUMMY_STRIPE_SECRET_KEY`). Real test-mode keys from the
 * provider (e.g. `sk_test_…`) are real credentials and are accepted.
 */
export function isConfiguredValue(v: string | undefined | null): boolean {
  if (!v || !v.trim()) return false;
  return !/^DUMMY_/i.test(v.trim());
}

export type ResolvedBilling =
  | { provider: BillingProvider }
  | { provider: null; reason: string };

/**
 * Resolve the active provider from an env-like record. Called per-request so
 * the owner can enable billing by adding env vars — no code change, no
 * restart-dependent module state.
 *
 * Selection rules:
 *  - BILLING_PROVIDER must be exactly "stripe" or "razorpay" (default: none).
 *  - All env vars for that provider must be present and non-dummy; otherwise
 *    billing stays disabled with a reason naming the missing var(s).
 */
export function resolveBillingProvider(
  env: Record<string, string | undefined> = process.env
): ResolvedBilling {
  const id = (env.BILLING_PROVIDER ?? "").trim().toLowerCase();
  if (!id) {
    return { provider: null, reason: "BILLING_PROVIDER is not set — payments are not connected." };
  }
  if (id !== "stripe" && id !== "razorpay") {
    return {
      provider: null,
      reason: "BILLING_PROVIDER must be \"stripe\" or \"razorpay\" — payments are not connected.",
    };
  }
  const missing = BILLING_ENV_VARS[id].filter((name) => !isConfiguredValue(env[name]));
  if (missing.length > 0) {
    return {
      provider: null,
      reason: `Payments are not connected: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing or a placeholder.`,
    };
  }
  const provider: BillingProvider =
    id === "stripe"
      ? createStripeProvider({
          secretKey: env.STRIPE_SECRET_KEY!,
          priceId: env.STRIPE_PRICE_ID!,
          webhookSecret: env.STRIPE_WEBHOOK_SECRET!,
        })
      : createRazorpayProvider({
          keyId: env.RAZORPAY_KEY_ID!,
          keySecret: env.RAZORPAY_KEY_SECRET!,
          webhookSecret: env.RAZORPAY_WEBHOOK_SECRET!,
          currency: (env.RAZORPAY_CURRENCY ?? "INR").trim().toUpperCase() || "INR",
        });
  return { provider };
}

// ---------------------------------------------------------------------------
// Webhook → tier upgrade (the only path that can flip a user to Pro)
// ---------------------------------------------------------------------------

/** Error thrown when a configured provider rejects a request (network/5xx/4xx). */
export class BillingProviderError extends Error {}

/**
 * Which checkout/event payload identifies the paying user + subscription,
 * per provider. Both implementations stamp the internal user id into the
 * checkout session at creation time and read it back here.
 */
export type UpgradeIntent = {
  userId: number;
  customerId: string | null;
  subscriptionId: string | null;
};

function parseUserIdFromRef(raw: unknown): number | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const m = String(raw).match(/climascope-pro-user-(\d+)$/) ?? String(raw).match(/^(\d+)$/);
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Stripe: `checkout.session.completed` upgrades; `customer.subscription.deleted` downgrades. */
export function stripeUpgradeIntent(event: WebhookEvent): UpgradeIntent | null {
  if (event.type === "checkout.session.completed") {
    const session = asObj((event.payload as { data?: { object?: unknown } }).data?.object);
    const userId = parseUserIdFromRef(session?.client_reference_id ?? session?.metadata?.user_id);
    if (userId === null) return null;
    return {
      userId,
      customerId: str(session?.customer),
      subscriptionId: str(session?.subscription),
    };
  }
  return null;
}

/** Razorpay: a paid payment link upgrades the user recorded in reference_id/notes. */
export function razorpayUpgradeIntent(event: WebhookEvent): UpgradeIntent | null {
  if (event.type === "payment_link.paid") {
    const entity = asObj(
      (event.payload as { payload?: { payment_link?: { entity?: unknown } } }).payload?.payment_link
        ?.entity
    );
    const notes = asObj(entity?.notes);
    const userId =
      parseUserIdFromRef(entity?.reference_id) ?? parseUserIdFromRef(notes?.user_id);
    if (userId === null) return null;
    return { userId, customerId: str(entity?.customer_id), subscriptionId: null };
  }
  return null;
}

/**
 * Apply a verified upgrade: set tier=pro, record provider/customer/subscription
 * ids, and store the raw event for idempotency. Returns the affected user id,
 * or null when the event is a duplicate (already processed).
 */
export function applyProUpgrade(
  providerId: ProviderId,
  event: WebhookEvent,
  intent: UpgradeIntent
): { userId: number; duplicate: boolean } | null {
  const existing = db
    .query<{ id: number }, [string, string]>(
      "SELECT id FROM billing_events WHERE provider = ? AND event_id = ?"
    )
    .get(providerId, event.id);
  if (existing) return { userId: intent.userId, duplicate: true };

  db.run(
    `UPDATE users SET tier = 'pro', billing_provider = ?, billing_customer_id = ?,
       billing_subscription_id = ?, billing_updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
     WHERE id = ?`,
    [providerId, intent.customerId ?? "", intent.subscriptionId ?? "", intent.userId]
  );
  db.run(
    `INSERT INTO billing_events (provider, event_id, event_type, user_id, payload) VALUES (?, ?, ?, ?, ?)`,
    [providerId, event.id, event.type, intent.userId, JSON.stringify(event.payload)]
  );
  return { userId: intent.userId, duplicate: false };
}

/** Verify + apply a webhook end-to-end for the given provider path. */
export function handleBillingWebhook(
  providerId: string,
  rawBody: string,
  signature: string | null
): { ok: true; handled: boolean; userId?: number } | { ok: false; reason: string } {
  if (providerId !== "stripe" && providerId !== "razorpay") {
    return { ok: false, reason: "Unknown billing provider." };
  }
  const resolved = resolveBillingProvider();
  const webhookSecretVar = providerId === "stripe" ? "STRIPE_WEBHOOK_SECRET" : "RAZORPAY_WEBHOOK_SECRET";
  // Webhook verification only needs the provider's webhook secret; checkout
  // credentials are irrelevant here so signature checks stay testable.
  const provider: BillingProvider =
    providerId === "stripe"
      ? createStripeProvider({ secretKey: "unused", priceId: "unused", webhookSecret: process.env[webhookSecretVar] ?? "" })
      : createRazorpayProvider({
          keyId: "unused",
          keySecret: "unused",
          webhookSecret: process.env[webhookSecretVar] ?? "",
          currency: "INR",
        });
  const result = provider.verifyWebhook(rawBody, signature);
  if (!result.ok) return result;
  if (resolved.provider && resolved.provider.id !== providerId) {
    return { ok: false, reason: `Webhook provider "${providerId}" does not match BILLING_PROVIDER.` };
  }
  if (!resolved.provider) {
    // Placeholder/dummy credentials: there is no real payment channel, so even
    // a signature that verifies (e.g. signed with a committed placeholder
    // secret) proves nothing about money having moved. Never upgrade a tier
    // while the gateway is not fully configured with real credentials.
    return { ok: false, reason: resolved.reason };
  }
  const intent = providerId === "stripe" ? stripeUpgradeIntent(result.event) : razorpayUpgradeIntent(result.event);
  if (!intent) return { ok: true, handled: false }; // verified event we don't act on
  const applied = applyProUpgrade(providerId, result.event, intent);
  return { ok: true, handled: true, userId: applied?.userId };
}

// ---------------------------------------------------------------------------
// Small JSON helpers (no deps)
// ---------------------------------------------------------------------------
function asObj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}
