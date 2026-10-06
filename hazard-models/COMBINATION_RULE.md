# COMBINATION_RULE.md — merging hazard scores into final structure risk

*This file is normative. The engineer implements exactly this; there must be no open questions left.*

## 1. Inputs

For a structure `i` in an area with climate type `C`:

- `A_C` = set of applicable hazard dimension IDs (from `HAZARDS.md` — final table).
- `w_C(d)` = weight of dimension `d` under climate type `C` (tables below). **Sum over `A_C` = 1 exactly** for every climate type (checked by construction).
- `s_d` = integer 1–5 score computed by the hazard file for dimension `d`. **Every `d ∈ A_C` that is not flagged `missing` must be scored.** A dimension is `missing` only when its hazard file's final fallback says "not assessed" (score 1 + `low_confidence = true` + `status = "not_assessed"`).

## 2. Weights (normative)

| Climate type `C` | FLOOD | CYCLONE_WIND | EXTREME_HEAT | WILDFIRE | SNOW_LOAD | STORM_SURGE | DROUGHT | LANDSLIDE |
|---|---|---|---|---|---|---|---|---|
| tropical | 0.25 | **0.30** | 0.15 | 0.05 | — | 0.25 | — | — |
| arid | 0.20 | — | **0.30** | 0.20 | — | — | 0.30 | — |
| temperate | **0.30** | — | 0.20 | 0.20 | 0.15 | — | — | 0.15 |
| continental | 0.15 | — | 0.25 | 0.25 | **0.35** | — | — | — |
| mediterranean | 0.20 | — | 0.25 | **0.35** | — | — | 0.20 | — |
| coastal-humid | 0.25 | 0.30 | 0.15 | — | — | **0.30** | — | — |
| alpine | 0.15 | — | — | 0.20 | **0.40** | — | — | 0.25 |
| monsoon | **0.35** | 0.25 | 0.20 | — | — | — | 0.10 | 0.10 |

Bold = the highest weight of that row (the "thematic core" of the climate type). Every row sums to 1.00. Weights are **fixed constants** in the code — do not re-derive them.

## 3. Combination formula (exact)

```
s_max   = max({ s_d : d ∈ A_C, not missing })
s_wmean = Σ_{d ∈ A_C, not missing} w_C(d) · s_d
          ─────────────────────────────────────
          Σ_{d ∈ A_C, not missing} w_C(d)

blend   = 0.65 · s_max + 0.35 · s_wmean
R_i     = clamp( round(blend), 1, 5 )
```

where:

- `round(x)` = round half up (Math.round semantics for positive x: 3.5 → 4);
- `clamp(x, 1, 5)` bounds the result;
- **Weights are re-normalised** by the denominator when a dimension is `missing` (so the remaining hazards still sum to 1 — this is the only case where weights differ from §2). If **all** dimensions are missing (no data at all — should not happen), `R_i = 1`, `status = "not_assessed"`.

**Safety guard (normative, applied after rounding):** if any applicable `s_d = 5`, then `R_i = max(R_i, 4)`. If any applicable `s_d = 4` **and** `s_max ≥ 4` and `s_wmean ≥ 3.5`, then `R_i = max(R_i, 4)` (numeric identity — include for explicitness). Rationale for the guard: a single very-high hazard must never be averaged down to "moderate" by other green scores; a 5 anywhere means the structure sits in at least one Very High hazard zone.

**No other adjustments.** No interactions, no caps from building attributes (out of scope), no area-level rescaling.

## 4. Derived per-structure & area outputs (normative for the UI)

- `dominant_hazard` = `d* = argmax_{d ∈ A_C} s_d`; ties broken by (1) higher `w_C(d)`, then (2) alphabetical order of the canonical IDs in §3 of OVERVIEW.md.
- Structure risk label: 1 Very Low, 2 Low, 3 Moderate, 4 High, 5 Very High.
- **Area KPI cards** (Slice 2 UI already has slots for these):
  - `area_average` = mean of `R_i` over all scored structures, rounded to 2 decimals;
  - `pct_high_vhigh` = 100 × (count of `R_i ≥ 4`) / (count of scored structures), 1 decimal;
  - `dominant_hazard_area` = modal `dominant_hazard` over structures (ties: any — UI may show both);
  - `distribution` = counts per risk label for the bar chart.
- **Category distribution chart:** share of structures per R_i (1–5).

## 5. `missing` handling summary (normative)

| Situation | s_d recorded as | Effect on R_i |
|---|---|---|
| Score computed | integer 1–5 | normal |
| Final fallback says "not assessed" (no data for region) | `missing`, displayed as "—" | dimension dropped; weights re-normalised; UI must display "X hazard: not assessed for this area" |
| Non-applicable dimension (not in `A_C`) | never computed | none |

Determinism: same inputs → same outputs byte-for-byte. Store `blend` (float) and the formula version `"maxmean-v1"` in the score row for reproducibility.

## 6. Worked examples (engineer: use as unit tests)

**Example A — Miami waterfront, tropical:**
FLOOD 4, CYCLONE_WIND 5, EXTREME_HEAT 3, WILDFIRE 1, STORM_SURGE 5.
s_max = 5; s_wmean = (0.25·4 + 0.30·5 + 0.15·3 + 0.05·1 + 0.25·5) / 1.00 = (1.0 + 1.5 + 0.45 + 0.05 + 1.25) = 4.25.
blend = 0.65·5 + 0.35·4.25 = 3.25 + 1.4875 = 4.7375 → round → **5**. Guard (s=5 → ≥4) satisfied. dominant: CYCLONE_WIND (5, weight 0.30 highest among 5s). R = 5.

**Example B — inland tropical structure, same climate:**
FLOOD 2, WIND 2, HEAT 3, FIRE 1, SURGE 1. s_max=3, s_wmean = 0.25·2+0.30·2+0.15·3+0.05·1+0.25·1 = 0.5+0.6+0.45+0.05+0.25=1.85. blend=0.65·3+0.35·1.85=1.95+0.6475=2.5975 → **3**. dominant: EXTREME_HEAT (3 vs 2s). R=3.

**Example C — alpine valley:**
SNOW 5, LANDSLIDE 3, WILDFIRE 2, FLOOD 2. s_max=5, wmean = (0.40·5+0.25·3+0.20·2+0.15·2)=2.0+0.75+0.4+0.3=3.45. blend=0.65·5+0.35·3.45=3.25+1.2075=4.4575→**4**; guard → R=4 (max(4,4)). Dominant: SNOW_LOAD. R=4.

**Example D — monsoon city, flood+heat high:**
FLOOD 4, WIND 1, HEAT 3, DROUGHT 2, LANDSLIDE 1. s_max=4; wmean=(0.35·4+0.25·1+0.20·3+0.10·2+0.10·1)=1.4+0.25+0.6+0.2+0.1=2.55. blend=0.65·4+0.35·2.55=2.6+0.8925=3.4925→3. Guard: any s=5? no. R=3. dominant FLOOD. R=3.

**Example E — missing dimension (drought unavailable in arid):**
arid: HEAT 4, FIRE 3, FLOOD 1, DROUGHT `missing`. Renormalised weights: HEAT 0.30/0.70=0.4286, FIRE 0.20/0.70=0.2857, FLOOD 0.20/0.70=0.2857 (sum 1). s_max=4. wmean=0.4286·4+0.2857·3+0.2857·1=1.714+0.857+0.286=2.857. blend=0.65·4+0.35·2.857=2.6+1.0=3.6→ **4**. R=4. UI shows "Drought: not assessed".

*Cross-check:* the demo Miami area (seed: center 25.7743, −80.1937, r=3 km, tropical) should produce an area average ≈ 3.5–4.5 and a visible mix of 4/5 waterfront vs 2/3 inland — if the demo renders all-1s or all-5s, the ingest is broken (see VALIDATION.md).*