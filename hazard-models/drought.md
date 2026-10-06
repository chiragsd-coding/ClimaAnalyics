# DROUGHT — multi-year water deficit

**Canonical ID:** `DROUGHT`. Applies to `arid`, `mediterranean`, `monsoon` (see HAZARDS.md rationale). Not applied elsewhere in the MVP — in `temperate`/`continental` its effects are folded into the wildfire and heat scores.

**What it measures:** how often the location experiences **severe drought** (12-month Standardized Precipitation–Evapotranspiration Index below −1.5) over the last three decades. Drought is a slow-onset, area-scale stressor — for structures it matters in three ways, all indirect: (1) it pre-conditions wildfire (already scored); (2) it stresses water-dependent foundations/subsidence risk in clay soils; (3) it is the defining chronic hazard of arid/mediterranean livelihoods that municipal resilience teams buy for. Its weight in the final score is deliberately small.

---

## Candidate public datasets

| Dataset | Provider | URL (verified) | Measures | Resolution / coverage | Licence | Cadence | Notes |
|---|---|---|---|---|---|---|---|
| **SPEI Global Drought Monitor (SPEI-GDM), grid SPEI-12** | CSIC (Begueria–Vicente-Serrano group) | https://spei.csic.es/ (portal; proxy-blocked from the dev box — reachability test required in prod) · method: Vicente-Serrano et al. (2010), *J. Climate* 23:1696–1718, https://doi.org/10.1175/2009JCLI2909.1 | Gridded SPEI at 1–48 month scales, all land | **0.5° ≈ 55 km**, global land, multi-decadal (1900s–present, monthly series) | Free access for research/use with citation to the SPEI paper (site terms; redistribution terms — see OPEN_QUESTIONS §6) | Monthly | **MVP primary.** The standard global drought index. |
| U.S. Drought Monitor | Univ. of Nebraska-Lincoln / NOAA / USDA | https://droughtmonitor.unl.edu/ | Weekly drought classification (D0–D4) | US county/grid | Public (with attribution) | Weekly | US cross-check & demo validation. |
| EM-DAT drought events | CRED | https://www.emdat.be/ | Historical disaster records incl. droughts | Event-based | EM-DAT terms (free academic; commercial licence exists) | Continuous | Validation only. |

---

## Recommended primary (MVP)

**SPEI-GDM, SPEI-12 (12-month scale, smoothing intra-seasonal noise), 1991–2022.**

Per cell: `F` = fraction of months in 1991–2022 with SPEI-12 < **−1.5** (severe drought; −1.5 is the standard "severe" drought threshold used in the SPEI literature).

| F | Score |
|---|---|
| `F < 0.10` | 1 |
| `0.10 ≤ F < 0.20` | 2 |
| `0.20 ≤ F < 0.30` | 3 |
| `0.30 ≤ F < 0.40` | 4 |
| `F ≥ 0.40` | 5 |

Threshold rationale: F is the share of time in severe drought. Any arid city lives partly in drought (score 2–3 by construction); >30% of months in severe drought means a chronically water-stressed regime (Sahel, Cape Town class) — score 4–5. The bands are coarse because 0.5° cells are coarse; the point is regime classification, not precision.

## Fallbacks

1. **US areas:** U.S. Drought Monitor percent-area in D2–D4 for the county over 2000–2022, same bands on the same `F` scale (county-level weekly → monthly resample).
2. **SPEI not reachable in production** (flagged): use **CRU/GPCC precipitation anomaly** — *not verified this session — do not implement without the engineer confirming a concrete open dataset* (see OPEN_QUESTIONS §6). Simplest honest fallback: assign every non-arid/non-mediterranean/non-monsoon structure `score = 1` (drought is not applied there anyway) and for the three climate types use the nearest U.S.-DM-equivalent or **skip drought** (weight re-normalises, COMBINATION_RULE.md §3) with a visible "drought not assessed" flag.

## Missing-data handle

SPEI-GDM covers all land except small islands and ice sheets: missing cell → score 1 + `low_confidence`; for islands with no cell, nearest-cell within 2°.

## Intentional limitations

- SPEI-12 at 0.5° does not capture flash droughts or groundwater depletion — fine for a regime score.
- 1991–2022 window choice: fixed reference, noted in `sources`; do not roll the window per-run (determinism).

## Implementation notes (engineer)

- SPEI-GDM bulk files are per-scale global NetCDFs/ASCII from the CSIC site; keep only the SPEI-12 series, compute F once per cell → tile the F raster.
- Attribution: "SPEI Global Drought Monitor — Begueria & Vicente-Serrano, CSIC (cite Vicente-Serrano et al. 2010)" and/or "U.S. Drought Monitor, University of Nebraska-Lincoln".

## Upgrade path

SPI/SPEI seasonal outlook products or ISIMIP soil-moisture deficit layers (post-MVP); none affect the MVP weight structure.