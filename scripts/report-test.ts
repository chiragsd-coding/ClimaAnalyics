/**
 * PDF report tests (Slice 5).
 *
 *   bun scripts/report-test.ts
 *
 * Exits non-zero on any failed assertion. Tests:
 *  (a) GET /api/areas/:id/analyses/:aid/report.pdf returns bytes starting with
 *      %PDF and a non-trivial size (via the real REST dispatcher + session).
 *  (b) the generated report's text contains the CREDIBILITY_RISKS §5
 *      disclaimer sentence and a §4 per-hazard label, and contains none of the
 *      banned words (verified / certified / compliant).
 *  (c) RBAC: an authenticated user without access to the area gets 403.
 */
import { db } from "~/lib/db";
import { createSession, createUser } from "~/lib/auth";
import { SESSION_COOKIE } from "~/lib/auth";
import { handleApiRequest } from "../src/rest/api";
import {
  buildReportPdf,
  loadReportData,
  mergedHazardSources,
  REPORT_DISCLAIMER,
  REQUIRED_LABELS,
  BANNED_WORDS,
} from "~/lib/report";
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

async function getReportBytes(
  cookie: string,
  areaId: number,
  analysisId: number
): Promise<{ status: number; body: ArrayBuffer; contentType: string | null }> {
  const res = await handleApiRequest(
    new Request(`http://localhost/api/areas/${areaId}/analyses/${analysisId}/report.pdf`, {
      headers: { cookie },
    })
  );
  return { status: res.status, body: await res.arrayBuffer(), contentType: res.headers.get("content-type") };
}

// -- fixture ----------------------------------------------------------------
async function fixtureAnalysis(): Promise<{ areaId: number; analysisId: number }> {
  const demo = db
    .query<{ id: number }, []>("SELECT id FROM areas WHERE is_demo = 1 ORDER BY id LIMIT 1")
    .get();
  if (!demo) throw new Error("No demo area seeded — run bun scripts/seed.ts first.");
  const existing = db
    .query<{ id: number }, [number]>(
      "SELECT id FROM analyses WHERE area_id = ? AND status = 'complete' ORDER BY id DESC LIMIT 1"
    )
    .get(demo.id);
  if (existing) return { areaId: demo.id, analysisId: existing.id };
  // No saved analysis — score the demo area so the fixture is real.
  const area = db.query<AreaRowShape, [number]>("SELECT * FROM areas WHERE id = ?").get(demo.id)!;
  const { analysisId } = await runAnalysisForArea(area, 1);
  return { areaId: demo.id, analysisId };
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
    const { areaId, analysisId } = await fixtureAnalysis();
    checkTrue("fixture: demo area + complete analysis ready", areaId > 0 && analysisId > 0);

    // (a) endpoint returns a real PDF
    const owner = await createUser({
      email: `report-owner-${Date.now()}@throwaway.local`,
      name: "Report Owner",
      password: "throwaway-pass-12345",
      role: "analyst",
    });
    userIds.push(owner.id);
    const ownerCookie = cookieFor(owner.id);

    // (a1) demo area is visible to every account → 200 for the analyst owner.
    const demoRes = await getReportBytes(ownerCookie, areaId, analysisId);
    checkTrue(
      "a1: endpoint returns HTTP 200 for an analyst on the demo area",
      demoRes.status === 200,
      `status=${demoRes.status}`
    );
    const magic = new TextDecoder().decode(demoRes.body.slice(0, 5));
    check("a2: body starts with %PDF", magic, "%PDF-");
    checkTrue(
      "a3: body is a non-trivial size",
      demoRes.body.byteLength > 5_000,
      `size=${demoRes.body.byteLength}`
    );
    check("a4: content-type is application/pdf", demoRes.contentType, "application/pdf");

    // (b) text content rules — built straight from the same data path, plus a
    // raw-byte scan of the real PDF so the check covers what ships.
    const areaRow = db.query<AreaRowShape, [number]>("SELECT * FROM areas WHERE id = ?").get(areaId)!;
    const analysisRow = db
      .query<AnalysisRowShape, [number, number]>("SELECT * FROM analyses WHERE id = ? AND area_id = ?")
      .get(analysisId, areaId)!;
    const { text } = await buildReportPdf(loadReportData(areaRow, analysisRow));

    checkTrue(
      "b1: §5 disclaimer sentence present in report text",
      text.includes("model estimates of hazard exposure at each structure's location") &&
        text.includes("not a substitute for site inspection"),
      "disclaimer missing from text layer"
    );
    const merged = mergedHazardSources(analysisId);
    const someLabel = Object.keys(REQUIRED_LABELS).find((h) => h in merged);
    checkTrue(
      "b2: a §4 per-hazard label is present",
      (someLabel && text.includes(REQUIRED_LABELS[someLabel])) || false,
      someLabel ? `missing: ${REQUIRED_LABELS[someLabel]}` : "no scored hazards in fixture"
    );
    const banned = BANNED_WORDS.filter((w) => new RegExp(`\\b${w}\\b`, "i").test(text));
    checkTrue("b3: banned words absent from report text", banned.length === 0, `found: ${banned.join(",")}`);
    const rawLower = new TextDecoder().decode(demoRes.body).toLowerCase();
    const bannedRaw = BANNED_WORDS.filter((w) => rawLower.includes(w));
    checkTrue("b4: banned words absent from raw PDF bytes", bannedRaw.length === 0, `found: ${bannedRaw.join(",")}`);
    checkTrue(
      "b5: demo tag on page 1 of demo report",
      text.includes("Demo — public data only"),
      "demo tag missing"
    );

    // (c) RBAC: analyst with no grant on a non-demo area → 403.
    const target = {
      name: `Report RBAC area ${Date.now()}`,
      city: "",
      country: "",
      center_lat: 40.7,
      center_lng: -74.0,
      radius_km: 0.5,
      climate_type: "temperate",
      is_demo: 0,
      created_by: owner.id,
    };
    const ins = db.run(
      `INSERT INTO areas (name, city, country, center_lat, center_lng, radius_km, climate_type, is_demo, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [target.name, target.city, target.country, target.center_lat, target.center_lng,
        target.radius_km, target.climate_type, target.is_demo, target.created_by]
    );
    const rbacAreaId = Number(ins.lastInsertRowid);
    areaIdToClean = rbacAreaId;
    db.run("INSERT INTO area_access (area_id, user_id, granted_by) VALUES (?, ?, ?)", [
      rbacAreaId,
      owner.id,
      owner.id,
    ]);
    const insA = db.run(
      `INSERT INTO analyses (area_id, climate_type, status, params, created_by, created_at)
       VALUES (?, ?, 'complete', ?, ?, ?)`,
      [rbacAreaId, "temperate", JSON.stringify({ model_version: "maxmean-v1" }), owner.id, new Date().toISOString()]
    );
    const rbacAnalysisId = Number(insA.lastInsertRowid);

    // owner has access → 200
    const ownerRbac = await getReportBytes(ownerCookie, rbacAreaId, rbacAnalysisId);
    checkTrue("c0: owner (granted) can download", ownerRbac.status === 200, `status=${ownerRbac.status}`);
    checkTrue("c1: owner download is a PDF", new TextDecoder().decode(ownerRbac.body.slice(0, 5)) === "%PDF-");

    // unrelated analyst user, no grant → 403 (per slice brief; not the usual 404)
    const stranger = await createUser({
      email: `report-stranger-${Date.now()}@throwaway.local`,
      name: "Report Stranger",
      password: "throwaway-pass-12345",
      role: "analyst",
    });
    userIds.push(stranger.id);
    const strangerRes = await getReportBytes(cookieFor(stranger.id), rbacAreaId, rbacAnalysisId);
    check("c2: user without access gets 403", strangerRes.status, 403);

    // unauthenticated → 401
    const anon = await getReportBytes("", rbacAreaId, rbacAnalysisId);
    check("c3: unauthenticated gets 401", anon.status, 401);

    // viewer role (granted) → 403
    const viewer = await createUser({
      email: `report-viewer-${Date.now()}@throwaway.local`,
      name: "Report Viewer",
      password: "throwaway-pass-12345",
      role: "viewer",
    });
    userIds.push(viewer.id);
    db.run("INSERT INTO area_access (area_id, user_id, granted_by) VALUES (?, ?, ?)", [
      rbacAreaId,
      viewer.id,
      owner.id,
    ]);
    const viewerRes = await getReportBytes(cookieFor(viewer.id), rbacAreaId, rbacAnalysisId);
    check("c4: viewer role gets 403 even with access", viewerRes.status, 403);
  } finally {
    // clean up throwaway rows (FKs cascade for analyses/access/scores)
    if (areaIdToClean !== null) db.run("DELETE FROM areas WHERE id = ?", [areaIdToClean]);
    for (const id of userIds) db.run("DELETE FROM users WHERE id = ?", [id]);
  }

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) FAILED`);
    process.exit(1);
  }
  console.log("\nreport tests OK");
}

type AnalysisRowShape = {
  id: number;
  area_id: number;
  climate_type: string;
  status: string;
  params: string | null;
  summary: string | null;
  sources: string | null;
  created_by: number | null;
  created_at: string;
  completed_at: string | null;
};

void main().catch((e) => {
  console.error("report test crashed:", e);
  process.exit(1);
});