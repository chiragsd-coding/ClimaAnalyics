/**
 * Razorpay provider — implemented over the Razorpay REST API with plain fetch
 * (no SDK dependency, consistent with this codebase's other integrations).
 *
 * Checkout uses Razorpay Payment Links (a provider-hosted checkout page, so
 * the flow mirrors Stripe Checkout: the API returns a URL we never fabricate).
 * Credentials come exclusively from env (see .env.example).
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

const RAZORPAY_API = "https://api.razorpay.com/v1";

export function computeRazorpaySignature(webhookSecret: string, rawBody: string): string {
  return createHmac("sha256", webhookSecret).update(rawBody, "utf8").digest("hex");
}

export function createRazorpayProvider(config: {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  currency: string;
}): BillingProvider {
  const basicAuth = `Basic ${Buffer.from(`${config.keyId}:${config.keySecret}`).toString("base64")}`;

  return {
    id: "razorpay",

    async createCheckoutSession(user: SafeUser, origin: string): Promise<CheckoutResult> {
      // Razorpay amounts are minor units (paise). PRO_PRICE_MONTHLY is the
      // single price knob; RAZORPAY_CURRENCY (default INR) selects the
      // currency the owner's Razorpay account settles in.
      const payload = {
        amount: PRO_PRICE_MONTHLY * 100,
        currency: config.currency,
        accept_partial: false,
        reference_id: `climascope-pro-user-${user.id}`,
        description: "ClimaScope Pro — monthly subscription",
        customer: { name: user.name, email: user.email },
        notes: { user_id: String(user.id), plan: "pro" },
        reminder_enable: false,
        // Land back in the app after payment; link status is also verified via webhook.
        callback_url: `${origin}/dashboard?billing=return&provider=razorpay`,
        callback_method: "get",
      };
      let res: Response;
      try {
        res = await fetch(`${RAZORPAY_API}/payment_links`, {
          method: "POST",
          headers: {
            Authorization: basicAuth,
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
        });
      } catch {
        throw new BillingProviderError("Razorpay is unreachable — checkout could not be created.");
      }
      const json = (await res.json().catch(() => null)) as {
        short_url?: string;
        error?: { description?: string };
      } | null;
      if (!res.ok || !json?.short_url) {
        throw new BillingProviderError(
          `Razorpay checkout failed (${res.status})${json?.error?.description ? `: ${json.error.description}` : "."}`
        );
      }
      return { provider: "razorpay", url: json.short_url };
    },

    verifyWebhook(rawBody: string, signature: string | null): WebhookVerification {
      if (!config.webhookSecret) {
        return { ok: false, reason: "RAZORPAY_WEBHOOK_SECRET is not configured." };
      }
      const provided = (signature ?? "").trim();
      if (!provided) {
        return { ok: false, reason: "Missing X-Razorpay-Signature header." };
      }
      const expected = computeRazorpaySignature(config.webhookSecret, rawBody);
      const a = Buffer.from(expected, "hex");
      const b = Buffer.from(provided, "hex");
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        return { ok: false, reason: "Razorpay webhook signature verification failed." };
      }
      const parsed = safeJson(rawBody);
      const type = typeof parsed?.event === "string" ? parsed.event : null;
      if (!type) {
        return { ok: false, reason: "Webhook payload is not a Razorpay event." };
      }
      const entity = (
        (parsed?.payload as Record<string, { entity?: { id?: string } }> | undefined)?.payment_link
          ?.entity ?? (parsed?.payload as Record<string, { entity?: { id?: string } }> | undefined)
          ?.payment?.entity
      ) as { id?: string } | undefined;
      const event: WebhookEvent = {
        id:
          (typeof parsed?.id === "string" && parsed.id) ||
          (entity?.id ? `${type}:${entity.id}` : `razorpay:${type}`),
        type,
        payload: parsed ?? {},
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
