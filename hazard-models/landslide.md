# LANDSLIDE — landslide susceptibility

**Canonical ID:** `LANDSLIDE`. Applies to `temperate`, `alpine`, `monsoon` (see HAZARDS.md). Explicitly **not** applied to `mediterranean` in the MVP (hillside risk is real there — flagged in OPEN_QUESTIONS §9) nor to arid/coastal types.

**What it measures:** modelled *susceptibility* (slope, soil, moisture, seismicity-driven likelihood of a landslide occurring) at ~5 km cell scale. Susceptibility ≠ hazard at the parcel: a 5 km cell containing one steep ravine and a flat town scores the same. The MVP accepts that.

---

## Candidate public datasets

| Dataset | Provider | URL (verified) | Measures | Resolution / coverage | Licence | Cadence | Notes |
|---|---|---|---|---|---|---|---|
| **Global Landslide Hazard Distribution** | CIESIN/CHRR (Columbia) + Norwegian Geotechnical Institute (NGI) | https://sedac.ciesin.columbia.edu/data/set/ndh-landslide-hazard-distribution (page bot-blocked from dev box; metadata verified via NASA data portal) · DOI: **10.7927/H4P848VZ** · WMS services on the SEDAC page | Global landslide hazard ranking (grid 1–10; values ≥6 used as significant after the dataset's own +1 shift), based on slope, soil, moisture, precipitation, seismicity, temperature; SRTM-derived | **2.5 arcmin ≈ 5 km**, global land 58°S–85°N | **US Government work — public domain** (per NASA catalog record, https://www.usa.gov/government-works) | Static (v1, 2005) | **MVP primary** — old but the only global public susceptibility raster with a clean license we could verify. |
| **NASA Global Landslide Catalog (GLC) Export** | NASA GSFC (Kirschbaum) | CSV: https://data.nasa.gov/docs/legacy/Global_Landslide_Catalog_Export/Global_Landslide_Catalog_Export_rows.csv · portal: https://landslides.nasa.gov/ | ~11k+ rainfall-triggered landslide **events** (lat/lon/date/trigger), compiled since 2007 from media/reports; export current to 2016-03-07 | Point events, global | Free with **required citation** (terms on the page): Kirschbaum et al. 2010, Nat. Hazards 52:561–575 https://doi.org/10.1007/s11069-009-9401-4 ; Kirschbaum, Stanley, Zhou 2015, Geomorphology https://doi.org/10.1016/j.geomorph.2015.03.016 | Irregular | **Validation & calibration set**, not a hazard layer. |
| ThinkHazard "Landslide" | GFDRR | https://thinkhazard.org/ | Per-location landslide class | Location-level | Site terms | Static | Optional cross-check (not needed for MVP). |

*Not used:* Global Fatal Landslide Database (Durham) — post-MVP; NASA's updated susceptibility models may be published under new DOIs — engineers should re-check the SEDAC/NASA catalog when wiring ingest (`OPEN_QUESTIONS.md` §7).

---

## Recommended primary (MVP)

**Global Landslide Hazard Distribution (DOI 10.7927/H4P848VZ).** Rationale: verified existence, globally complete, public-domain US-government licence, one raster. Coarseness (5 km) is the price.

### Scoring rule

Let `L` = the dataset's raw hazard value sampled at the structure (grid 1–10; the dataset's own documentation treats values ≤4 as negligible and uses 5–9 +1 → 6–10 for analysis).

| Raw value L | Score |
|---|---|
| `1 ≤ L ≤ 4` | 1 |
| `5 ≤ L ≤ 6` | 2 |
| `L = 7` | 3 |
| `L = 8–9` | 4 |
| `L = 10` | 5 |

Rationale: the bands follow the dataset's own stated interpretation (≤4 negligible; the meaningful range is 5–10), split into 2s. `alpine` valleys and `monsoon` hill towns in high-L cells correctly return 3–5; plains return 1.

### Calibration/validation step (engineer, once, during ingest)

Using the **GLC export**, compute for a sample of 5,000 catalog events (2007–2016, avoid the export's own late-2015 reporting cliff): the share of events whose cell scores ≥ 3. Target: **≥ 70%** (events should mostly sit in at least "moderate" cells). If the share is < 60%, shift the table down by one band (L=7→2, 8–9→3, 10→4) and re-check; record the chosen mapping in the score provenance. This is the only data-driven calibration in the MVP and it uses the required citations for the GLC.

## Fallback — layer missing for the cell (no SEDAC access in prod)

1. If the *GLC event catalog* imports successfully, use **event-density proxy**: `score = 3` if ≥ 1 catalog event within 10 km, else `score = 1` (both flagged `low_confidence`).
2. If neither layer is available for the area → `score = 1`, `low_confidence = true`, UI shows "landslide not assessed" (do **not** silently drop the dimension — the combination rule re-normalises weights only when the flagged dimension is missing *and* recorded as such; see COMBINATION_RULE.md §5).

## Missing-data handle

Polar/ice cells: dataset covers 58°S–85°N; outside → score 1 (correct — no settlements).

## Implementation notes (engineer)

- The SEDAC dataset is distributed as raster + WMS; ingest via the WMS services link or the DOI/NASA catalog while the sedac download page is blocked from the dev box (see OPEN_QUESTIONS §7).
- Store raw `L` with the score (allows the calibration mapping to be tuned without re-scoring).
- Attribution: "Global Landslide Hazard Distribution, CIESIN/Columbia – NGI (2005), DOI 10.7927/H4P848VZ, public domain" and, if GLC is used: "NASA Global Landslide Catalog (Kirschbaum et al. 2010, 2015) — citation required".

## Upgrade path

NASA's newer global susceptibility models (GSLM/GLC-updated), or regional products (USGS A3D3 for the US) — post-MVP.