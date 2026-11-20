/**
 * PayPal provider — implemented over the PayPal REST API with plain fetch
 * (no SDK dependency, consistent with this codebase's other integrations).
 *
 * Flow (PayPal's documented contract):
 *  1. OAuth2 client-credentials token: POST {apiBase}/v1/oauth2/token
 *     (HTTP Basic auth with client id + secret, grant_type=client_credentials).
 *  2. Subscriptions create: POST {apiBase}/v1/billing/subscriptions with the
 *     pre-created recurring plan (PAYPAL_PLAN_ID). PayPal returns HATEOAS
 *     `links`; the `rel: "approve"` href is the provider-hosted approval page.
 *  3. Webhooks: POST {apiBase}/v1/notifications/verify-webhook-signature with
 *     the transmission headers PayPal sent plus webhook_id and the event
 *     itself. Only `verification_status === "SUCCESS"` is accepted — raw
 *     headers are never trusted on their own, and any transport failure fails
 *     closed.
 *
 * Credentials come exclusively from env (see .env.example); the API base
 * defaults to live PayPal and can be pointed at sandbox via PAYPAL_API_BASE.
 */
import type { SafeUser } from "~/lib/auth";
import {
  BillingProviderError,
  readHeader,
  type BillingProvider,
  type CheckoutResult,
  type WebhookEvent,
  type WebhookHeaders,
  type WebhookVerification,
} from "./index";

const DEFAULT_API_BASE = "https://api-m.paypal.com";

/** Transmission headers PayPal sends on every webhook (all required). */
export const PAYPAL_WEBHOOK_HEADERS = [
  "paypal-transmission-id",
  "paypal-transmission-time",
  "paypal-cert-url",
  "paypal-auth-algo",
  "paypal-transmission-sig",
] as const;

export function createPaypalProvider(config: {
  clientId: string;
  clientSecret: string;
  webhookId: string;
  planId: string;
  apiBase?: string;
}): BillingProvider {
  const apiBase = (config.apiBase ?? "").trim().replace(/\/+$/, "") || DEFAULT_API_BASE;
  const basicAuth = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`;

  /** OAuth2 client-credentials access token (never logged, never returned). */
  async function accessToken(): Promise<string> {
    let res: Response;
    try {
      res = await fetch(`${apiBase}/v1/oauth2/token`, {
        method: "POST",
        headers: {
          Authorization: basicAuth,
          "content-type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: "grant_type=client_credentials",
      });
    } catch {
      throw new BillingProviderError("PayPal is unreachable — OAuth2 token request failed.");
    }
    const json = (await res.json().catch(() => null)) as {
      access_token?: string;
      error_description?: string;
    } | null;
    if (!res.ok || !json?.access_token) {
      throw new BillingProviderError(
        `PayPal OAuth2 token request failed (${res.status})${json?.error_description ? `: ${json.error_description}` : "."}`
      );
    }
    return json.access_token;
  }

  return {
    id: "paypal",

    async createCheckoutSession(user: SafeUser, origin: string): Promise<CheckoutResult> {
      // The recurring price lives on the PayPal plan object (PAYPAL_PLAN_ID,
      // created by the owner at $99/month) — no amount is sent here, matching
      // the Stripe Checkout approach.
      const token = await accessToken();
      const nameParts = user.name.trim().split(/\s+/).filter(Boolean);
      const givenName = nameParts[0] || user.email;
      const surname = nameParts.slice(1).join(" ") || givenName;
      const payload = {
        plan_id: config.planId,
        // Stamped at creation so every subscription event carries the paying
        // user back to us (mirrors Stripe client_reference_id).
        custom_id: `climascope-pro-user-${user.id}`,
        subscriber: {
          name: { given_name: givenName, surname },
          email_address: user.email,
        },
        application_context: {
          brand_name: "ClimaScope",
          locale: "en-US",
          shipping_preference: "NO_SHIPPING",
          user_action: "SUBSCRIBE_NOW",
          return_url: `${origin}/dashboard?billing=success&provider=paypal`,
          cancel_url: `${origin}/dashboard?billing=cancelled&provider=paypal`,
        },
      };
      let res: Response;
      try {
        res = await fetch(`${apiBase}/v1/billing/subscriptions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "content-type": "application/json",
            Accept: "application/json",
            // Idempotency key: a retried create must not mint two subscriptions.
            "PayPal-Request-Id": crypto.randomUUID(),
          },
          body: JSON.stringify(payload),
        });
      } catch {
        throw new BillingProviderError("PayPal is unreachable — checkout could not be created.");
      }
      const json = (await res.json().catch(() => null)) as {
        id?: string;
        links?: Array<{ href?: string; rel?: string; method?: string }>;
        message?: string;
      } | null;
      const approve = (json?.links ?? []).find((l) => l.rel === "approve" && l.href)?.href;
      if (!res.ok || !approve) {
        throw new BillingProviderError(
          `PayPal checkout failed (${res.status})${json?.message ? `: ${json.message}` : "."}`
        );
      }
      return { provider: "paypal", url: approve };
    },

    async verifyWebhook(
      rawBody: string,
      _signature: string | null,
      headers?: WebhookHeaders
    ): Promise<WebhookVerification> {
      if (!config.webhookId) {
        return { ok: false, reason: "PAYPAL_WEBHOOK_ID is not configured." };
      }
      const parsed = safeJson(rawBody);
      if (!parsed) {
        return { ok: false, reason: "Webhook payload is not valid JSON." };
      }
      const missing = PAYPAL_WEBHOOK_HEADERS.filter((h) => !readHeader(headers, h));
      if (missing.length > 0) {
        return {
          ok: false,
          reason: `Missing PayPal webhook transmission header(s): ${missing.join(", ")}.`,
        };
      }
      const transmission = {
        transmission_id: readHeader(headers, "paypal-transmission-id"),
        transmission_time: readHeader(headers, "paypal-transmission-time"),
        cert_url: readHeader(headers, "paypal-cert-url"),
        auth_algo: readHeader(headers, "paypal-auth-algo"),
        transmission_sig: readHeader(headers, "paypal-transmission-sig"),
      };
      let verified: { verification_status?: string };
      try {
        const token = await accessToken();
        const res = await fetch(`${apiBase}/v1/notifications/verify-webhook-signature`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "content-type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            ...transmission,
            webhook_id: config.webhookId,
            webhook_event: parsed,
          }),
        });
        if (!res.ok) {
          return { ok: false, reason: `PayPal webhook verification call failed (${res.status}).` };
        }
        const json = (await res.json().catch(() => null)) as { verification_status?: string } | null;
        verified = json ?? {};
      } catch {
        // Fail closed: an unreachable verifier proves nothing.
        return { ok: false, reason: "PayPal webhook could not be verified (verification call failed)." };
      }
      if (verified.verification_status !== "SUCCESS") {
        return {
          ok: false,
          reason: `PayPal rejected the webhook signature (verification_status=${verified.verification_status ?? "none"}).`,
        };
      }
      const type = typeof parsed.event_type === "string" ? parsed.event_type : null;
      if (!type) {
        return { ok: false, reason: "Webhook payload is not a PayPal event." };
      }
      const event: WebhookEvent = {
        id:
          (typeof parsed.id === "string" && parsed.id ? parsed.id : "") ||
          `paypal:${type}:${typeof (parsed.resource as { id?: string } | undefined)?.id === "string" ? (parsed.resource as { id: string }).id : "unknown"}`,
        type,
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
