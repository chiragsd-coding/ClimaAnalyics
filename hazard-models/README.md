# ClimaScope Hazard-Model Specification — Implementation Guide (v1.0)

*Status: implementation-ready for Slice 3. Every dataset named in the per-hazard files was verified to exist (HTTP/DOI check, 2026-10-05); where something could not be verified it is explicitly marked. This README is the engineer's entry point — it says what to build and where the normative details live. The files in this directory are the single engineering input for the scoring engine.*

## 1. What the engine does

For each structure in an area with climate type `C`, compute an integer **1–5 climate risk** `R_i` from a weighted blend of per-hazard exposure scores `s_d ∈ {1..5}`, persist every per-structure score together with source attribution, and aggregate area-level KPIs. All outputs are **model estimates derived from real public datasets, clearly labeled** — not engineering surveys (exact UI/PDF wording in `CREDIBILITY_RISKS.md` §6).

## 2. Inputs available per structure

- `lat`, `lng` centroid + OSM footprint polygon (already ingested in Slice 2 via `src/lib/overpass.ts`).
- Area climate type (from `src/lib/climates.ts`; the climate-type → hazard-dimension mapping lives in `HAZARDS.md`, canonical IDs in `OVERVIEW.md` §3).
- Hazard layer value sampled **at the structure centroid** (nearest-neighbour sampling of the raster is the default; distance measures use haversine, Earth radius ≈ 6,371 km). See `OVERVIEW.md` §6 for the reference architecture (SQLite layer cache keyed by cell id, so scoring is O(structures) not O(layers)).

## 3. Scoring pipeline (step by step)

1. `A_C` = set of applicable hazard dimensions for climate type `C` (`HAZARDS.md`). Only these are computed.
2. For each `d ∈ A_C`, compute the integer score `s_d` exactly as defined in that hazard's file: `flood.md`, `cyclone-wind.md`, `extreme-heat.md`, `wildfire.md`, `snow-load.md`, `storm-surge.md`, `drought.md`, `landslide.md`. Each file gives: the dataset (name, publisher, version, URL, resolution, coverage, cadence, licence), the value read at the structure's coordinates, the **1–5 thresholds (concrete numbers)**, and the fallback chain for missing/coarse data. The fallback chain always terminates in a defined state: score 1 + `low_confidence = true` + `status = "not_assessed"` (a `missing` dimension — see §5).
3. `missing` dimensions are dropped and the remaining weights re-normalised (`COMBINATION_RULE.md` §5).
4. Combine into the final risk with the **normative formula** (§5 below).
5. Record `dominant_hazard` (tie-break rule in `COMBINATION_RULE.md` §4) and the per-dimension `sources` JSON (`dataset`, `resolution_km`, `coverage_ok`, `attribution`) per `OVERVIEW.md` §5 — licence compliance for the UI and PDF.
6. Persist the analysis with area aggregates: `area_average`, `pct_high_vhigh`, `dominant_hazard_area`, `distribution` (`COMBINATION_RULE.md` §4).

Determinism: identical inputs must yield identical outputs byte-for-byte. Store the `blend` float and formula version `"maxmean-v1"` in the score row.

## 4. The 1–5 scale

1 Very Low · 2 Low · 3 Moderate · 4 High · 5 Very High. Every hazard dimension and the final risk are **integers** — no decimals in stored results. The numeric thresholds per hazard are in each hazard file and are **fixed constants; do not re-derive them**. Example (flood): 1-in-100-year event, depth bands 0.05 / 0.3 / 0.5 / 1.0 m → scores 2 / 3 / 4 / 5 for the structure's location (`flood.md`).

## 5. Combination rule (normative — implement verbatim)

```
s_max   = max({ s_d : d ∈ A_C, not missing })
s_wmean = Σ w_C(d)·s_d / Σ w_C(d)   (over non-missing dimensions; weights re-normalised)

blend   = 0.65 · s_max + 0.35 · s_wmean
R_i     = clamp( round(blend), 1, 5 )   // round half up; clamp to [1,5]
```

Weights per climate type (each row sums to exactly 1.00; bold = thematic core). Fixed constants:

| Climate type | FLOOD | CYCLONE_WIND | EXTREME_HEAT | WILDFIRE | SNOW_LOAD | STORM_SURGE | DROUGHT | LANDSLIDE |
|---|---|---|---|---|---|---|---|---|
| tropical | 0.25 | **0.30** | 0.15 | 0.05 | — | 0.25 | — | — |
| arid | 0.20 | — | **0.30** | 0.20 | — | — | 0.30 | — |
| temperate | **0.30** | — | 0.20 | 0.20 | 0.15 | — | — | 0.15 |
| continental | 0.15 | — | 0.25 | 0.25 | **0.35** | — | — | — |
| mediterranean | 0.20 | — | 0.25 | **0.35** | — | — | 0.20 | — |
| coastal-humid | 0.25 | 0.30 | 0.15 | — | — | **0.30** | — | — |
| alpine | 0.15 | — | — | 0.20 | **0.40** | — | — | 0.25 |
| monsoon | **0.35** | 0.25 | 0.20 | — | — | — | 0.10 | 0.10 |

**Safety guard (applied after rounding):** if any applicable `s_d = 5` then `R_i = max(R_i, 4)` — a single Very High hazard must never be averaged down to "moderate". No other adjustments.

Worked unit-test examples: `COMBINATION_RULE.md` §6 (Examples A–E, exact inputs and expected outputs — use as your test fixtures).

## 6. Validation (what "good" looks like)

`VALIDATION.md` defines: ingest gates, 8 named historical-event checks (e.g. Andrew/Irma → Miami, Harvey → Houston, 2021 Ahr flood, Camp Fire), a FEMA NFHL ±1 agreement test for two US cities, and the release criterion. **Smoke test:** the seeded demo area (Miami, tropical: center 25.7743, −80.1937, r=3 km) must produce an area average ≈ 3.5–4.5 with a visible waterfront-vs-inland gradient (4/5 waterfront, 2/3 inland). All-1s or all-5s means ingestion/scoring is broken.

## 7. File map

| File | Contents |
|---|---|
| `README.md` | this guide |
| `OVERVIEW.md` | purpose, scoring philosophy, canonical hazard IDs, persistence schema, reference architecture, verified-vs-assumed summary |
| `HAZARDS.md` | 8 climate types × 8 hazard dimensions matrix with rationales |
| `flood.md` … `landslide.md` | per-hazard: dataset, thresholds, fallbacks, implementation notes, upgrade paths |
| `COMBINATION_RULE.md` | normative weights, formula, missing handling, unit-test examples |
| `VALIDATION.md` | ingest gates, historical checks, release criteria |
| `CREDIBILITY_RISKS.md` | where scores can mislead + required UI/PDF disclaimer wording |
| `OPEN_QUESTIONS.md` | items that could not be verified + owner/engineer decisions pending |

## 8. Honesty constraints

- Exposure, not vulnerability: scores say "structure sits where hazard X is estimated at level N" — building attributes are out of scope for v1.
- Heuristics are labeled as such in the UI, never presented as measurements (`CREDIBILITY_RISKS.md`).
- Free/public layers only for v1; clearly-better paid alternatives are named per hazard as upgrade paths (e.g. Fathom, FEMA NFHL, ASCE 7) but are not required.
- Anything not verified is in `OPEN_QUESTIONS.md` — never invent a dataset, number, or licence to fill a gap.