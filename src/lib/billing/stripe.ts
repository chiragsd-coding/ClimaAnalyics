/**
 * Stripe provider — implemented over the Stripe REST API with plain fetch
 * (no SDK dependency, consistent with this codebase's other integrations).
 *
 * Credentials come exclusively from env (see .env.example). Never logs or
 * returns secret values.
 */
import { PRO_PRICE_MONTHLY } from "~/lib/plans";
import type { SafeUser } from "~/lib/auth";
import {
  BillingProviderError,
  type BillingProvider,
  type CheckoutResult,
  type WebhookEvent,
  type WebhookVerification,
} from "./index";
import { createHmac, timingSafeEqual } from "node:crypto";

const STRIPE_API = "https://api.stripe.com/v1";
/** Signed webhook timestamps older than this are rejected (replay protection). */
const MAX_CLOCK_SKEW_SECONDS = 300;

export function computeStripeSignature(
  webhookSecret: string,
  timestampSeconds: number,
  rawBody: string
): string {
  return createHmac("sha256", webhookSecret)
    .update(`${timestampSeconds}.${rawBody}`)
    .digest("hex");
}

export function createStripeProvider(config: {
  secretKey: string;
  priceId: string;
  webhookSecret: string;
}): BillingProvider {
  return {
    id: "stripe",

    async createCheckoutSession(user: SafeUser, origin: string): Promise<CheckoutResult> {
      // Amount stays the single source of truth (PLANS / PRO_PRICE_MONTHLY).
      // Stripe Checkout is priced by a pre-created recurring Price object
      // (STRIPE_PRICE_ID); the owner creates it at $99/month in their
      // dashboard — the unit amount itself is not sent here.
      const body = new URLSearchParams({
        mode: "subscription",
        "line_items[0][quantity]": "1",
        "line_items[0][price]": config.priceId,
        customer_email: user.email,
        client_reference_id: `climascope-pro-user-${user.id}`,
        "metadata[user_id]": String(user.id),
        "metadata[plan]": "pro",
        "subscription_data[metadata][user_id]": String(user.id),
        success_url: `${origin}/dashboard?billing=success&provider=stripe`,
        cancel_url: `${origin}/dashboard?billing=cancelled&provider=stripe`,
      });
      let res: Response;
      try {
        res = await fetch(`${STRIPE_API}/checkout/sessions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.secretKey}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: body.toString(),
        });
      } catch {
        throw new BillingProviderError("Stripe is unreachable — checkout could not be created.");
      }
      const json = (await res.json().catch(() => null)) as {
        url?: string;
        error?: { message?: string };
      } | null;
      if (!res.ok || !json?.url) {
        // Provider-side failure: report it, never fabricate a success/URL.
        throw new BillingProviderError(
          `Stripe checkout failed (${res.status})${json?.error?.message ? `: ${json.error.message}` : "."}`
        );
      }
      return { provider: "stripe", url: json.url };
    },

    verifyWebhook(rawBody: string, signature: string | null): WebhookVerification {
      if (!config.webhookSecret) {
        return { ok: false, reason: "STRIPE_WEBHOOK_SECRET is not configured." };
      }
      const header = signature ?? "";
      const parts = new Map<string, string>();
      for (const piece of header.split(",")) {
        const idx = piece.indexOf("=");
        if (idx !== -1) parts.set(piece.slice(0, idx).trim(), piece.slice(idx + 1).trim());
      }
      const t = parts.get("t");
      const v1 = parts.get("v1");
      if (!t || !v1 || !/^\d+$/.test(t)) {
        return { ok: false, reason: "Missing or malformed Stripe-Signature header." };
      }
      const age = Math.floor(Date.now() / 1000) - Number(t);
      if (Math.abs(age) > MAX_CLOCK_SKEW_SECONDS) {
        return { ok: false, reason: "Stripe signature timestamp is outside the allowed window." };
      }
      const expected = computeStripeSignature(config.webhookSecret, Number(t), rawBody);
      const a = Buffer.from(expected, "hex");
      const b = Buffer.from(v1, "hex");
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        return { ok: false, reason: "Stripe webhook signature verification failed." };
      }
      const parsed = safeJson(rawBody);
      if (!parsed || typeof parsed.type !== "string") {
        return { ok: false, reason: "Webhook payload is not a Stripe event." };
      }
      const event: WebhookEvent = {
        id: typeof parsed.id === "string" && parsed.id ? parsed.id : `stripe:${parsed.type}`,
        type: parsed.type,
        payload: parsed,
      };
      return { ok: true, event };
    },
  };
}

function safeJson(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
