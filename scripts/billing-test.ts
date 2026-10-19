/**
 * Billing gateway tests (env-selected provider: Stripe | Razorpay).
 *
 *   bun scripts/billing-test.ts
 *
 * Exits non-zero on any failed assertion. Coverage:
 *  (s) provider selection from env — absent/bogus/dummy creds stay disabled,
 *      full creds select the right implementation.
 *  (h) honest no-creds checkout state — unauthenticated 401; with no provider
 *      (or DUMMY_ creds) the endpoint returns PLANS.billingNote verbatim and
 *      never a checkout URL.
 *  (w) webhook signature verification — Stripe (t/v1 HMAC) and Razorpay
 *      (raw-body HMAC): good fixtures verify; tampered body, wrong secret,
 *      stale timestamp and missing header all fail. Uses verifyWebhook
 *      directly (pure, no DB writes).
 *  (u) tier upgrade on a verified event — flips the paying user to Pro,
 *      records customer/subscription ids, is idempotent on replay, and a bad
 *      signature can never upgrade anyone. A verified event for the
 *      non-selected provider is rejected.
 *
 * The fixture secrets below are test-only values, clearly named; no real or
 * placeholder credential value is committed.
 */
import { db } from "~/lib/db";
import { createUser, createSession, findUserById, SESSION_COOKIE, type SafeUser } from "~/lib/auth";
import { handleApiRequest } from "../src/rest/api";
import { PLANS } from "~/lib/plans";
import {
  BILLING_ENV_VARS,
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

// -- webhook fixtures (test-only secrets, clearly named) -----------------------
const STRIPE_WEBHOOK_SECRET_FIXTURE = "whsec-test-fixture-not-a-real-secret";
const RAZORPAY_WEBHOOK_SECRET_FIXTURE = "rzp-whsec-test-fixture-not-a-real-secret";

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

async function main() {
  let userId = 0;
  try {
    // -- (s) provider selection ------------------------------------------------
    console.log("(s) provider selection");
    setEnv({});
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
      STRIPE_SECRET_KEY: "x",
      STRIPE_PRICE_ID: "x",
      STRIPE_WEBHOOK_SECRET: "x",
    });
    check("s8: unsupported provider → none", resolveBillingProvider().provider, null);
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
      BILLING_ENV_VARS.stripe.length === 3 && BILLING_ENV_VARS.razorpay.length === 3
    );

    // -- (w) webhook signature verification (pure verifyWebhook, no DB) ----------
    console.log("(w) webhook signature verification");
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
    const signed = stripeSignedBody("evt_sig_ok", 1);
    const good = stripe.verifyWebhook(signed.body, signed.signature);
    checkTrue("w1: stripe good fixture verifies", good.ok && good.event.type === "checkout.session.completed");
    checkTrue(
      "w1b: stripe good fixture parses event id",
      good.ok && good.event.id === "evt_sig_ok"
    );
    const tampered = stripe.verifyWebhook(signed.body + " ", signed.signature);
    checkTrue("w2: stripe tampered body rejected", !tampered.ok);
    const crossSigned = stripeSignedBody("evt_ws", 1, "whsec-a-different-fixture-secret");
    checkTrue(
      "w3: stripe body signed with another secret rejected",
      !stripe.verifyWebhook(crossSigned.body, crossSigned.signature).ok
    );
    const oldBody = JSON.stringify({ id: "evt_old", type: "checkout.session.completed", data: { object: {} } });
    const oldT = Math.floor(Date.now() / 1000) - 3600;
    const oldSig = `t=${oldT},v1=${computeStripeSignature(STRIPE_WEBHOOK_SECRET_FIXTURE, oldT, oldBody)}`;
    checkTrue("w4: stripe stale timestamp rejected", !stripe.verifyWebhook(oldBody, oldSig).ok);
    checkTrue("w5: stripe missing header rejected", !stripe.verifyWebhook(signed.body, null).ok);
    checkTrue("w6: stripe malformed header rejected", !stripe.verifyWebhook(signed.body, "v1=deadbeef").ok);
    const rzp = razorpaySignedBody(1);
    const rzpGood = razorpay.verifyWebhook(rzp.body, rzp.signature);
    checkTrue("w7: razorpay good fixture verifies", rzpGood.ok && rzpGood.event.type === "payment_link.paid");
    checkTrue("w8: razorpay tampered body rejected", !razorpay.verifyWebhook(rzp.body + " ", rzp.signature).ok);
    const rzpCross = razorpaySignedBody(1, "rzp-whsec-a-different-fixture", "plink_other_fixture");
    checkTrue(
      "w9: razorpay body signed with another secret rejected",
      !razorpay.verifyWebhook(rzpCross.body, rzp.signature).ok
    );
    checkTrue("w10: razorpay missing header rejected", !razorpay.verifyWebhook(rzp.body, null).ok);
    checkTrue("w11: unknown provider path rejected", !handleBillingWebhook("paypal", "{}", "x").ok);

    // -- (h) honest no-creds checkout state --------------------------------------
    console.log("(h) honest no-creds checkout state");
    setEnv({}); // ensure nothing is configured
    const fresh = await createUser({
      email: `billing-test-${Date.now()}@example.com`,
      name: "Billing Test",
      password: "correct-horse-battery-staple",
      role: "analyst",
    });
    userId = fresh.id;
    const cookie = cookieFor(userId);
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
    setEnv({});

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
    setEnv({});

    // -- (u) tier upgrade on verified event --------------------------------------
    console.log("(u) tier upgrade on verified event");
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
