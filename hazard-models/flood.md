# FLOOD — fluvial & surface-water (pluvial) flooding

**Canonical ID:** `FLOOD`. Applies to all eight climate types (weight varies — see `COMBINATION_RULE.md`).

**What it measures:** the estimated inundation depth (m) — and where depth is unavailable, the extent — of the **1-in-100-year** flood event at the structure location. MVP default return period is 100 years (industry norm); where a layer ships multiple return periods, store the 100-yr value.

**Honesty note:** global flood layers are model outputs at ~1 km or coarser; they systematically miss small-stream and urban pluvial flooding and are not regulatory. The score is *exposure to modelled 100-yr flood*, and the UI says so.

---

## Candidate public datasets

| Dataset | Provider | URL (verified) | Measures | Resolution / coverage | Licence | Cadence | Notes |
|---|---|---|---|---|---|---|---|
| River flood hazard maps for Europe & Mediterranean | EC JRC (Dottori et al. 2022, ESSD 14:1549) | Paper: https://doi.org/10.5194/essd-14-1549-2022 · Data: https://doi.org/10.2905/1D128B6C-A4EE-4858-9E34-6210707F3C81 (→ https://data.jrc.ec.europa.eu/dataset/1d128b6c-a4ee-4858-9e34-6210707f3c81) | Fluvial flood **depth** (m) & extent for 10 return periods (2–500 yr), LISFLOOD-FP model | **100 m**, Europe + Mediterranean Basin (UK, Norway to Levant; most EU28+Med) | JRC catalogue terms; open data for research/commercial with attribution (EU open data policy); confirm per-dataset licence statement on the catalogue page | Static (v1 2022; no fixed cadence) | The best public **depth** layer in its footprint. |
| Aqueduct Floods (Global Flood Hazard Maps) | World Resources Institute | https://www.wri.org/data/aqueduct-floods-hazard-maps | Riverine flood depth (m) and extent per return period (2/5/10/25/50/100/250/500 yr); global | ~1 km (30 arcsec); global coverage, excludes some small catchments | CC BY 4.0 (WRI standard data licence; confirm on the download page) | Static v2 (2020); occasional | Download gated by free registration. **Recommended global MVP primary.** |
| GloFAS (forecasts, not hazard maps) | ECMWF / Copernicus EMS | Portal https://global-flood.ecmwf.int (DNS failed from the dev box — verify in prod); parent: https://www.ecmwf.int/ · https://emergency.copernicus.eu/ | Real-time streamflow/flood **forecasts**; also a reanalysis-derived river discharge climatology | River network (~10 km effective) | Copernicus licence (free, attribution) | Daily | Not a static hazard map — cite in UI as why flood "awareness" ≠ our static score. |
| EFAS (European Flood Awareness System) | JRC / ECMWF | https://www.efas.eu/ | European flood forecasts + EFAS-Historical reanalysis (used to drive the JRC hazard maps) | Europe, river network | Copernicus licence | Daily | Context/validation. |
| FEMA National Flood Hazard Layer (US) | FEMA | https://www.fema.gov/flood-maps/national-flood-hazard-layer (bot-blocked from dev box; verify in prod) | Regulatory flood zones (AE/VE/X…) + BFE depths | Parcel/stream-scale, US | Public domain (US Gov) + attribution to FEMA | Continuous | **Upgrade path & validation target** for US areas, not an MVP primary (access via FEMA ArcGIS services). |

*Not used but real & relevant:* Dartmouth Flood Observatory (https://floodobservatory.colorado.edu/ — unreachable from dev network; flood-event mapping), EM-DAT (https://www.emdat.be/ — event records; validation only).

---

## Recommended primary for MVP

1. **Global:** *Aqueduct Floods* 1-in-100-year riverine flood depth, ~1 km. Rationale: only global public flood *depth* layer with a clear licence (CC BY 4.0), free with registration, industry-recognised (used by World Bank/ADB risk studies).
2. **Europe + Mediterranean footprint (better detail):** *JRC river flood hazard maps (Dottori et al. 2022)*, 100 m depth for the 100-yr return period. Use wherever the area falls inside the dataset footprint (preference over Aqueduct: 100 m ≫ 1 km).
3. Coverage note: both datasets model *fluvial/extent-driven* flooding on mapped channels; **small-stream, urban pluvial and coastal backwater floods are underrepresented** — the credibility caveats (§ in `CREDIBILITY_RISKS.md`) and the fallbacks below exist because of this.

Engine rule: **if area center falls within the JRC-Europe footprint → use JRC depth; else use Aqueduct depth.** (Footprint = JRC dataset's bounding extent for Europe+Med; both layers are global rasters otherwise.)

---

## Primary scoring rule (depth available)

Let `d` = 100-yr flood depth (m) sampled at the building centroid (nearest neighbour; `d = 0` when the cell is outside the inundation extent).

| Depth d (m) | Score |
|---|---|
| `d < 0.05` (dry / outside extent) | 1 |
| `0.05 ≤ d < 0.30` | 2 |
| `0.30 ≤ d < 0.50` | 3 |
| `0.50 ≤ d < 1.00` | 4 |
| `d ≥ 1.00` | 5 |

Threshold rationale: 0.3 m ≈ water over roads/wading depth (property entry risk); 0.5 m = standard "significant structural entry" marker (the lead's example: ≥0.5 m → 4); 1.0 m ≈ first-floor interior flooding for typical raised structures — above this, internal damage is near-certain.

## Fallback 1 — extent only (no depth raster for region)

| Location vs 100-yr extent polygon | Score |
|---|---|
| Inside extent | 3 |
| Within 250 m outside the extent edge | 2 |
| Else | 1 |

## Fallback 2 — no flood layer at all for the region (should be rare; Aqueduct is global)

Elevation & distance proxy using SRTM DEM (USGS EarthExplorer https://earthexplorer.usgs.gov/; public domain) + OSM waterways:

1. Find the nearest OSM `waterway` polyline within 2 km (tag filters: `waterway=river|stream|canal|drain`).
2. `h` = building terrain elevation − elevation of the nearest river point (both from DEM).
3. `dist` = haversine distance to that river point.

```
d_band:  dist < 100 m → 3 ; 100–500 m → 2 ; > 500 m → 1
h_band:  h < 1 m → 3 ; 1–3 m → 2 ; > 3 m → 1
score = max(d_band, h_band)        // capped at 3 by construction
if no waterway within 2 km → score = 1
```

The proxy can never yield 4 or 5 — those require a modelled extent/depth (keeps the heuristic honest). Flag `low_confidence: true` for every structure scored via fallback 2 (and via fallback 1 when the dataset is flagged coarse).

## Missing-data handle

If the sampling returns no value at all (rare, e.g., polar void in DEM-only path): `score = 1`, `low_confidence = true`, and surface "not assessed" in the UI rather than hiding the structure.

## Implementation notes (engineer)

- Rasters → pre-sampled per-area tiles or a cached cell table; per-structure lookup is a point sample.
- JRC tiles: GeoTIFF per return period, WGS84, water depth in m (verify unit on ingest — the catalogue states m); Aqueduct: GeoTIFF, WGS84, depth in m (also states unit; confirm at ingest).
- Store `d` itself with the score for future re-thresholding without re-scoring.
- Attribution strings: "JRC flood hazard maps © European Commission — Dottori et al. (2022), ESSD" and "WRI Aqueduct Floods, CC BY 4.0" must appear in `sources` and the PDF.

## Upgrade path (post-MVP, licensed)

Fathom/SSBN global flood model (30 m) or FEMA NFHL/DFIRM in the US — both are what insurers actually buy; the MVP's job is to prove the UX and the combination logic, not to compete on flood accuracy yet.