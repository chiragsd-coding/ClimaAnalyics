/**
 * Scoring engine unit tests + demo-area validation run.
 *
 *   bun scripts/scoring-test.ts           # unit tests (COMBINATION_RULE §6 A–E etc.)
 *   bun scripts/scoring-test.ts --demo    # + run the seeded Miami demo area analysis
 *
 * Exits non-zero on any failed assertion.
 */
import { db, type AnalysisRow } from "~/lib/db";
import {
  combine,
  WEIGHTS,
  APPLICABILITY,
  ALL_HAZARDS,
  FORMULA_VERSION,
  runAnalysisForArea,
  cacheSrtmTile,
  ensureIbtracsTracks,
  type EvaluatedDimension,
} from "~/lib/scoring";

let failures = 0;
function check(name: string, got: unknown, want: unknown, tol = 1e-6): void {
  const ok =
    typeof want === "number" && typeof got === "number"
      ? Math.abs((got as number) - (want as number)) <= tol
      : got === want;
  if (!ok) {
    failures++;
    console.error(`  FAIL ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  } else {
    console.log(`  ok   ${name}`);
  }
}

function dim(d: string, s: number | null, missing: boolean, w: Record<string, unknown>): EvaluatedDimension {
  return {
    d: d as EvaluatedDimension["d"],
    score: s,
    missing,
    low_confidence: missing,
    coverage_ok: !missing,
    dataset: "test",
    resolution_km: 1,
    attribution: "test",
  };
}

// -- weight table integrity ---------------------------------------------------
for (const c of Object.keys(APPLICABILITY)) {
  const sum = Object.entries(WEIGHTS[c] as Record<string, number>).reduce((a, [, v]) => a + v, 0);
  check(`weights sum to 1 (${c})`, sum, 1);
  const app = APPLICABILITY[c].slice().sort();
  const wkeys = Object.keys(WEIGHTS[c]).sort();
  check(`applicability == weight keys (${c})`, JSON.stringify(app), JSON.stringify(wkeys));
}

// -- COMBINATION_RULE.md §6 worked examples (hard assertions) -----------------
console.log("combination-rule examples A–E:");
{
  const A = combine(
    "tropical",
    ["FLOOD", "CYCLONE_WIND", "EXTREME_HEAT", "WILDFIRE", "STORM_SURGE"].map((d) =>
      dim(d, { FLOOD: 4, CYCLONE_WIND: 5, EXTREME_HEAT: 3, WILDFIRE: 1, STORM_SURGE: 5 }[d], false, {})
    )
  );
  check("A: R = 5", A.R, 5);
  check("A: blend = 4.7375", A.blend, 0.65 * 5 + 0.35 * 4.25);
  check("A: dominant CYCLONE_WIND", A.dominant, "CYCLONE_WIND");

  const B = combine(
    "tropical",
    ["FLOOD", "CYCLONE_WIND", "EXTREME_HEAT", "WILDFIRE", "STORM_SURGE"].map((d) =>
      dim(d, { FLOOD: 2, CYCLONE_WIND: 2, EXTREME_HEAT: 3, WILDFIRE: 1, STORM_SURGE: 1 }[d], false, {})
    )
  );
  check("B: R = 3", B.R, 3);
  check("B: blend = 2.5975", B.blend, 2.5975);
  check("B: dominant EXTREME_HEAT", B.dominant, "EXTREME_HEAT");

  const C = combine(
    "alpine",
    ["SNOW_LOAD", "LANDSLIDE", "WILDFIRE", "FLOOD"].map((d) =>
      dim(d, { SNOW_LOAD: 5, LANDSLIDE: 3, WILDFIRE: 2, FLOOD: 2 }[d], false, {})
    )
  );
  check("C: R = 4 (guard applied)", C.R, 4);
  check("C: blend = 4.4575", C.blend, 4.4575);
  check("C: dominant SNOW_LOAD", C.dominant, "SNOW_LOAD");

  const D = combine(
    "monsoon",
    ["FLOOD", "CYCLONE_WIND", "EXTREME_HEAT", "DROUGHT", "LANDSLIDE"].map((d) =>
      dim(d, { FLOOD: 4, CYCLONE_WIND: 1, EXTREME_HEAT: 3, DROUGHT: 2, LANDSLIDE: 1 }[d], false, {})
    )
  );
  check("D: R = 3", D.R, 3);
  check("D: blend = 3.4925", D.blend, 3.4925);
  check("D: dominant FLOOD", D.dominant, "FLOOD");

  // E: arid with DROUGHT missing → weights renormalised to 0.4286 / 0.2857 / 0.2857
  const E = combine(
    "arid",
    [
      dim("EXTREME_HEAT", 4, false, {}),
      dim("WILDFIRE", 3, false, {}),
      dim("FLOOD", 1, false, {}),
      dim("DROUGHT", null, true, {}),
    ]
  );
  check("E: R = 4", E.R, 4);
  check("E: blend ≈ 3.6", E.blend, 3.6, 0.01);
  check("E: dominant EXTREME_HEAT", E.dominant, "EXTREME_HEAT");

  // safety guard knock-on: 5 anywhere forces ≥ 4 even with green others
  const G = combine(
    "continental",
    ["FLOOD", "EXTREME_HEAT", "WILDFIRE", "SNOW_LOAD"].map((d) =>
      dim(d, { FLOOD: 1, EXTREME_HEAT: 1, WILDFIRE: 1, SNOW_LOAD: 5 }[d], false, {})
    )
  );
  check("guard: s=5 → R ≥ 4", G.R, 4);
  check("guard: dominant SNOW_LOAD", G.dominant, "SNOW_LOAD");

  // determinism
  const again = combine("tropical", [
    dim("FLOOD", 4, false, {}),
    dim("CYCLONE_WIND", 5, false, {}),
    dim("EXTREME_HEAT", 3, false, {}),
    dim("WILDFIRE", 1, false, {}),
    dim("STORM_SURGE", 5, false, {}),
  ]);
  check("determinism: identical inputs → identical R/blend", `${A.R}:${A.blend}`, `${again.R}:${again.blend}`);
  check("formula version constant", FORMULA_VERSION, "maxmean-v1");
}

// -- alpine representative probe: weight table correctness on a synthetic set --
console.log("alpine synthetic structure set (weight-table correctness):");
{
  const alpineCases = [
    { name: "snow-heavy valley", scores: { SNOW_LOAD: 5, LANDSLIDE: 3, WILDFIRE: 2, FLOOD: 2 }, wantR: 4, wantDom: "SNOW_LOAD" },
    { name: "mild valley", scores: { SNOW_LOAD: 2, LANDSLIDE: 1, WILDFIRE: 1, FLOOD: 1 }, wantR: 2, wantDom: "SNOW_LOAD" },
    { name: "all-green", scores: { SNOW_LOAD: 1, LANDSLIDE: 1, WILDFIRE: 1, FLOOD: 1 }, wantR: 1, wantDom: "SNOW_LOAD" }, // tie at 1 → higher weight (0.40)
    { name: "landslide-dominated", scores: { SNOW_LOAD: 2, LANDSLIDE: 5, WILDFIRE: 2, FLOOD: 1 }, wantR: 4, wantDom: "LANDSLIDE" }, // blend 4.16 → 4, guard keeps ≥4
  ];
  for (const c of alpineCases) {
    const r = combine(
      "alpine",
      Object.keys(c.scores).map((d) => dim(d, c.scores[d], false, {}))
    );
    check(`alpine/${c.name}: R`, r.R, c.wantR);
    check(`alpine/${c.name}: dominant`, r.dominant, c.wantDom);
  }
  // applicability sanity: alpine never computes cyclone/heat/drought/surge
  check("alpine applicability set", JSON.stringify(APPLICABILITY.alpine), JSON.stringify(["FLOOD", "WILDFIRE", "SNOW_LOAD", "LANDSLIDE"]));
}

// -- demo area run ------------------------------------------------------------
async function demo(): Promise<void> {
  console.log("demo: staging layers…");
  cacheSrtmTile(25.7743, -80.1937, "/tmp/layers/N25W081.hgt.gz");
  const tracks = ensureIbtracsTracks();
  console.log(`demo: IBTrACS tracks ingested: ${tracks.count} (ok=${tracks.ok}${tracks.note ? " note=" + tracks.note : ""})`);
  const area = db.query<AnalysisRow, [number, number]>(
    "SELECT * FROM areas WHERE id = ? AND is_demo = 1"
  ).get(1) as unknown as import("~/lib/db").AreaRow;
  if (!area) throw new Error("demo area missing");
  console.log(`demo: scoring area #${area.id} "${area.name}" (${area.climate_type}, ${(db.query<{n:number},[number]>("SELECT COUNT(*) n FROM structures WHERE area_id=?").get(1)!).n} structures)`);
  const { analysisId, summary, errors } = await runAnalysisForArea(area, null);
  console.log(`demo: analysis #${analysisId}`);
  console.log(`demo: ERRORS: ${errors.length ? JSON.stringify(errors) : "none"}`);
  console.log(`demo: area_average=${summary.area_average} pct_high_vhigh=${summary.pct_high_vhigh} dominant=${summary.dominant_hazard_area}`);
  console.log(`demo: distribution=${JSON.stringify(summary.distribution)}`);
  console.log(`demo: blend ${summary.blend.min}…${summary.blend.max} (mean ${summary.blend.mean})`);
  console.log(`demo: statuses=${JSON.stringify(summary.statuses)}`);
  const rows = db
    .query<{ n: number; overall_score: number }, [number]>(
      "SELECT COUNT(*) n, overall_score FROM structure_scores WHERE analysis_id = ? GROUP BY overall_score ORDER BY overall_score"
    )
    .all(analysisId);
  console.log(`demo: score rows → ${rows.map((r) => `${r.overall_score}×${r.n}`).join(", ")}`);
  if (summary.area_average < 3.5 || summary.area_average > 4.5) {
    failures++;
    console.error("  FAIL demo area_average outside 3.5–4.5 band");
  } else {
    console.log("  ok   demo area_average within 3.5–4.5 band");
  }
}

const runDemo = process.argv.includes("--demo");
if (runDemo) {
  await demo();
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log("\nAll scoring tests passed.");