# STORM_SURGE — coastal surge / extreme sea-level exposure

**Canonical ID:** `STORM_SURGE`. Applies to `tropical`, `coastal-humid` (and arguably monsoon coasts — see OPEN_QUESTIONS §8; not in MVP set).

**What it measures:** whether the structure sits in the modelled **1-in-100-year coastal flood extent** (and at what depth). Storm surge in the MVP is represented through coastal flood maps built on global tide-and-surge reanalyses; the tide, wave setup and inland attenuation terms are embedded in the model, not resolved by us.

---

## Candidate public datasets

| Dataset | Provider | URL (verified) | Measures | Resolution / coverage | Licence | Cadence | Notes |
|---|---|---|---|---|---|---|---|
| **Aqueduct Floods — coastal flood hazard maps (+ return-period depths)** | World Resources Institute | https://www.wri.org/data/aqueduct-floods-hazard-maps | Coastal flood extent & depth for return periods (2–500 yr), global coast | ~1 km (30 arcsec) coastal | CC BY 4.0 (confirm on download page) | Static v2 (2020) | **MVP primary** — same distribution channel as the flood layer (one download covers `FLOOD` and `STORM_SURGE`). |
| **GTSR** (Global Tide and Surge Reanalysis) | Deltares (Muis et al. 2016) | Paper: https://doi.org/10.1038/ncomms11969 · Data: https://doi.org/10.4121/uuid:aa4a6ad5-e92c-468e-841b-de07f7133786 (4TU.ResearchData) | 35-year hourly tide+surge water levels; **extreme sea level return values** (e.g., 1-in-100-yr total water level, m relative to MSL) at ~36 km coastal cells | ~36 km along-coast cells, global coastal (excludes some icy/lagoon coasts) | CC BY 4.0 (4TU terms; attribute Muis et al. 2016) | Static (2016; GTSR v2 exists → confirm) | The **scientific basis** layer; usable via the DEM-difference rule (fallback 2). |
| ThinkHazard "Coastal flood" class | GFDRR | https://thinkhazard.org/ | Coastal-flood hazard class per location | Location-level | Site terms | Static | Cross-check only. |
| NOAA SLOSH (US) | NOAA NWS | US coastal basins | Basin surge hydrographs | US | Public domain | Per-storm | Validation for US events (e.g., Katrina/Irma runs), not an MVP layer. |

---

## Recommended primary (MVP)

**Aqueduct coastal 1-in-100-year flood extent + depth**, applied only where the structure is within coastal cells (layer itself is coastal-masked). Rationale: same licence/channel as `FLOOD` — one ingest; global; industry standard in public risk practice.

### Scoring rule (depth version)

Let `d_c` = 100-yr coastal flood depth (m) at the centroid (0 outside extent).

| Condition | Score |
|---|---|
| `d_c ≥ 1.0 m` | 5 |
| `0.5 ≤ d_c < 1.0 m` | 4 |
| inside extent, `d_c < 0.5 m` | 3 |
| outside extent | → **secondary check** below |

## Secondary check (outside extent but near the coast)

Surge maps stop at their modelled extent; a structure 400 m from the beach can still be in the wave-impact zone. For structures outside the extent **and within 1 km of the coastline**:

1. Take terrain elevation `h` from SRTM (https://earthexplorer.usgs.gov/, public domain).
2. If `h < 3 m` → **score 3** with `low_confidence = true` (exposed low-lying coastal fringe);
3. If `3 m ≤ h < 5 m` and the area climate type is `tropical` or `coastal-humid` → **score 3** (`low_confidence`);
4. else → score 1.

## Fallback — no Aqueduct coastal layer for the region (rare)

**GTSR return-level rule:** for the nearest GTSR coastal cell, let `RL100` = 1-in-100-yr total water level (m vs MSL). Sample structure terrain elevation `h` (SRTM).

| Condition | Score |
|---|---|
| `h < RL100 – 1.0 m` (well below extreme water level) | 4 |
| `RL100 – 1.0 m ≤ h < RL100` | 3 |
| `h ≥ RL100` but within 500 m of coastline | 2 |
| else (far inland / high) | 1 |

Do not use GTSR for cells flagged by the dataset as data-poor (some polar/lagoon coasts) — those fall through to score 1 + flag.

## Missing-data handle

No surge layer cell anywhere near the structure (landlocked) → score 1 (surge is correctly irrelevant — do not flag as an error, but mark `coverage_ok: true` with a note "non-coastal"). Coastal area with both layers missing → `score = 1`, `low_confidence = true`, UI "not assessed".

## Intentional limitations

- **Storm tide = surge + astronomical tide + wave setup** — embedded in the models but not separable; we do not try.
- 1 km coastal cells → depth at the parcel is approximate; structures 100 m inland vs beachfront share a cell.
- Sea-level-rise scenario layers (e.g., +1 m) exist in Aqueduct — **out of MVP scope** (flags in CREDIBILITY_RISKS).

## Implementation notes (engineer)

- Same GeoTIFF family as the `FLOOD` layer (Aqueduct zip contains riverine and coastal sets) — one ingest pipeline.
- Store `d_c` and the rule branch used (extent / secondary / GTSR) in score provenance.
- Attribution: "WRI Aqueduct Floods (coastal), CC BY 4.0" and/or "Deltares GTSR (Muis et al. 2016), CC BY 4.0".

## Upgrade path

Deltares/other 500 m coastal flood rasters, or GTSR v2 (which resolved many coastal cells) — plus NOAA SLOSH composites for US basins.