/**
 * Billing provider abstraction (env-selected: Stripe, Razorpay or PayPal).
 *
 * The owner connects real credentials via environment variables only — nothing
 * is ever hardcoded or committed (see .env.example at the repo root). When the
 * selected provider's credentials are absent or clearly dummy, billing is in
 * an honest "being connected" state: no checkout URL is fabricated and no tier
 * ever changes without a verified provider webhook.
 *
 * Providers are implemented over plain fetch REST calls (no SDK dependency),
 * consistent with the other integrations in this codebase. Adding a further
 * provider means one new file implementing `BillingProvider`, an entry in
 * PROVIDER_IDS / BILLING_ENV_VARS, and its webhook intent mapping — nothing
 * else in the app is provider-specific.
 */
import type { SafeUser } from "~/lib/auth";
import { db } from "~/lib/db";
import { PLANS } from "~/lib/plans";
import { createStripeProvider } from "./stripe";
import { createRazorpayProvider } from "./razorpay";
import { createPaypalProvider } from "./paypal";
// Re-export implementations so consumers can import the whole gateway from here.
export { createStripeProvider, createRazorpayProvider, createPaypalProvider };

/** Every provider the gateway supports. */
export const PROVIDER_IDS = ["stripe", "razorpay", "paypal"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export function isProviderId(v: string | null | undefined): v is ProviderId {
  return !!v && (PROVIDER_IDS as readonly string[]).includes(v);
}

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

/** Provider webhook headers (PayPal needs the full transmission set). */
export type WebhookHeaders = Headers | Record<string, string | null | undefined> | undefined;

/** Case-insensitive header read that works for Headers and plain records. */
export function readHeader(headers: WebhookHeaders, name: string): string {
  if (!headers) return "";
  const maybeHeaders = headers as Headers;
  if (typeof maybeHeaders.get === "function") return (maybeHeaders.get(name) ?? "").trim();
  for (const [k, v] of Object.entries(headers as Record<string, string | null | undefined>)) {
    if (k.toLowerCase() === name.toLowerCase()) return (v ?? "").trim();
  }
  return "";
}

export interface BillingProvider {
  id: ProviderId;
  /** Create a provider-hosted checkout session for the Pro plan. */
  createCheckoutSession(user: SafeUser, origin: string): Promise<CheckoutResult>;
  /**
   * Verify the webhook proof over the RAW body. Never trusts parsed JSON alone.
   * Stripe/Razorpay check an HMAC locally; PayPal calls its
   * verify-webhook-signature API (hence the async signature).
   */
  verifyWebhook(
    rawBody: string,
    signature: string | null,
    headers?: WebhookHeaders
  ): Promise<WebhookVerification>;
}

// ---------------------------------------------------------------------------
// Env-selected configuration (names documented in .env.example — never values)
// ---------------------------------------------------------------------------

/** Required env var names per provider, in one place for honest diagnostics. */
export const BILLING_ENV_VARS: Record<ProviderId, string[]> = {
  stripe: ["STRIPE_SECRET_KEY", "STRIPE_PRICE_ID", "STRIPE_WEBHOOK_SECRET"],
  razorpay: ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"],
  paypal: ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_WEBHOOK_ID", "PAYPAL_PLAN_ID"],
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

function missingEnvVarsFor(id: ProviderId, env: Record<string, string | undefined>): string[] {
  return BILLING_ENV_VARS[id].filter((name) => !isConfiguredValue(env[name]));
}

/** Build one provider from env values (all already validated by the caller). */
function buildProvider(id: ProviderId, env: Record<string, string | undefined>): BillingProvider {
  switch (id) {
    case "stripe":
      return createStripeProvider({
        secretKey: env.STRIPE_SECRET_KEY!,
        priceId: env.STRIPE_PRICE_ID!,
        webhookSecret: env.STRIPE_WEBHOOK_SECRET!,
      });
    case "razorpay":
      return createRazorpayProvider({
        keyId: env.RAZORPAY_KEY_ID!,
        keySecret: env.RAZORPAY_KEY_SECRET!,
        webhookSecret: env.RAZORPAY_WEBHOOK_SECRET!,
        currency: (env.RAZORPAY_CURRENCY ?? "INR").trim().toUpperCase() || "INR",
      });
    case "paypal":
      return createPaypalProvider({
        clientId: env.PAYPAL_CLIENT_ID!,
        clientSecret: env.PAYPAL_CLIENT_SECRET!,
        webhookId: env.PAYPAL_WEBHOOK_ID!,
        planId: env.PAYPAL_PLAN_ID!,
        apiBase: env.PAYPAL_API_BASE,
      });
  }
}

/**
 * Resolve the active provider from an env-like record. Called per-request so
 * the owner can enable billing by adding env vars — no code change, no
 * restart-dependent module state.
 *
 * Selection rules:
 *  - BILLING_PROVIDER must be exactly "stripe", "razorpay" or "paypal".
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
  if (!isProviderId(id)) {
    return {
      provider: null,
      reason: `BILLING_PROVIDER must be "stripe", "razorpay" or "paypal" — payments are not connected.`,
    };
  }
  const missing = missingEnvVarsFor(id, env);
  if (missing.length > 0) {
    return {
      provider: null,
      reason: `Payments are not connected: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing or a placeholder.`,
    };
  }
  return { provider: buildProvider(id, env) };
}

/** Honest, owner-facing description of the billing configuration. */
export type BillingStatus = {
  /** True only when the selected provider is fully configured with real values. */
  billingEnabled: boolean;
  /** The fully configured provider id (null while anything is missing). */
  provider: ProviderId | null;
  /** BILLING_PROVIDER as a known id, even if its credentials are incomplete. */
  selectedProvider: ProviderId | null;
  /** Exact env var names that are missing or still DUMMY placeholders. */
  missingEnvVars: string[];
  /** Owner-pinned billing note (PLANS.billingNote), extended with the reason. */
  note: string;
  /** Webhook path the selected provider must be pointed at (null when unselected). */
  webhookPath: string | null;
  /** Every provider this build supports. */
  availableProviders: ProviderId[];
};

/**
 * Single source of truth for the billing status surface: which provider is
 * selected, which env vars it still needs, and where its webhook lives. No
 * secret value is ever included.
 */
export function billingStatus(env: Record<string, string | undefined> = process.env): BillingStatus {
  const raw = (env.BILLING_PROVIDER ?? "").trim().toLowerCase();
  const selected = isProviderId(raw) ? raw : null;
  const missing = selected ? missingEnvVarsFor(selected, env) : [];
  const base = {
    availableProviders: [...PROVIDER_IDS],
    selectedProvider: selected,
    webhookPath: selected ? `/api/billing/webhook/${selected}` : null,
  };
  if (selected && missing.length === 0) {
    return {
      ...base,
      billingEnabled: true,
      provider: selected,
      missingEnvVars: [],
      note: `Billing is connected via ${selected} — checkout and verified webhooks are live.`,
    };
  }
  if (selected) {
    return {
      ...base,
      billingEnabled: false,
      provider: null,
      missingEnvVars: missing,
      note: `${PLANS.billingNote} Provider "${selected}" is selected but not connected: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing or a placeholder.`,
    };
  }
  const reason = raw
    ? `BILLING_PROVIDER "${raw}" is not a supported provider (use "stripe", "razorpay" or "paypal").`
    : `Set BILLING_PROVIDER to "stripe", "razorpay" or "paypal" to enable payments.`;
  return {
    ...base,
    billingEnabled: false,
    provider: null,
    missingEnvVars: [],
    note: `${PLANS.billingNote} ${reason}`,
  };
}

// ---------------------------------------------------------------------------
// Webhook → tier upgrade (the only path that can flip a user to Pro)
// ---------------------------------------------------------------------------

/** Error thrown when a configured provider rejects a request (network/5xx/4xx). */
export class BillingProviderError extends Error {}

/**
 * Which checkout/event payload identifies the paying user + subscription,
 * per provider. Every implementation stamps the internal user id into the
 * checkout session at creation time and reads it back here.
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

/** Find the user a subscription was recorded against (renewal/payment events). */
function userIdForSubscription(subscriptionId: string | null): number | null {
  if (!subscriptionId) return null;
  const row = db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE billing_subscription_id = ? LIMIT 1")
    .get(subscriptionId);
  return row?.id ?? null;
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

/** PayPal events that mean "this user has paid for Pro". */
export const PAYPAL_UPGRADE_EVENTS = [
  "BILLING.SUBSCRIPTION.ACTIVATED",
  "PAYMENT.SALE.COMPLETED",
] as const;
/** PayPal events that mean "this user's Pro subscription is no longer active". */
export const PAYPAL_DOWNGRADE_EVENTS = [
  "BILLING.SUBSCRIPTION.CANCELLED",
  "BILLING.SUBSCRIPTION.SUSPENDED",
] as const;

function paypalResource(event: WebhookEvent): Record<string, unknown> | undefined {
  return asObj((event.payload as { resource?: unknown }).resource);
}

/**
 * PayPal: subscription activation or a completed subscription payment upgrades
 * the user stamped in `custom_id` at checkout (falling back to the subscription
 * id already recorded on the user, which is how renewal payments are matched).
 */
export function paypalUpgradeIntent(event: WebhookEvent): UpgradeIntent | null {
  if (!(PAYPAL_UPGRADE_EVENTS as readonly string[]).includes(event.type)) return null;
  const resource = paypalResource(event);
  if (!resource) return null;
  const subscriber = asObj(resource.subscriber);
  const subscriptionId =
    str(resource.billing_agreement_id) ??
    (event.type.startsWith("BILLING.SUBSCRIPTION.") ? str(resource.id) : null);
  const userId =
    parseUserIdFromRef(resource.custom_id) ??
    parseUserIdFromRef(resource.custom) ??
    parseUserIdFromRef(subscriber?.custom_id) ??
    userIdForSubscription(subscriptionId);
  if (userId === null) return null;
  return {
    userId,
    customerId: str(subscriber?.payer_id) ?? str(resource.payer_id),
    subscriptionId,
  };
}

/** PayPal: cancellation/suspension downgrades the subscription's user to Free. */
export function paypalDowngradeIntent(event: WebhookEvent): UpgradeIntent | null {
  if (!(PAYPAL_DOWNGRADE_EVENTS as readonly string[]).includes(event.type)) return null;
  const resource = paypalResource(event);
  if (!resource) return null;
  const subscriber = asObj(resource.subscriber);
  const subscriptionId = str(resource.id) ?? str(resource.billing_agreement_id);
  const userId =
    parseUserIdFromRef(resource.custom_id) ??
    parseUserIdFromRef(resource.custom) ??
    parseUserIdFromRef(subscriber?.custom_id) ??
    userIdForSubscription(subscriptionId);
  if (userId === null) return null;
  return { userId, customerId: str(subscriber?.payer_id), subscriptionId };
}

/** True when this event has already been processed (idempotency guard). */
function alreadyHandled(providerId: ProviderId, eventId: string): boolean {
  return !!db
    .query<{ id: number }, [string, string]>(
      "SELECT id FROM billing_events WHERE provider = ? AND event_id = ?"
    )
    .get(providerId, eventId);
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
  if (alreadyHandled(providerId, event.id)) return { userId: intent.userId, duplicate: true };

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

/**
 * Apply a verified downgrade (cancelled/suspended subscription): back to Free.
 * Billing ids are kept for audit; the event row keeps replays idempotent.
 */
export function applyProDowngrade(
  providerId: ProviderId,
  event: WebhookEvent,
  intent: UpgradeIntent
): { userId: number; duplicate: boolean } | null {
  if (alreadyHandled(providerId, event.id)) return { userId: intent.userId, duplicate: true };

  db.run(
    `UPDATE users SET tier = 'free',
       billing_updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
     WHERE id = ?`,
    [intent.userId]
  );
  db.run(
    `INSERT INTO billing_events (provider, event_id, event_type, user_id, payload) VALUES (?, ?, ?, ?, ?)`,
    [providerId, event.id, event.type, intent.userId, JSON.stringify(event.payload)]
  );
  return { userId: intent.userId, duplicate: false };
}

/**
 * Webhook verification only needs the provider's verification credentials
 * (signing secret / webhook id + client credentials); checkout credentials are
 * irrelevant here, so signature checks stay independent of them.
 */
function webhookVerifier(id: ProviderId, env: Record<string, string | undefined>): BillingProvider {
  switch (id) {
    case "stripe":
      return createStripeProvider({
        secretKey: "unused",
        priceId: "unused",
        webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? "",
      });
    case "razorpay":
      return createRazorpayProvider({
        keyId: "unused",
        keySecret: "unused",
        webhookSecret: env.RAZORPAY_WEBHOOK_SECRET ?? "",
        currency: "INR",
      });
    case "paypal":
      return createPaypalProvider({
        clientId: env.PAYPAL_CLIENT_ID ?? "",
        clientSecret: env.PAYPAL_CLIENT_SECRET ?? "",
        webhookId: env.PAYPAL_WEBHOOK_ID ?? "",
        planId: env.PAYPAL_PLAN_ID ?? "",
        apiBase: env.PAYPAL_API_BASE,
      });
  }
}

/** Which upgrade event types each provider acts on (unknown types are ignored). */
function upgradeIntentFor(providerId: ProviderId, event: WebhookEvent): UpgradeIntent | null {
  switch (providerId) {
    case "stripe":
      return stripeUpgradeIntent(event);
    case "razorpay":
      return razorpayUpgradeIntent(event);
    case "paypal":
      return paypalUpgradeIntent(event);
  }
}

/** Verify + apply a webhook end-to-end for the given provider path. */
export async function handleBillingWebhook(
  providerId: string,
  rawBody: string,
  signature: string | null,
  headers?: WebhookHeaders
): Promise<
  | { ok: true; handled: boolean; userId?: number; action?: "upgrade" | "downgrade" }
  | { ok: false; reason: string }
> {
  if (!isProviderId(providerId)) {
    return { ok: false, reason: "Unknown billing provider." };
  }
  const provider = webhookVerifier(providerId, process.env);
  const result = await provider.verifyWebhook(rawBody, signature, headers);
  if (!result.ok) return result;

  const resolved = resolveBillingProvider();
  if (resolved.provider && resolved.provider.id !== providerId) {
    return { ok: false, reason: `Webhook provider "${providerId}" does not match BILLING_PROVIDER.` };
  }
  if (!resolved.provider) {
    // Placeholder/dummy credentials: there is no real payment channel, so even
    // a webhook that verifies (e.g. signed with a committed placeholder secret,
    // or a sandbox verifier echoing SUCCESS) proves nothing about money having
    // moved. Never change a tier while the gateway is not fully configured.
    return { ok: false, reason: resolved.reason };
  }

  const upgrade = upgradeIntentFor(providerId, result.event);
  if (upgrade) {
    const applied = applyProUpgrade(providerId, result.event, upgrade);
    return { ok: true, handled: true, userId: applied?.userId, action: "upgrade" };
  }
  const downgrade = providerId === "paypal" ? paypalDowngradeIntent(result.event) : null;
  if (downgrade) {
    const applied = applyProDowngrade(providerId, result.event, downgrade);
    return { ok: true, handled: true, userId: applied?.userId, action: "downgrade" };
  }
  return { ok: true, handled: false }; // verified event we don't act on
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
