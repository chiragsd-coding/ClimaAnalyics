# VALIDATION.md — how to sanity-check scores, and what "good enough for MVP" means

Goal: prove the engine is **not broken and not embarrassing**, not that it is actuarially correct. The MVP sells defensibility, so every check below is cheap to run against public evidence.

## 1. Dataset-integrity checks (run once at ingest time — gate the release)

| Check | Pass criterion |
|---|---|
| Rasters load and span the expected domain | JRC Europe+Med footprint present; Aqueduct global; WorldClim global land; GFWED/ERA5-FWI global land; SPEI global land; landslide 58°S–85°N |
| Units sane | flood depth rasters within 0–20 m; BIO5 within −40…50 °C; S within 0–10 kPa; FWI p90 within 0–120 |
| No all-zero / all-one rasters after processing | every hazard raster has ≥ 3 distinct scores across a global sample of 10,000 random points |
| IBTrACS import | ≥ 1,000,000 track records since 1980; each basin non-empty |
| Landslide calibration (§ in `landslide.md`) | ≥ 70% of GLC events in cells scoring ≥ 3 (else apply the specified shift) |

## 2. Historical-event checks (each ~1 h of an engineer's time; run for release)

For each case, compute the area scores, then compare against documented impact. **Pass = the stated fraction of impacted structures scores at or above the stated level.** "Officially delineated impact area" = published inundation/extent map or FEMA/SITREP footprint, not our own layer.

| Event (year, location) | Climate type to select | Expected result |
|---|---|---|
| Hurricane Andrew (1992) / Irma (2017) — Miami-Dade | tropical | ≥ 70% of structures inside the published hurricane-impact zone score **≥ 4**; coastal strip (within 2 km) predominantly 4–5 |
| Harvey (2017) — Houston fluvial flood | coastal-humid (or tropical) | ≥ 70% of structures in the USGS-delineated flooded area score **≥ 3**; ≥ 50% in the deepest zones score ≥ 4 |
| 2021 Ahr valley floods (Germany) | temperate | Structures in the mapped inundation (a >100-yr event) score ≥ 3 on the 100-yr JRC layer for the valley floor; note that the event exceeded the 100-yr extent in places (documented overrun, not a bug) |
| Camp Fire (2018) — Paradise, CA | mediterranean (or temperate) | ≥ 60% of structures inside the CAL FIRE damage perimeter sit in cells with wildfire score **≥ 3** (FWI-p90 ≥ 11.2) |
| 2003/2019 European heat | temperate / mediterranean | Cities with documented deadly heat (Paris, Lyon, Madrid) score heat **≥ 3**; northern Scotland/Norway score 1–2 |
| 2022 Pakistan monsoon floods | monsoon | Sindh/Punjab floodplain structures score **≥ 3** on flood |
| Ground-snow benchmark — global: | — | ERA5-derived S: Denver ≈ 1.5–2.5 kPa (score 3–4), Miami ≈ 0 (1), Zermatt ≈ 2.5+ (5), London ≈ 0.3–0.5 (1) — spot-check a few known cities against published design snow maps (ASCE 7 / national annexes) |

## 3. Published-risk-map comparisons (the strongest check)

Pick two US test cities (e.g., **Miami, FL** and **Houston, TX**):

1. Fetch FEMA NFHL flood zones for the city (public).
2. Map our flood score: structures inside FEMA AE/AH zones should have flood score **≥ 4**; inside VE (wave) zones additionally surge ≥ 4; outside 500-yr zone → ≤ 2.
3. Criterion: **≥ 70% agreement within ±1** on the flood dimension; report the confusion matrix in the release evidence (the lead's slice-report style).

Optional second comparator for wildfire (US): USFS Wildfire Hazard Potential (public) — rank-correlation ≥ 0.6 between our wildfire score and WHP class across 5,000 random US structures.

## 4. Distribution sanity (always-on assertions)

- No area where **all** structures share the same score unless truly homogeneous (e.g., an empty plains area at 1–2); all-1s or all-5s → raise an ingest/weight bug.
- Area average for the demo Miami radius of 3 km should land in **3.5–4.5**; if it drifts outside the release evidence, re-check layers before demoing to prospects.
- Per-hazard coverage log: every scored structure has `coverage_ok`/`low_confidence` flags; the UI reports how many structures were scored with each flag (transparency metric, printed in the PDF too).

## 5. "Good enough for MVP" (definition of done for validation)

1. All §1 gates pass and the §2 event checks hit their targets (allow ±5 pts).
2. The §3 FEMA comparison is produced (≥70% ±1 for the two test cities) and shared in the slice evidence — it is our public credibility proof that "heuristic public layers" map onto the regulatory picture the buyers trust.
3. Determinism test: scoring the same area twice yields byte-identical JSON.
4. Demo Miami renders a plausible gradient (waterfront 4–5 → inland 2–3), area average 3.5–4.5.
5. All license attribution strings are rendered in the PDF report and on the map legend for the layers actually used.

**Not required for MVP:** actuarial loss ratios, hazard-specific ROC curves against claims data, regional re-calibration, temporal validation of heat/fire beyond the spot checks. These are post-MVP (and would move us toward licensed models anyway).

## 6. Where to record results

Engineer: a `VALIDATION.md` _run report_ (per release) either in the repo under `docs/` or in `/home/team/shared/sliceX-evidence/` following the existing slice-evidence convention — with the event-check tables above filled in, the two FEMA confusion matrices, and the demo screenshots. This is the artifact the lead reviews before merging Slice 3.