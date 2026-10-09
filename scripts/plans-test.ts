/**
 * Plans / subscription-tier gate tests (Slice 6).
 *
 *   bun scripts/plans-test.ts
 *
 * Exits non-zero on any failed assertion. Tests:
 *  (t) pure helpers: tierFor / canCreateOwnedArea / canRunPaidAnalysis /
 *      canDownloadReport / canUseApi against the owner-ratified matrix.
 *  (p) REST gates: Free blocked from owned-area creation (403) and report
 *      download (403); Free still allowed to run the demo area; Pro and
 *      Enterprise allowed to create areas and download reports; enterprise
 *      contact/lead endpoint saves a row.
 */
import { db } from "~/lib/db";
import { createSession, createUser, type SafeUser } from "~/lib/auth";
import { SESSION_COOKIE } from "~/lib/auth";
import { handleApiRequest } from "../src/rest/api";
import {
  PLANS,
  PRO_PRICE_MONTHLY,
  canCreateOwnedArea,
  canDownloadReport,
  canRunPaidAnalysis,
  canUseApi,
  tierFor,
  upsellMessage,
  type Tier,
} from "~/lib/plans";
import { runAnalysisForArea } from "~/lib/scoring";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  const ok =
    typeof want === "number" && typeof got === "number"
      ? Math.abs((got as number) - (want as number)) <= 1e-6
      : got === want;
  if (!ok) {
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

function cookieFor(userId: number): string {
  const { token } = createSession(userId);
  return `${SESSION_COOKIE}=${token}`;
}

async function api(
  cookie: string,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await handleApiRequest(
    new Request(`http://localhost${path}`, {
      method,
      headers: { cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  );
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/** Ensure the demo area has a complete analysis (mirror of report-test). */
async function demoAnalysisId(): Promise<number> {
  const demo = db
    .query<{ id: number }, []>("SELECT id FROM areas WHERE is_demo = 1 ORDER BY id LIMIT 1")
    .get();
  if (!demo) throw new Error("No demo area seeded — run bun scripts/seed.ts first.");
  const existing = db
    .query<{ id: number }, [number]>(
      "SELECT id FROM analyses WHERE area_id = ? AND status = 'complete' ORDER BY id DESC LIMIT 1"
    )
    .get(demo.id);
  if (existing) return existing.id;
  const area = db.query<Record<string, unknown>, [number]>("SELECT * FROM areas WHERE id = ?").get(demo.id)!;
  const { analysisId } = await runAnalysisForArea(area as never, 1);
  return analysisId;
}

type AreaRowShape = {
  id: number;
  name: string;
  city: string;
  country: string;
  center_lat: number;
  center_lng: number;
  radius_km: number;
  climate_type: string;
  is_demo: number;
  created_by: number | null;
  created_at: string;
  fetch_status: string | null;
  fetch_note: string | null;
  fetched_at: string | null;
};

async function main() {
  const userIds: number[] = [];
  let areaIdToClean: number | null = null;
  try {
    // -- (t) pure helper tests ------------------------------------------------
    const U = (tier?: Tier): SafeUser => ({ id: 1, email: "x@y.z", name: "X", role: "analyst", tier: tier ?? "free", created_at: "" });
    check("t1: tierFor(null) is free", tierFor(null), "free");
    check("t2: tierFor(free) is free", tierFor(U("free")), "free");
    check("t3: tierFor(pro) is pro", tierFor(U("pro")), "pro");
    check("t4: tierFor(enterprise) is enterprise", tierFor(U("enterprise")), "enterprise");
    check("t5: PRO_PRICE_MONTHLY is 99", PRO_PRICE_MONTHLY, 99);
    check("t6: pro price label", PLANS.tiers.pro.price, "$99/month");
    check("t7: free blurb", PLANS.tiers.free.blurb, "Demo area only (Downtown Miami)");
    check("t8: enterprise blurb", PLANS.tiers.enterprise.blurb, "Team RBAC, bulk areas, API");
    check("t9: free cannot create owned areas", canCreateOwnedArea(U("free")), false);
    check("t10: pro can create owned areas", canCreateOwnedArea(U("pro")), true);
    check("t11: enterprise can create owned areas", canCreateOwnedArea(U("enterprise")), true);
    check("t12: free cannot run paid analyses", canRunPaidAnalysis(U("free")), false);
    check("t13: pro can run paid analyses", canRunPaidAnalysis(U("pro")), true);
    check("t14: free cannot download reports", canDownloadReport(U("free")), false);
    check("t15: pro can download reports", canDownloadReport(U("pro")), true);
    check("t16: enterprise can download reports", canDownloadReport(U("enterprise")), true);
    check("t17: api is enterprise-only", canUseApi(U("pro")), false);
    check("t18: api for enterprise", canUseApi(U("enterprise")), true);
    checkTrue("t19: upsell copy names Pro price and billing note",
      upsellMessage("Owned areas").includes("$99") && upsellMessage("Owned areas").includes("Billing is being connected"),
      upsellMessage("Owned areas"));

    // -- fixtures -------------------------------------------------------------
    const analysisId = await demoAnalysisId();
    const demo = db.query<{ id: number }, []>("SELECT id FROM areas WHERE is_demo = 1 ORDER BY id LIMIT 1").get()!;

    const free = await createUser({ email: `plans-free-${Date.now()}@throwaway.local`, name: "Plans Free", password: "throwaway-pass-12345", role: "analyst" });
    db.run("UPDATE users SET tier = 'free' WHERE id = ?", [free.id]);
    const pro = await createUser({ email: `plans-pro-${Date.now()}@throwaway.local`, name: "Plans Pro", password: "throwaway-pass-12345", role: "analyst" });
    db.run("UPDATE users SET tier = 'pro' WHERE id = ?", [pro.id]);
    const ent = await createUser({ email: `plans-ent-${Date.now()}@throwaway.local`, name: "Plans Ent", password: "throwaway-pass-12345", role: "analyst" });
    db.run("UPDATE users SET tier = 'enterprise' WHERE id = ?", [ent.id]);
    userIds.push(free.id, pro.id, ent.id);

    const freeCookie = cookieFor(free.id);
    const proCookie = cookieFor(pro.id);
    const entCookie = cookieFor(ent.id);

    // An owned (non-demo) area with a complete analysis and a Pro grant.
    const ins = db.run(
      `INSERT INTO areas (name, city, country, center_lat, center_lng, radius_km, climate_type, is_demo, created_by)
       VALUES (?, '', '', 40.7, -74.0, 0.5, 'temperate', 0, ?)`,
      [`Plans owned area ${Date.now()}`, pro.id]
    );
    const ownedAreaId = Number(ins.lastInsertRowid);
    areaIdToClean = ownedAreaId;
    db.run("INSERT INTO area_access (area_id, user_id, granted_by) VALUES (?, ?, ?)", [ownedAreaId, pro.id, pro.id]);
    // The free user also gets a grant (shared-area scenario) so the paywall —
    // not the area-scoped 404 convention — is what blocks the owned-area run.
    db.run("INSERT INTO area_access (area_id, user_id, granted_by) VALUES (?, ?, ?)", [ownedAreaId, free.id, pro.id]);
    const insA = db.run(
      `INSERT INTO analyses (area_id, climate_type, status, params, created_by, created_at)
       VALUES (?, 'temperate', 'complete', ?, ?, ?)`,
      [ownedAreaId, JSON.stringify({ model_version: "maxmean-v1" }), pro.id, new Date().toISOString()]
    );
    const ownedAnalysisId = Number(insA.lastInsertRowid);

    // -- (p) REST gates -------------------------------------------------------
    // p1–p3: Free is blocked from owned-area creation with an honest upsell.
    const freeCreate = await api(freeCookie, "POST", "/api/areas", {
      name: "Free attempt", center_lat: 40.7, center_lng: -74.0, radius_km: 0.5, climate_type: "temperate",
    });
    check("p1: free POST /api/areas → 403", freeCreate.status, 403);
    checkTrue("p2: free upsell names Pro $99/mo",
      typeof freeCreate.json.error === "string" && freeCreate.json.error.includes("$99"),
      String(freeCreate.json.error));
    checkTrue("p3: free upsell is honest (no urgency language)",
      typeof freeCreate.json.error === "string" &&
        !/urge|immediate|act now|limited|expires/i.test(freeCreate.json.error),
      String(freeCreate.json.error));

    // p4–p5: Free cannot download a report (demo is visible, report still gated).
    const freeReport = await api(freeCookie, "GET", `/api/areas/${demo.id}/analyses/${analysisId}/report.pdf`);
    check("p4: free report download → 403", freeReport.status, 403);
    checkTrue("p5: free report error names Pro",
      typeof freeReport.json.error === "string" && freeReport.json.error.includes("Pro"),
      String(freeReport.json.error));

    // p6: Free may still run the demo area (the marketing hook).
    const freeDemoRun = await api(freeCookie, "POST", `/api/areas/${demo.id}/analyses`);
    check("p6: free can run demo-area analysis → 200", freeDemoRun.status, 200);

    // p7: Free is blocked from owned-area analyses.
    const freeOwnedRun = await api(freeCookie, "POST", `/api/areas/${ownedAreaId}/analyses`);
    check("p7: free owned-area analysis → 403", freeOwnedRun.status, 403);
    checkTrue("p8: owned-area block names Pro",
      typeof freeOwnedRun.json.error === "string" && freeOwnedRun.json.error.includes("Pro"),
      String(freeOwnedRun.json.error));

    // p9–p12: Pro can create owned areas and download reports.
    const proCreate = await api(proCookie, "POST", "/api/areas", {
      name: "Pro attempt", center_lat: 40.7, center_lng: -74.0, radius_km: 0.5, climate_type: "temperate",
    });
    check("p9: pro POST /api/areas → 201", proCreate.status, 201);
    const ownedReport = await api(proCookie, "GET", `/api/areas/${ownedAreaId}/analyses/${ownedAnalysisId}/report.pdf`);
    check("p10: pro owned-area report → 200", ownedReport.status, 200);
    const proDemoReport = await api(proCookie, "GET", `/api/areas/${demo.id}/analyses/${analysisId}/report.pdf`);
    check("p11: pro demo-area report → 200", proDemoReport.status, 200);

    // p12–p14: Enterprise can create, download, and use the API-facing gates.
    const entCreate = await api(entCookie, "POST", "/api/areas", {
      name: "Ent attempt", center_lat: 40.7, center_lng: -74.0, radius_km: 0.5, climate_type: "temperate",
    });
    check("p12: enterprise POST /api/areas → 201", entCreate.status, 201);
    const entReport = await api(entCookie, "GET", `/api/areas/${demo.id}/analyses/${analysisId}/report.pdf`);
    check("p13: enterprise demo report → 200", entReport.status, 200);

    // p14–p18: lead capture endpoint saves a row (enterprise CTA).
    const lead = await api(entCookie, "POST", "/api/contact/lead", {
      name: "Enterprise Buyer", org: "ACME Re", note: "Interested in bulk areas + API.",
    });
    check("p14: POST /api/contact/lead → 201", lead.status, 201);
    const leadRow = db
      .query<{ id: number; name: string; org: string; note: string }, [number]>(
        "SELECT id, name, org, note FROM lead_requests WHERE id = ?"
      )
      .get(Number(lead.json.id));
    checkTrue("p15: lead row saved with name/org/note",
      !!leadRow && leadRow.name === "Enterprise Buyer" && leadRow.org === "ACME Re" && leadRow.note.includes("bulk areas"),
      JSON.stringify(leadRow));
    const anonLead = await api("", "POST", "/api/contact/lead", { name: "Anon", note: "x" });
    check("p16: lead capture requires sign-in → 401", anonLead.status, 401);
  } finally {
    // clean up throwaway rows (FKs cascade for analyses/access/scores/leads)
    if (areaIdToClean !== null) db.run("DELETE FROM areas WHERE id = ?", [areaIdToClean]);
    db.run("DELETE FROM lead_requests WHERE name = 'Enterprise Buyer'");
    for (const id of userIds) db.run("DELETE FROM users WHERE id = ?", [id]);
  }

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) FAILED`);
    process.exit(1);
  }
  console.log("\nplans tests OK");
}

void main().catch((e) => {
  console.error("plans test crashed:", e);
  process.exit(1);
});