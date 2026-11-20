/**
 * Billing gateway tests (env-selected provider: Stripe | Razorpay | PayPal).
 *
 *   bun scripts/billing-test.ts
 *
 * Exits non-zero on any failed assertion. Coverage:
 *  (s) provider selection from env — absent/bogus/dummy creds stay disabled,
 *      full creds select the right implementation; three-way env routing.
 *  (r) REST request shapes per provider against a stubbed fetch — the exact
 *      documented contract (path, method, auth header, body fields) each
 *      provider's checkout call must satisfy, and the URL it returns.
 *  (w) webhook verification — Stripe (t/v1 HMAC), Razorpay (raw-body HMAC) and
 *      PayPal (transmission headers + verify-webhook-signature API): good
 *      fixtures verify; tampered body, wrong secret, stale timestamp, missing
 *      headers and PayPal FAILURE/unreachable all fail closed.
 *  (c) billing status surface + checkout endpoint per provider — which
 *      provider is selected, the exact missing env var names, and a working
 *      checkout response for each of the three providers.
 *  (h) honest no-creds checkout state — unauthenticated 401; with no provider
 *      (or DUMMY_ creds) the endpoint returns PLANS.billingNote verbatim and
 *      never a checkout URL.
 *  (h2) placeholder guard — a validly-signed Stripe event (and a PayPal event
 *      its verifier accepts) can never change a tier while credentials are
 *      placeholders.
 *  (u) tier changes on verified events — upgrade on Stripe/Razorpay/PayPal,
 *      PayPal renewal by subscription id, PayPal cancellation downgrade, all
 *      idempotent on replay, and cross-provider webhooks rejected.
 *
 * The fixture secrets below are test-only values, clearly named; no real or
 * placeholder credential value is committed. No network is ever touched: every
 * provider HTTP call in this file runs against a stubbed fetch.
 */
import { db } from "~/lib/db";
import { createUser, createSession, findUserById, SESSION_COOKIE, type SafeUser } from "~/lib/auth";
import { handleApiRequest } from "../src/rest/api";
import { PLANS } from "~/lib/plans";
import {
  BILLING_ENV_VARS,
  PROVIDER_IDS,
  billingStatus,
  createPaypalProvider,
  createRazorpayProvider,
  createStripeProvider,
  handleBillingWebhook,
  isConfiguredValue,
  resolveBillingProvider,
} from "~/lib/billing";
import { computeRazorpaySignature } from "~/lib/billing/razorpay";
import { computeStripeSignature } from "~/lib/billing/stripe";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  if (got !== want) {
    failures++;
    console.error(`  FAIL ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  } else {
    console.log(`  ok   ${name}`);
  }
}
function checkTrue(name: string, ok: boolean, detail = ""): void {
  if (!ok) {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    console.log(`  ok   ${name}`);
  }
}

// -- env snapshot / restore ----------------------------------------------------
const ENV_VARS = [
  "BILLING_PROVIDER",
  "STRIPE_SECRET_KEY",
  "STRIPE_PRICE_ID",
  "STRIPE_WEBHOOK_SECRET",
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "RAZORPAY_WEBHOOK_SECRET",
  "PAYPAL_CLIENT_ID",
  "PAYPAL_CLIENT_SECRET",
  "PAYPAL_WEBHOOK_ID",
  "PAYPAL_PLAN_ID",
  "PAYPAL_API_BASE",
];
const envSnapshot = new Map<string, string | undefined>(ENV_VARS.map((k) => [k, process.env[k]]));
// Normalize to a clean baseline: tests configure exactly what they need via
// setEnv, so ambient values (e.g. a local .env with DUMMY_ placeholders) must
// not leak into the "no env" expectations (s1/s2). restoreEnv() puts the
// snapshot back when the run ends.
for (const k of ENV_VARS) delete process.env[k];
function setEnv(values: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
/** Wipe every billing env var so a section starts from a clean baseline. */
function clearEnv(): void {
  for (const k of ENV_VARS) delete process.env[k];
}
function restoreEnv(): void {
  setEnv(Object.fromEntries(envSnapshot));
}

async function api(
  cookie: string | null,
  method: string,
  path: string,
  init?: { body?: string; headers?: Record<string, string> }
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await handleApiRequest(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
      body: init?.body,
    })
  );
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

function cookieFor(userId: number): string {
  const { token } = createSession(userId);
  return `${SESSION_COOKIE}=${token}`;
}

// -- stubbed fetch -------------------------------------------------------------
// Every provider HTTP call in this file runs against this stub: it records the
// exact request the provider implementation makes (url, method, headers, body)
// and answers with a fixture shaped like the provider's documented response.
type CapturedRequest = { url: string; method: string; headers: Record<string, string>; body: string };

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function captureHeaders(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  const h = init?.headers as Headers | Record<string, string> | Array<[string, string]> | undefined;
  if (!h) return out;
  if (typeof (h as Headers).forEach === "function" && !Array.isArray(h)) {
    (h as Headers).forEach((v, k) => {
      out[k.toLowerCase()] = v;
    });
  } else if (Array.isArray(h)) {
    for (const [k, v] of h) out[String(k).toLowerCase()] = String(v);
  } else {
    for (const [k, v] of Object.entries(h as Record<string, string>)) out[k.toLowerCase()] = String(v);
  }
  return out;
}

async function withStub<T>(
  responder: (req: CapturedRequest) => Response | Promise<Response>,
  fn: () => Promise<T>
): Promise<{ result: T; calls: CapturedRequest[] }> {
  const original = globalThis.fetch;
  const calls: CapturedRequest[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
    const req: CapturedRequest = {
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      headers: captureHeaders(init),
      body: typeof init?.body === "string" ? init.body : "",
    };
    calls.push(req);
    return responder(req);
  }) as unknown as typeof fetch;
  try {
    const result = await fn();
    return { result, calls };
  } finally {
    globalThis.fetch = original;
  }
}

// -- webhook fixtures (test-only secrets, clearly named) -----------------------
const STRIPE_WEBHOOK_SECRET_FIXTURE = "whsec-test-fixture-not-a-real-secret";
const RAZORPAY_WEBHOOK_SECRET_FIXTURE = "rzp-whsec-test-fixture-not-a-real-secret";
const PAYPAL_WEBHOOK_ID_FIXTURE = "WH-TEST-FIXTURE-NOT-A-REAL-WEBHOOK-ID";
const PAYPAL_ACCESS_TOKEN_FIXTURE = "A21-test-fixture-access-token";

function stripeSignedBody(
  eventId: string,
  userId: number,
  secret = STRIPE_WEBHOOK_SECRET_FIXTURE
): { body: string; signature: string } {
  const body = JSON.stringify({
    id: eventId,
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_fixture",
        object: "checkout.session",
        client_reference_id: `climascope-pro-user-${userId}`,
        customer: "cus_test_fixture",
        subscription: "sub_test_fixture",
        payment_status: "paid",
      },
    },
  });
  const t = Math.floor(Date.now() / 1000);
  const v1 = computeStripeSignature(secret, t, body);
  return { body, signature: `t=${t},v1=${v1}` };
}

function razorpaySignedBody(
  userId: number,
  secret = RAZORPAY_WEBHOOK_SECRET_FIXTURE,
  plinkId = "plink_test_fixture"
): { body: string; signature: string } {
  const body = JSON.stringify({
    event: "payment_link.paid",
    payload: {
      payment_link: {
        entity: {
          id: plinkId,
          reference_id: `climascope-pro-user-${userId}`,
          customer_id: "cust_test_fixture",
          notes: { user_id: String(userId), plan: "pro" },
        },
      },
    },
  });
  return { body, signature: computeRazorpaySignature(secret, body) };
}

/** PayPal transmission headers exactly as PayPal documents them. */
function paypalHeaders(overrides: Record<string, string | undefined> = {}): Headers {
  const base: Record<string, string | undefined> = {
    "paypal-transmission-id": "b3d1f6a0-test-fixture-transmission",
    "paypal-transmission-time": "2026-11-20T10:00:00Z",
    "paypal-cert-url": "https://api.paypal.com/v1/notifications/certs/CERT-test-fixture",
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-transmission-sig": "test-fixture-transmission-signature",
    ...overrides,
  };
  const h = new Headers();
  for (const [k, v] of Object.entries(base)) if (v !== undefined) h.set(k, v);
  return h;
}

function paypalSubscriptionBody(
  eventId: string,
  type: "BILLING.SUBSCRIPTION.ACTIVATED" | "BILLING.SUBSCRIPTION.CANCELLED" | "BILLING.SUBSCRIPTION.SUSPENDED",
  userId: number,
  subscriptionId = "I-TESTFIXTURE"
): string {
  return JSON.stringify({
    id: eventId,
    event_version: "1.0",
    event_type: type,
    resource_type: "subscription",
    resource: {
      id: subscriptionId,
      status: type.endsWith("ACTIVATED") ? "ACTIVE" : type.endsWith("CANCELLED") ? "CANCELLED" : "SUSPENDED",
      plan_id: "P-TESTFIXTURE-PLAN",
      custom_id: `climascope-pro-user-${userId}`,
      subscriber: { payer_id: "PAYER-TESTFIXTURE", email_address: "billing@example.com" },
    },
  });
}

/** A subscription renewal payment: carries the agreement id, not custom_id. */
function paypalSaleBody(eventId: string, subscriptionId = "I-TESTFIXTURE"): string {
  return JSON.stringify({
    id: eventId,
    event_version: "1.0",
    event_type: "PAYMENT.SALE.COMPLETED",
    resource_type: "sale",
    resource: {
      id: "SALE-TESTFIXTURE",
      billing_agreement_id: subscriptionId,
      amount: { total: "99.00", currency: "USD" },
      state: "completed",
    },
  });
}

/** PayPal's verify-webhook-signature response (SUCCESS unless overridden). */
function paypalResponder(opts: { verifyStatus?: string; tokenStatus?: number } = {}) {
  return (req: CapturedRequest): Response => {
    if (req.url.endsWith("/v1/oauth2/token")) {
      if (opts.tokenStatus && opts.tokenStatus !== 200) {
        return jsonRes({ error: "invalid_client", error_description: "fixture rejection" }, opts.tokenStatus);
      }
      return jsonRes({
        scope: "https://uri.paypal.com/services/billing/subscriptions/read",
        access_token: PAYPAL_ACCESS_TOKEN_FIXTURE,
        token_type: "Bearer",
        expires_in: 32400,
      });
    }
    if (req.url.endsWith("/v1/billing/subscriptions")) {
      return jsonRes(
        {
          id: "I-TESTFIXTURE",
          status: "APPROVAL_PENDING",
          links: [
            {
              href: "https://www.paypal.com/webapps/billing/subscriptions?ba_token=BA-TESTFIXTURE",
              rel: "approve",
              method: "GET",
            },
            {
              href: "https://api-m.paypal.com/v1/billing/subscriptions/I-TESTFIXTURE",
              rel: "self",
              method: "GET",
            },
          ],
        },
        201
      );
    }
    if (req.url.endsWith("/v1/notifications/verify-webhook-signature")) {
      return jsonRes({ verification_status: opts.verifyStatus ?? "SUCCESS" });
    }
    return jsonRes({ error: "unexpected_request_in_test" }, 500);
  };
}

const FIXTURE_USER: SafeUser = {
  id: 424242,
  email: "billing.fixture@example.com",
  name: "Ada Lovelace",
  role: "analyst",
  tier: "free",
  created_at: "2026-01-01T00:00:00Z",
};

const ORIGIN = "https://app.climascope.example";

async function main() {
  let userId = 0;
  try {
    // -- (s) provider selection ------------------------------------------------
    console.log("(s) provider selection");
    clearEnv();
    check("s1: no env → no provider", resolveBillingProvider().provider, null);
    const rNone = resolveBillingProvider() as { provider: null; reason: string };
    checkTrue("s2: no env → reason mentions BILLING_PROVIDER", rNone.reason.includes("BILLING_PROVIDER"));
    setEnv({ BILLING_PROVIDER: "stripe" });
    const r3 = resolveBillingProvider() as { provider: null; reason: string };
    check("s3: stripe without creds → none", r3.provider, null);
    checkTrue("s4: reason names STRIPE_SECRET_KEY", r3.reason.includes("STRIPE_SECRET_KEY"));
    setEnv({
      BILLING_PROVIDER: "stripe",
      STRIPE_SECRET_KEY: "DUMMY_sk_placeholder",
      STRIPE_PRICE_ID: "DUMMY_price_placeholder",
      STRIPE_WEBHOOK_SECRET: "DUMMY_whsec_placeholder",
    });
    check("s5: all-dummy creds → none", resolveBillingProvider().provider, null);
    setEnv({
      BILLING_PROVIDER: "stripe",
      STRIPE_SECRET_KEY: "sk_shape_only_real_looking_value",
      STRIPE_PRICE_ID: "price_shape_only_real_looking_value",
      STRIPE_WEBHOOK_SECRET: "whsec_shape_only_real_looking_value",
    });
    check("s6: real-shaped stripe creds → stripe", resolveBillingProvider().provider?.id, "stripe");
    setEnv({
      BILLING_PROVIDER: "razorpay",
      RAZORPAY_KEY_ID: "rzp_shape_real",
      RAZORPAY_KEY_SECRET: "rzp_secret_shape_real",
      RAZORPAY_WEBHOOK_SECRET: "rzp_whsec_shape_real",
    });
    check("s7: real-shaped razorpay creds → razorpay", resolveBillingProvider().provider?.id, "razorpay");
    setEnv({
      BILLING_PROVIDER: "paypal",
      STRIPE_SECRET_KEY: "sk_shape_real",
      STRIPE_PRICE_ID: "price_shape_real",
      STRIPE_WEBHOOK_SECRET: "whsec_shape_real",
    });
    check("s8: paypal selected but only stripe creds → none", resolveBillingProvider().provider, null);
    setEnv({
      BILLING_PROVIDER: "paypal",
      PAYPAL_CLIENT_ID: "paypal-client-id-shape-real",
      PAYPAL_CLIENT_SECRET: "paypal-client-secret-shape-real",
      PAYPAL_WEBHOOK_ID: PAYPAL_WEBHOOK_ID_FIXTURE,
      PAYPAL_PLAN_ID: "P-9TESTSHAPEONLY",
    });
    check("s8b: real-shaped paypal creds → paypal", resolveBillingProvider().provider?.id, "paypal");
    setEnv({ BILLING_PROVIDER: "adyen", ADYEN_KEY: "shape_real" });
    check("s8c: unsupported provider → none", resolveBillingProvider().provider, null);
    setEnv({
      BILLING_PROVIDER: "stripe",
      STRIPE_SECRET_KEY: "sk_real",
      STRIPE_PRICE_ID: "",
      STRIPE_WEBHOOK_SECRET: "whsec_real",
    });
    check("s9: stripe with missing price id → none", resolveBillingProvider().provider, null);
    check("s10: isConfiguredValue(empty)", isConfiguredValue(""), false);
    check("s11: isConfiguredValue(DUMMY_x)", isConfiguredValue("DUMMY_x"), false);
    check("s12: isConfiguredValue(sk_test_…) accepted", isConfiguredValue("sk_test_abc123"), true);
    checkTrue(
      "s13: env var names documented per provider",
      BILLING_ENV_VARS.stripe.length === 3 &&
        BILLING_ENV_VARS.razorpay.length === 3 &&
        BILLING_ENV_VARS.paypal.length === 4
    );
    check("s14: three providers supported", PROVIDER_IDS.length, 3);
    // Three-way env routing: flipping BILLING_PROVIDER selects exactly that
    // provider and nothing from the other two is consulted.
    setEnv({
      BILLING_PROVIDER: "paypal",
      PAYPAL_CLIENT_ID: "paypal-client-id-shape-real",
      PAYPAL_CLIENT_SECRET: "paypal-client-secret-shape-real",
      PAYPAL_WEBHOOK_ID: PAYPAL_WEBHOOK_ID_FIXTURE,
      PAYPAL_PLAN_ID: "P-9TESTSHAPEONLY",
      STRIPE_SECRET_KEY: "DUMMY_sk",
      STRIPE_PRICE_ID: "DUMMY_price",
      STRIPE_WEBHOOK_SECRET: "DUMMY_whsec",
      RAZORPAY_KEY_ID: "DUMMY_key",
      RAZORPAY_KEY_SECRET: "DUMMY_secret",
      RAZORPAY_WEBHOOK_SECRET: "DUMMY_whsec",
    });
    check("s15: routing → paypal despite dummy stripe/razorpay", resolveBillingProvider().provider?.id, "paypal");
    setEnv({
      BILLING_PROVIDER: "razorpay",
      PAYPAL_CLIENT_ID: "DUMMY_client",
      PAYPAL_CLIENT_SECRET: "DUMMY_secret",
      PAYPAL_WEBHOOK_ID: "DUMMY_wh",
      PAYPAL_PLAN_ID: "DUMMY_plan",
      RAZORPAY_KEY_ID: "rzp_shape_real",
      RAZORPAY_KEY_SECRET: "rzp_secret_shape_real",
      RAZORPAY_WEBHOOK_SECRET: "rzp_whsec_shape_real",
    });
    check("s16: routing → razorpay despite dummy paypal", resolveBillingProvider().provider?.id, "razorpay");

    // -- (r) REST request shapes per provider (stubbed fetch) -------------------
    console.log("(r) REST request shapes per provider");
    // Stripe: POST /v1/checkout/sessions, bearer secret, form-encoded body.
    setEnv({
      BILLING_PROVIDER: "stripe",
      STRIPE_SECRET_KEY: "sk_shape_real_for_shape_test",
      STRIPE_PRICE_ID: "price_shape_real_for_shape_test",
      STRIPE_WEBHOOK_SECRET: "whsec_shape_real_for_shape_test",
    });
    const stripeProvider = resolveBillingProvider().provider!;
    const stripeShape = await withStub(
      () => jsonRes({ id: "cs_test_fixture", url: "https://checkout.stripe.com/c/pay/cs_test_fixture" }),
      () => stripeProvider.createCheckoutSession(FIXTURE_USER, ORIGIN)
    );
    const stripeReq = stripeShape.calls[0]!;
    check("r1: stripe checkout → POST api.stripe.com/v1/checkout/sessions", `${stripeReq.method} ${stripeReq.url}`, "POST https://api.stripe.com/v1/checkout/sessions");
    check("r2: stripe bearer auth header", stripeReq.headers.authorization, "Bearer sk_shape_real_for_shape_test");
    check("r3: stripe form content-type", stripeReq.headers["content-type"], "application/x-www-form-urlencoded");
    const stripeForm = new URLSearchParams(stripeReq.body);
    check("r4: stripe body mode=subscription", stripeForm.get("mode"), "subscription");
    check("r5: stripe body price id", stripeForm.get("line_items[0][price]"), "price_shape_real_for_shape_test");
    check("r6: stripe body quantity", stripeForm.get("line_items[0][quantity]"), "1");
    check("r7: stripe body client_reference_id", stripeForm.get("client_reference_id"), "climascope-pro-user-424242");
    check("r8: stripe body metadata user_id", stripeForm.get("metadata[user_id]"), "424242");
    check("r9: stripe body customer_email", stripeForm.get("customer_email"), FIXTURE_USER.email);
    check("r10: stripe body success_url", stripeForm.get("success_url"), `${ORIGIN}/dashboard?billing=success&provider=stripe`);
    check("r11: stripe returns provider-hosted url", stripeShape.result.url, "https://checkout.stripe.com/c/pay/cs_test_fixture");
    check("r12: stripe result provider id", stripeShape.result.provider, "stripe");

    // Razorpay: POST /v1/payment_links, basic auth, JSON body in minor units.
    setEnv({
      BILLING_PROVIDER: "razorpay",
      RAZORPAY_KEY_ID: "rzp_shape_real",
      RAZORPAY_KEY_SECRET: "rzp_secret_shape_real",
      RAZORPAY_WEBHOOK_SECRET: "rzp_whsec_shape_real",
    });
    const razorpayProvider = resolveBillingProvider().provider!;
    const razorpayShape = await withStub(
      () => jsonRes({ id: "plink_test_fixture", short_url: "https://rzp.io/i/test-fixture" }),
      () => razorpayProvider.createCheckoutSession(FIXTURE_USER, ORIGIN)
    );
    const rzpReq = razorpayShape.calls[0]!;
    check("r13: razorpay checkout → POST api.razorpay.com/v1/payment_links", `${rzpReq.method} ${rzpReq.url}`, "POST https://api.razorpay.com/v1/payment_links");
    check(
      "r14: razorpay basic auth header",
      rzpReq.headers.authorization,
      `Basic ${Buffer.from("rzp_shape_real:rzp_secret_shape_real").toString("base64")}`
    );
    check("r15: razorpay json content-type", rzpReq.headers["content-type"], "application/json");
    const rzpBody = JSON.parse(rzpReq.body) as Record<string, unknown> & { notes?: Record<string, string> };
    check("r16: razorpay body amount in paise", rzpBody.amount, 9900);
    check("r17: razorpay body currency", rzpBody.currency, "INR");
    check("r18: razorpay body reference_id", rzpBody.reference_id, "climascope-pro-user-424242");
    check("r19: razorpay body notes.user_id", rzpBody.notes?.user_id, "424242");
    check("r20: razorpay body callback_url", rzpBody.callback_url, `${ORIGIN}/dashboard?billing=return&provider=razorpay`);
    check("r21: razorpay returns short_url", razorpayShape.result.url, "https://rzp.io/i/test-fixture");
    check("r22: razorpay result provider id", razorpayShape.result.provider, "razorpay");

    // PayPal: OAuth2 token → subscriptions create → approve link.
    setEnv({
      BILLING_PROVIDER: "paypal",
      PAYPAL_CLIENT_ID: "paypal-client-id-shape-real",
      PAYPAL_CLIENT_SECRET: "paypal-client-secret-shape-real",
      PAYPAL_WEBHOOK_ID: PAYPAL_WEBHOOK_ID_FIXTURE,
      PAYPAL_PLAN_ID: "P-9TESTSHAPEONLY",
    });
    const paypalProvider = resolveBillingProvider().provider!;
    const paypalShape = await withStub(paypalResponder(), () =>
      paypalProvider.createCheckoutSession(FIXTURE_USER, ORIGIN)
    );
    const tokenReq = paypalShape.calls[0]!;
    const subReq = paypalShape.calls[1]!;
    check("r23: paypal token → POST /v1/oauth2/token on live api base", `${tokenReq.method} ${tokenReq.url}`, "POST https://api-m.paypal.com/v1/oauth2/token");
    check(
      "r24: paypal token basic auth header",
      tokenReq.headers.authorization,
      `Basic ${Buffer.from("paypal-client-id-shape-real:paypal-client-secret-shape-real").toString("base64")}`
    );
    check("r25: paypal token form content-type", tokenReq.headers["content-type"], "application/x-www-form-urlencoded");
    check("r26: paypal token grant_type", tokenReq.body, "grant_type=client_credentials");
    check("r27: paypal subscriptions → POST /v1/billing/subscriptions", `${subReq.method} ${subReq.url}`, "POST https://api-m.paypal.com/v1/billing/subscriptions");
    check("r28: paypal subscriptions bearer token", subReq.headers.authorization, `Bearer ${PAYPAL_ACCESS_TOKEN_FIXTURE}`);
    check("r29: paypal subscriptions json content-type", subReq.headers["content-type"], "application/json");
    checkTrue("r30: paypal idempotency key header present", (subReq.headers["paypal-request-id"] ?? "").length >= 8, subReq.headers["paypal-request-id"]);
    const paypalBody = JSON.parse(subReq.body) as {
      plan_id?: string;
      custom_id?: string;
      subscriber?: { email_address?: string; name?: { given_name?: string; surname?: string } };
      application_context?: Record<string, string>;
    };
    check("r31: paypal body plan_id", paypalBody.plan_id, "P-9TESTSHAPEONLY");
    check("r32: paypal body custom_id", paypalBody.custom_id, "climascope-pro-user-424242");
    check("r33: paypal body subscriber email", paypalBody.subscriber?.email_address, FIXTURE_USER.email);
    check("r34: paypal body given_name", paypalBody.subscriber?.name?.given_name, "Ada");
    check("r35: paypal body return_url", paypalBody.application_context?.return_url, `${ORIGIN}/dashboard?billing=success&provider=paypal`);
    check("r36: paypal body cancel_url", paypalBody.application_context?.cancel_url, `${ORIGIN}/dashboard?billing=cancelled&provider=paypal`);
    check("r37: paypal returns approve link", paypalShape.result.url, "https://www.paypal.com/webapps/billing/subscriptions?ba_token=BA-TESTFIXTURE");
    check("r38: paypal result provider id", paypalShape.result.provider, "paypal");
    // PAYPAL_API_BASE points the same flow at sandbox (or a proxy) with no code change.
    setEnv({ PAYPAL_API_BASE: "https://api-m.sandbox.paypal.com" });
    const paypalSandbox = await withStub(paypalResponder(), () =>
      resolveBillingProvider().provider!.createCheckoutSession(FIXTURE_USER, ORIGIN)
    );
    check("r39: PAYPAL_API_BASE override honored", paypalSandbox.calls[0]!.url, "https://api-m.sandbox.paypal.com/v1/oauth2/token");
    setEnv({ PAYPAL_API_BASE: undefined });
    // Provider-side failure surfaces as an error, never a fabricated URL.
    let paypalNoLinkThrew = false;
    await withStub(
      (req) =>
        req.url.endsWith("/v1/oauth2/token")
          ? jsonRes({ access_token: PAYPAL_ACCESS_TOKEN_FIXTURE })
          : jsonRes({ id: "I-TESTFIXTURE", links: [] }),
      async () => {
        try {
          await paypalProvider.createCheckoutSession(FIXTURE_USER, ORIGIN);
        } catch {
          paypalNoLinkThrew = true;
        }
      }
    );
    checkTrue("r40: paypal response without approve link throws", paypalNoLinkThrew);

    // -- (w) webhook verification (pure verifyWebhook, no DB writes) ------------
    console.log("(w) webhook verification");
    const stripe = createStripeProvider({
      secretKey: "unused",
      priceId: "unused",
      webhookSecret: STRIPE_WEBHOOK_SECRET_FIXTURE,
    });
    const razorpay = createRazorpayProvider({
      keyId: "unused",
      keySecret: "unused",
      webhookSecret: RAZORPAY_WEBHOOK_SECRET_FIXTURE,
      currency: "INR",
    });
    const paypal = createPaypalProvider({
      clientId: "unused",
      clientSecret: "unused",
      webhookId: PAYPAL_WEBHOOK_ID_FIXTURE,
      planId: "unused",
    });
    const signed = stripeSignedBody("evt_sig_ok", 1);
    const good = await stripe.verifyWebhook(signed.body, signed.signature);
    checkTrue("w1: stripe good fixture verifies", good.ok && good.event.type === "checkout.session.completed");
    checkTrue(
      "w1b: stripe good fixture parses event id",
      good.ok && good.event.id === "evt_sig_ok"
    );
    const tampered = await stripe.verifyWebhook(signed.body + " ", signed.signature);
    checkTrue("w2: stripe tampered body rejected", !tampered.ok);
    const crossSigned = stripeSignedBody("evt_ws", 1, "whsec-a-different-fixture-secret");
    checkTrue(
      "w3: stripe body signed with another secret rejected",
      !(await stripe.verifyWebhook(crossSigned.body, crossSigned.signature)).ok
    );
    const oldBody = JSON.stringify({ id: "evt_old", type: "checkout.session.completed", data: { object: {} } });
    const oldT = Math.floor(Date.now() / 1000) - 3600;
    const oldSig = `t=${oldT},v1=${computeStripeSignature(STRIPE_WEBHOOK_SECRET_FIXTURE, oldT, oldBody)}`;
    checkTrue("w4: stripe stale timestamp rejected", !(await stripe.verifyWebhook(oldBody, oldSig)).ok);
    checkTrue("w5: stripe missing header rejected", !(await stripe.verifyWebhook(signed.body, null)).ok);
    checkTrue("w6: stripe malformed header rejected", !(await stripe.verifyWebhook(signed.body, "v1=deadbeef")).ok);
    const rzp = razorpaySignedBody(1);
    const rzpGood = await razorpay.verifyWebhook(rzp.body, rzp.signature);
    checkTrue("w7: razorpay good fixture verifies", rzpGood.ok && rzpGood.event.type === "payment_link.paid");
    checkTrue("w8: razorpay tampered body rejected", !(await razorpay.verifyWebhook(rzp.body + " ", rzp.signature)).ok);
    const rzpCross = razorpaySignedBody(1, "rzp-whsec-a-different-fixture", "plink_other_fixture");
    checkTrue(
      "w9: razorpay body signed with another secret rejected",
      !(await razorpay.verifyWebhook(rzpCross.body, rzp.signature)).ok
    );
    checkTrue("w10: razorpay missing header rejected", !(await razorpay.verifyWebhook(rzp.body, null)).ok);
    checkTrue(
      "w11: unknown provider path rejected",
      !(await handleBillingWebhook("adyen", "{}", "x")).ok
    );
    // PayPal: verification is a call to PayPal's own API, not a local HMAC.
    const ppBody = paypalSubscriptionBody("WH-EVT-ACTIVATED", "BILLING.SUBSCRIPTION.ACTIVATED", 1);
    const ppGood = await withStub(paypalResponder(), () => paypal.verifyWebhook(ppBody, null, paypalHeaders()));
    checkTrue(
      "w12: paypal good fixture verifies via verify-webhook-signature",
      ppGood.result.ok && ppGood.result.event.type === "BILLING.SUBSCRIPTION.ACTIVATED"
    );
    checkTrue(
      "w13: paypal event id parsed",
      ppGood.result.ok && ppGood.result.event.id === "WH-EVT-ACTIVATED"
    );
    const verifyCall = ppGood.calls.find((c) => c.url.endsWith("/v1/notifications/verify-webhook-signature"))!;
    check(
      "w14: paypal verify → POST verify-webhook-signature",
      `${verifyCall.method} ${verifyCall.url}`,
      "POST https://api-m.paypal.com/v1/notifications/verify-webhook-signature"
    );
    check("w15: paypal verify bearer token", verifyCall.headers.authorization, `Bearer ${PAYPAL_ACCESS_TOKEN_FIXTURE}`);
    const verifyBody = JSON.parse(verifyCall.body) as Record<string, unknown> & {
      webhook_event?: { event_type?: string; id?: string };
    };
    check("w16: paypal verify sends webhook_id", verifyBody.webhook_id, PAYPAL_WEBHOOK_ID_FIXTURE);
    check("w17: paypal verify sends transmission_id", verifyBody.transmission_id, "b3d1f6a0-test-fixture-transmission");
    check("w18: paypal verify sends transmission_time", verifyBody.transmission_time, "2026-11-20T10:00:00Z");
    check("w19: paypal verify sends transmission_sig", verifyBody.transmission_sig, "test-fixture-transmission-signature");
    check("w20: paypal verify sends auth_algo", verifyBody.auth_algo, "SHA256withRSA");
    check(
      "w21: paypal verify sends cert_url",
      verifyBody.cert_url,
      "https://api.paypal.com/v1/notifications/certs/CERT-test-fixture"
    );
    check("w22: paypal verify sends the full event", verifyBody.webhook_event?.event_type, "BILLING.SUBSCRIPTION.ACTIVATED");
    // Bad signature: PayPal answers FAILURE — the event must be rejected.
    const ppBad = await withStub(paypalResponder({ verifyStatus: "FAILURE" }), () =>
      paypal.verifyWebhook(ppBody, null, paypalHeaders())
    );
    checkTrue("w23: paypal FAILURE verdict rejected", !ppBad.result.ok);
    checkTrue(
      "w24: paypal FAILURE reason names verification_status",
      !ppBad.result.ok && ppBad.result.reason.includes("verification_status"),
      ppBad.result.ok ? "" : ppBad.result.reason
    );
    // Missing transmission header: rejected before any network call.
    const ppMissing = await withStub(paypalResponder(), () =>
      paypal.verifyWebhook(ppBody, null, paypalHeaders({ "paypal-transmission-sig": undefined }))
    );
    checkTrue("w25: paypal missing transmission header rejected", !ppMissing.result.ok);
    check("w26: paypal missing header → no network call", ppMissing.calls.length, 0);
    // OAuth2 failure (e.g. bad client credentials): fail closed.
    const ppTokenFail = await withStub(paypalResponder({ tokenStatus: 401 }), () =>
      paypal.verifyWebhook(ppBody, null, paypalHeaders())
    );
    checkTrue("w27: paypal token failure rejected", !ppTokenFail.result.ok);
    // Verifier unreachable: fail closed.
    const ppOffline = await withStub(
      () => {
        throw new Error("network down");
      },
      () => paypal.verifyWebhook(ppBody, null, paypalHeaders())
    );
    checkTrue("w28: paypal verifier unreachable rejected", !ppOffline.result.ok);
    // Not a PayPal event body.
    const ppNotEvent = await withStub(paypalResponder(), () => paypal.verifyWebhook("{}", null, paypalHeaders()));
    checkTrue("w29: paypal non-event body rejected", !ppNotEvent.result.ok);
    // Webhook id missing in config: rejected without any call.
    const paypalNoWebhookId = createPaypalProvider({
      clientId: "unused",
      clientSecret: "unused",
      webhookId: "",
      planId: "unused",
    });
    const ppNoId = await withStub(paypalResponder(), () => paypalNoWebhookId.verifyWebhook(ppBody, null, paypalHeaders()));
    checkTrue("w30: paypal without webhook id rejected", !ppNoId.result.ok);
    check("w31: paypal without webhook id → no network call", ppNoId.calls.length, 0);

    // -- (c) billing status surface + checkout per provider ----------------------
    console.log("(c) billing status + checkout per provider");
    clearEnv();
    const fresh = await createUser({
      email: `billing-test-${Date.now()}@example.com`,
      name: "Billing Test",
      password: "correct-horse-battery-staple",
      role: "analyst",
    });
    userId = fresh.id;
    const cookie = cookieFor(userId);
    const statusNoAuth = await api(null, "GET", "/api/billing/status");
    check("c1: status without auth → 401", statusNoAuth.status, 401);
    const statusNone = await api(cookie, "GET", "/api/billing/status");
    check("c2: status with no env → billingEnabled false", statusNone.json.billingEnabled, false);
    check("c3: status with no env → provider null", statusNone.json.provider, null);
    check("c4: status lists all three providers", (statusNone.json.availableProviders as string[]).join(","), "stripe,razorpay,paypal");
    checkTrue(
      "c5: status note names BILLING_PROVIDER",
      String(statusNone.json.note ?? "").includes("BILLING_PROVIDER")
    );
    setEnv({
      BILLING_PROVIDER: "paypal",
      PAYPAL_CLIENT_ID: "paypal-client-id-shape-real",
      PAYPAL_CLIENT_SECRET: "paypal-client-secret-shape-real",
      PAYPAL_WEBHOOK_ID: PAYPAL_WEBHOOK_ID_FIXTURE,
    });
    const statusPartial = await api(cookie, "GET", "/api/billing/status");
    check("c6: paypal without plan id → billingEnabled false", statusPartial.json.billingEnabled, false);
    check("c7: selected provider reported", statusPartial.json.selectedProvider, "paypal");
    check("c8: exact missing env var reported", (statusPartial.json.missingEnvVars as string[]).join(","), "PAYPAL_PLAN_ID");
    checkTrue("c9: note names the selected provider", String(statusPartial.json.note ?? "").includes('"paypal"'));
    checkTrue("c10: note names the missing var", String(statusPartial.json.note ?? "").includes("PAYPAL_PLAN_ID"));
    check("c11: webhook path reported", statusPartial.json.webhookPath, "/api/billing/webhook/paypal");
    const checkoutPartial = await api(cookie, "POST", "/api/billing/checkout");
    check("c12: checkout with incomplete paypal → billingEnabled false", checkoutPartial.json.billingEnabled, false);
    check("c13: checkout reports the missing var", (checkoutPartial.json.missingEnvVars as string[]).join(","), "PAYPAL_PLAN_ID");
    checkTrue("c14: checkout still returns the pinned note", checkoutPartial.json.billingNote === PLANS.billingNote);
    checkTrue("c15: checkout with incomplete creds → no checkoutUrl", !("checkoutUrl" in checkoutPartial.json));

    setEnv({
      BILLING_PROVIDER: "paypal",
      PAYPAL_CLIENT_ID: "paypal-client-id-shape-real",
      PAYPAL_CLIENT_SECRET: "paypal-client-secret-shape-real",
      PAYPAL_WEBHOOK_ID: PAYPAL_WEBHOOK_ID_FIXTURE,
      PAYPAL_PLAN_ID: "P-9TESTSHAPEONLY",
    });
    const statusPaypal = await api(cookie, "GET", "/api/billing/status");
    check("c16: paypal configured → billingEnabled true", statusPaypal.json.billingEnabled, true);
    check("c17: paypal configured → provider paypal", statusPaypal.json.provider, "paypal");
    check("c18: paypal configured → no missing vars", (statusPaypal.json.missingEnvVars as string[]).length, 0);
    check("c19: paypal webhook path", statusPaypal.json.webhookPath, "/api/billing/webhook/paypal");
    // Checkout endpoint end-to-end per provider (stubbed provider HTTP).
    const checkoutPaypal = await withStub(paypalResponder(), () => api(cookie, "POST", "/api/billing/checkout"));
    check("c20: checkout via paypal → 200", checkoutPaypal.result.status, 200);
    check("c21: checkout via paypal → provider paypal", checkoutPaypal.result.json.provider, "paypal");
    check(
      "c22: checkout via paypal → approve url",
      checkoutPaypal.result.json.checkoutUrl,
      "https://www.paypal.com/webapps/billing/subscriptions?ba_token=BA-TESTFIXTURE"
    );
    setEnv({
      BILLING_PROVIDER: "stripe",
      STRIPE_SECRET_KEY: "sk_shape_real_for_api_checkout",
      STRIPE_PRICE_ID: "price_shape_real_for_api_checkout",
      STRIPE_WEBHOOK_SECRET: "whsec_shape_real_for_api_checkout",
    });
    const checkoutStripe = await withStub(
      () => jsonRes({ id: "cs_test_fixture", url: "https://checkout.stripe.com/c/pay/cs_test_fixture" }),
      () => api(cookie, "POST", "/api/billing/checkout")
    );
    check("c23: checkout via stripe → 200 provider stripe", `${checkoutStripe.result.status}:${checkoutStripe.result.json.provider}`, "200:stripe");
    check("c24: checkout via stripe → hosted url", checkoutStripe.result.json.checkoutUrl, "https://checkout.stripe.com/c/pay/cs_test_fixture");
    check("c25: stripe status webhook path", (await api(cookie, "GET", "/api/billing/status")).json.webhookPath, "/api/billing/webhook/stripe");
    setEnv({
      BILLING_PROVIDER: "razorpay",
      RAZORPAY_KEY_ID: "rzp_shape_real",
      RAZORPAY_KEY_SECRET: "rzp_secret_shape_real",
      RAZORPAY_WEBHOOK_SECRET: "rzp_whsec_shape_real",
    });
    const checkoutRzp = await withStub(
      () => jsonRes({ id: "plink_test_fixture", short_url: "https://rzp.io/i/test-fixture" }),
      () => api(cookie, "POST", "/api/billing/checkout")
    );
    check("c26: checkout via razorpay → 200 provider razorpay", `${checkoutRzp.result.status}:${checkoutRzp.result.json.provider}`, "200:razorpay");
    check("c27: checkout via razorpay → short url", checkoutRzp.result.json.checkoutUrl, "https://rzp.io/i/test-fixture");
    check("c28: razorpay status webhook path", (await api(cookie, "GET", "/api/billing/status")).json.webhookPath, "/api/billing/webhook/razorpay");
    // Provider failure is reported as 502 — never a fabricated checkout.
    const checkoutBroken = await withStub(
      () => jsonRes({ error: { message: "fixture provider outage" } }, 500),
      () => api(cookie, "POST", "/api/billing/checkout")
    );
    check("c29: provider failure → 502", checkoutBroken.result.status, 502);
    checkTrue("c30: provider failure → no checkoutUrl", !("checkoutUrl" in checkoutBroken.result.json));

    // -- (h) honest no-creds checkout state --------------------------------------
    console.log("(h) honest no-creds checkout state");
    clearEnv(); // ensure nothing is configured
    const noAuth = await api(null, "POST", "/api/billing/checkout");
    check("h1: checkout without auth → 401", noAuth.status, 401);
    const noCreds = await api(cookie, "POST", "/api/billing/checkout");
    check("h2: no creds → 200 honest state", noCreds.status, 200);
    check("h3: billingEnabled false", noCreds.json.billingEnabled, false);
    check("h4: billingNote verbatim", noCreds.json.billingNote, PLANS.billingNote);
    checkTrue("h5: no checkoutUrl key", !("checkoutUrl" in noCreds.json) && !("url" in noCreds.json));
    check("h6: provider null", noCreds.json.provider, null);
    setEnv({
      BILLING_PROVIDER: "stripe",
      STRIPE_SECRET_KEY: "DUMMY_sk",
      STRIPE_PRICE_ID: "DUMMY_price",
      STRIPE_WEBHOOK_SECRET: "DUMMY_whsec",
    });
    const dummy = await api(cookie, "POST", "/api/billing/checkout");
    check("h7: dummy creds → billingEnabled false", dummy.json.billingEnabled, false);
    check("h8: dummy creds → billingNote verbatim", dummy.json.billingNote, PLANS.billingNote);
    checkTrue("h9: dummy creds → no checkoutUrl", !("checkoutUrl" in dummy.json));
    clearEnv();

    // -- (h2) dummy creds: even a validly-signed upgrade event must not upgrade --
    console.log("(h2) dummy creds: signed upgrade event rejected");
    setEnv({
      BILLING_PROVIDER: "stripe",
      STRIPE_SECRET_KEY: "DUMMY_sk",
      STRIPE_PRICE_ID: "DUMMY_price",
      STRIPE_WEBHOOK_SECRET: "DUMMY_whsec",
    });
    const dummySigned = stripeSignedBody("evt_dummy_signed", userId, "DUMMY_whsec");
    const dummyHook = await api(null, "POST", "/api/billing/webhook/stripe", {
      body: dummySigned.body,
      headers: { "stripe-signature": dummySigned.signature },
    });
    check("h10: signed event while unconfigured → 400", dummyHook.status, 400);
    checkTrue("h11: reason names placeholders", String(dummyHook.json.error ?? "").includes("placeholder"));
    check(
      "h12: tier stays free",
      db.query<{ tier: string }, [number]>("SELECT tier FROM users WHERE id = ?").get(userId)!.tier,
      "free"
    );
    checkTrue(
      "h13: no billing_events row written",
      (db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM billing_events WHERE event_id = ?").get("evt_dummy_signed")?.n ?? 0) === 0
    );
    clearEnv();

    // -- (h2p) dummy paypal creds: a verifier-accepted event must not upgrade --
    console.log("(h2p) dummy paypal creds: verified event rejected");
    setEnv({
      BILLING_PROVIDER: "paypal",
      PAYPAL_CLIENT_ID: "DUMMY_paypal_client_id",
      PAYPAL_CLIENT_SECRET: "DUMMY_paypal_client_secret",
      PAYPAL_WEBHOOK_ID: "DUMMY_paypal_webhook_id",
      PAYPAL_PLAN_ID: "DUMMY_paypal_plan_id",
    });
    const ppDummyBody = paypalSubscriptionBody("WH-EVT-DUMMY-SIGNED", "BILLING.SUBSCRIPTION.ACTIVATED", userId);
    const ppDummyHook = await withStub(paypalResponder(), () =>
      api(null, "POST", "/api/billing/webhook/paypal", {
        body: ppDummyBody,
        headers: Object.fromEntries(paypalHeaders().entries()),
      })
    );
    check("h14: paypal verified event while unconfigured → 400", ppDummyHook.result.status, 400);
    checkTrue(
      "h15: paypal reason names placeholders",
      String(ppDummyHook.result.json.error ?? "").includes("placeholder"),
      String(ppDummyHook.result.json.error ?? "")
    );
    check(
      "h16: tier stays free",
      db.query<{ tier: string }, [number]>("SELECT tier FROM users WHERE id = ?").get(userId)!.tier,
      "free"
    );
    checkTrue(
      "h17: no billing_events row written",
      (db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM billing_events WHERE event_id = ?").get("WH-EVT-DUMMY-SIGNED")?.n ?? 0) === 0
    );
    clearEnv();

    // -- (u) tier changes on verified events --------------------------------------
    console.log("(u) tier changes on verified events");
    setEnv({
      BILLING_PROVIDER: "stripe",
      STRIPE_SECRET_KEY: "sk_shape_real_for_upgrade_test",
      STRIPE_PRICE_ID: "price_shape_real_for_upgrade_test",
      STRIPE_WEBHOOK_SECRET: STRIPE_WEBHOOK_SECRET_FIXTURE,
    });
    const user = findUserById(userId)!;
    const safeUser: SafeUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      tier: user.tier,
      created_at: user.created_at,
    };
    check("u1: user starts free", safeUser.tier, "free");
    // Fixture for THIS test user — upgrade events must target a real, disposable row.
    const upgrade = stripeSignedBody("evt_sig_ok", userId);
    const tierOf = () =>
      db.query<{ tier: string }, [number]>("SELECT tier FROM users WHERE id = ?").get(userId)!.tier;
    const rejected = await api(null, "POST", "/api/billing/webhook/stripe", {
      body: upgrade.body,
      headers: { "stripe-signature": "t=1700000000,v1=deadbeefdeadbeefdeadbeefdeadbeef" },
    });
    check("u2: rejected signature via API → 400", rejected.status, 400);
    check("u3: tier still free after rejected webhook", tierOf(), "free");
    const ok1 = await api(null, "POST", "/api/billing/webhook/stripe", {
      body: upgrade.body,
      headers: { "stripe-signature": upgrade.signature },
    });
    check("u4: verified event → 200", ok1.status, 200);
    check("u5: handled true", ok1.json.handled, true);
    check("u6: tier flipped to pro", tierOf(), "pro");
    const row = db
      .query<{ billing_provider: string; billing_customer_id: string; billing_subscription_id: string }, [number]>(
        "SELECT billing_provider, billing_customer_id, billing_subscription_id FROM users WHERE id = ?"
      )
      .get(userId)!;
    check("u7: provider recorded", row.billing_provider, "stripe");
    check("u8: customer id recorded", row.billing_customer_id, "cus_test_fixture");
    check("u9: subscription id recorded", row.billing_subscription_id, "sub_test_fixture");
    const events = () =>
      db
        .query<{ n: number }, [string, string]>(
          "SELECT COUNT(*) AS n FROM billing_events WHERE provider = ? AND event_id = ?"
        )
        .get("stripe", "evt_sig_ok")!.n;
    check("u10: one billing_events row", events(), 1);
    const replay = await api(null, "POST", "/api/billing/webhook/stripe", {
      body: upgrade.body,
      headers: { "stripe-signature": upgrade.signature },
    });
    check("u11: replay → 200", replay.status, 200);
    check("u12: replay is idempotent (still one row)", events(), 1);
    check("u13: replay still pro", tierOf(), "pro");
    // Verified but non-upgrade event type: no tier change, no error.
    const otherBody = JSON.stringify({ id: "evt_other", type: "invoice.created", data: { object: {} } });
    const tNow = Math.floor(Date.now() / 1000);
    const other = await api(null, "POST", "/api/billing/webhook/stripe", {
      body: otherBody,
      headers: {
        "stripe-signature": `t=${tNow},v1=${computeStripeSignature(STRIPE_WEBHOOK_SECRET_FIXTURE, tNow, otherBody)}`,
      },
    });
    check("u14: unrelated verified event → 200 not handled", other.json.handled, false);
    check("u15: unrelated event leaves tier pro", tierOf(), "pro");
    // Cross-provider guard: razorpay webhook while BILLING_PROVIDER=stripe.
    const rzpX = razorpaySignedBody(userId);
    const cross = await api(null, "POST", "/api/billing/webhook/razorpay", {
      body: rzpX.body,
      headers: { "x-razorpay-signature": rzpX.signature },
    });
    check("u16: non-selected provider webhook → 400", cross.status, 400);
    // Razorpay path fully upgrades when selected.
    setEnv({
      BILLING_PROVIDER: "razorpay",
      RAZORPAY_KEY_ID: "rzp_shape_real",
      RAZORPAY_KEY_SECRET: "rzp_secret_shape_real",
      RAZORPAY_WEBHOOK_SECRET: RAZORPAY_WEBHOOK_SECRET_FIXTURE,
    });
    db.run("UPDATE users SET tier = 'free' WHERE id = ?", [userId]);
    const rzpOk = await api(null, "POST", "/api/billing/webhook/razorpay", {
      body: rzpX.body,
      headers: { "x-razorpay-signature": rzpX.signature },
    });
    check("u17: verified razorpay event → 200 handled", rzpOk.json.handled, true);
    check("u18: razorpay upgrade flips tier to pro", tierOf(), "pro");
    check(
      "u19: razorpay customer id recorded",
      db.query<{ billing_customer_id: string }, [number]>(
        "SELECT billing_customer_id FROM users WHERE id = ?"
      ).get(userId)!.billing_customer_id,
      "cust_test_fixture"
    );

    // -- (u) PayPal upgrade / renewal / downgrade --------------------------------
    setEnv({
      BILLING_PROVIDER: "paypal",
      PAYPAL_CLIENT_ID: "paypal-client-id-shape-real",
      PAYPAL_CLIENT_SECRET: "paypal-client-secret-shape-real",
      PAYPAL_WEBHOOK_ID: PAYPAL_WEBHOOK_ID_FIXTURE,
      PAYPAL_PLAN_ID: "P-9TESTSHAPEONLY",
    });
    db.run("UPDATE users SET tier = 'free', billing_subscription_id = '' WHERE id = ?", [userId]);
    const ppHeaders = Object.fromEntries(paypalHeaders().entries());
    const activated = paypalSubscriptionBody("WH-EVT-ACTIVATED", "BILLING.SUBSCRIPTION.ACTIVATED", userId);
    const ppUpgrade = await withStub(paypalResponder(), () =>
      api(null, "POST", "/api/billing/webhook/paypal", { body: activated, headers: ppHeaders })
    );
    check("u20: paypal ACTIVATED → 200", ppUpgrade.result.status, 200);
    check("u21: paypal ACTIVATED handled", ppUpgrade.result.json.handled, true);
    check("u22: paypal action upgrade", ppUpgrade.result.json.action, "upgrade");
    check("u23: paypal upgrade flips tier to pro", tierOf(), "pro");
    const ppRow = db
      .query<{ billing_provider: string; billing_subscription_id: string }, [number]>(
        "SELECT billing_provider, billing_subscription_id FROM users WHERE id = ?"
      )
      .get(userId)!;
    check("u24: paypal provider recorded", ppRow.billing_provider, "paypal");
    check("u25: paypal subscription id recorded", ppRow.billing_subscription_id, "I-TESTFIXTURE");
    const ppEvents = () =>
      db
        .query<{ n: number }, [string, string]>(
          "SELECT COUNT(*) AS n FROM billing_events WHERE provider = ? AND event_id = ?"
        )
        .get("paypal", "WH-EVT-ACTIVATED")!.n;
    check("u26: one paypal billing_events row", ppEvents(), 1);
    const ppReplay = await withStub(paypalResponder(), () =>
      api(null, "POST", "/api/billing/webhook/paypal", { body: activated, headers: ppHeaders })
    );
    check("u27: paypal replay → 200", ppReplay.result.status, 200);
    check("u28: paypal replay idempotent (still one row)", ppEvents(), 1);
    // Renewal payment: only the agreement id ties it to the user.
    db.run("UPDATE users SET tier = 'free' WHERE id = ?", [userId]);
    const sale = paypalSaleBody("WH-EVT-SALE", "I-TESTFIXTURE");
    const ppSale = await withStub(paypalResponder(), () =>
      api(null, "POST", "/api/billing/webhook/paypal", { body: sale, headers: ppHeaders })
    );
    check("u29: PAYMENT.SALE.COMPLETED handled", ppSale.result.json.handled, true);
    check("u30: renewal re-upgrades via subscription id", tierOf(), "pro");
    // Cancellation downgrades back to Free.
    const cancelled = paypalSubscriptionBody("WH-EVT-CANCELLED", "BILLING.SUBSCRIPTION.CANCELLED", userId);
    const ppCancel = await withStub(paypalResponder(), () =>
      api(null, "POST", "/api/billing/webhook/paypal", { body: cancelled, headers: ppHeaders })
    );
    check("u31: paypal CANCELLED → 200", ppCancel.result.status, 200);
    check("u32: paypal action downgrade", ppCancel.result.json.action, "downgrade");
    check("u33: cancellation flips tier back to free", tierOf(), "free");
    const ppCancelReplay = await withStub(paypalResponder(), () =>
      api(null, "POST", "/api/billing/webhook/paypal", { body: cancelled, headers: ppHeaders })
    );
    check("u34: cancellation replay → 200", ppCancelReplay.result.status, 200);
    checkTrue(
      "u35: cancellation replay writes no second row",
      (db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM billing_events WHERE event_id = ?").get("WH-EVT-CANCELLED")?.n ?? 0) === 1
    );
    // Bad PayPal verdict never changes a tier.
    db.run("UPDATE users SET tier = 'free' WHERE id = ?", [userId]);
    const ppBadSig = await withStub(paypalResponder({ verifyStatus: "FAILURE" }), () =>
      api(null, "POST", "/api/billing/webhook/paypal", {
        body: paypalSubscriptionBody("WH-EVT-BAD-SIG", "BILLING.SUBSCRIPTION.ACTIVATED", userId),
        headers: ppHeaders,
      })
    );
    check("u36: paypal FAILURE verdict → 400", ppBadSig.result.status, 400);
    check("u37: bad paypal verdict leaves tier free", tierOf(), "free");
    // Cross-provider guard: paypal webhook while BILLING_PROVIDER=stripe.
    setEnv({
      BILLING_PROVIDER: "stripe",
      STRIPE_SECRET_KEY: "sk_shape_real_for_upgrade_test",
      STRIPE_PRICE_ID: "price_shape_real_for_upgrade_test",
      STRIPE_WEBHOOK_SECRET: STRIPE_WEBHOOK_SECRET_FIXTURE,
    });
    const ppCross = await withStub(paypalResponder(), () =>
      api(null, "POST", "/api/billing/webhook/paypal", {
        body: paypalSubscriptionBody("WH-EVT-CROSS", "BILLING.SUBSCRIPTION.ACTIVATED", userId),
        headers: ppHeaders,
      })
    );
    check("u38: paypal webhook while stripe selected → 400", ppCross.result.status, 400);
    checkTrue(
      "u39: cross-provider reason names the mismatch",
      String(ppCross.result.json.error ?? "").includes("does not match"),
      String(ppCross.result.json.error ?? "")
    );
    check("u40: cross-provider event leaves tier free", tierOf(), "free");
  } finally {
    // -- cleanup -----------------------------------------------------------------
    if (userId) {
      db.run("DELETE FROM billing_events WHERE user_id = ?", [userId]);
      db.run("DELETE FROM sessions WHERE user_id = ?", [userId]);
      db.run("DELETE FROM users WHERE id = ?", [userId]);
    }
    restoreEnv();
  }
  if (failures > 0) {
    console.error(`billing-test: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("billing-test: all assertions pass");
}

main().catch((err) => {
  console.error("billing-test crashed:", err);
  process.exit(1);
});
