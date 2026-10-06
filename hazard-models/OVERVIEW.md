# ClimaScope Hazard-Model Specification — OVERVIEW

*Status: v1.0 — implementation-ready for Slice 3. Written by the climate-risk researcher; every dataset named below was verified to exist (HTTP/DOI check) unless explicitly flagged as "to confirm".*

## 1. Purpose

This directory is the **single engineering input for the ClimaScope scoring engine (Slice 3)**. It specifies:

- which hazard dimensions apply to each of the **eight climate types** (`HAZARDS.md`);
- the exact public datasets to use for each hazard, and how to turn them into a **per-structure 1–5 exposure score** (one file per hazard: `flood.md`, `cyclone-wind.md`, `extreme-heat.md`, `wildfire.md`, `snow-load.md`, `storm-surge.md`, `drought.md`, `landslide.md`);
- the **unambiguous combination rule** that merges hazard scores into one final 1–5 structure risk (`COMBINATION_RULE.md`);
- how to sanity-check the output (`VALIDATION.md`);
- where scores can mislead and what the UI must say (`CREDIBILITY_RISKS.md`);
- the small set of decisions that are genuinely still open (`OPEN_QUESTIONS.md`).

The engineer implementing Slice 3 must be able to code the whole engine from these files **without asking the researcher anything**.

## 2. Scoring philosophy

1. **1–5 ordinal scale, nothing finer.** Every hazard dimension and the final structure risk are integers 1 (Very Low) → 5 (Very High). No decimals in stored results.
2. **Model estimates, clearly labeled.** Every MVP hazard layer is a *model estimate or heuristic derived from a real public dataset* — not an engineering survey. The product must label outputs accordingly (see `CREDIBILITY_RISKS.md` §6 for the exact UI wording).
3. **Real datasets only.** Each primary layer traces to a citable public dataset (government agency, EU/NASA/NOAA programme, peer-reviewed product) with a working URL and a marked licence. Where the gap between "free public" and "commercial licence" matters, the spec says so (`OPEN_QUESTIONS.md`).
4. **Defensible beats precise.** For the MVP, an honest ~1 km global heuristic with a published source outranks a finer unpublished one. Precision comes later (licensed layers listed as "upgrade paths").
5. **Exposure, not vulnerability.** MVP scores measure **hazard exposure at the structure location**. Building vulnerability (roof type, height, age, construction) is deliberately out of scope — OSM footprints rarely carry it, and claiming otherwise would be dishonest. The final score is therefore "structure sits where hazard X is estimated at level N", surfaced as such.
6. **Return period default.** Flood and storm surge use the **1-in-100-year** event as the default reference (industry norm). The reference return period is stored per score so the UI can print it.

## 3. Hazard dimensions (canonical IDs)

| ID | Dimension | Applies to climate types (see HAZARDS.md) |
|---|---|---|
| `FLOOD` | Fluvial / surface-water flooding | tropical, arid, temperate, continental, mediterranean, coastal-humid, alpine, monsoon |
| `CYCLONE_WIND` | Tropical-cyclone wind | tropical, coastal-humid, monsoon |
| `EXTREME_HEAT` | Heat stress | tropical, arid, temperate, continental, mediterranean, coastal-humid, monsoon |
| `WILDFIRE` | Wildfire danger | tropical, arid, temperate, continental, mediterranean, alpine, monsoon |
| `SNOW_LOAD` | Roof snow load | temperate, continental, alpine |
| `STORM_SURGE` | Coastal storm surge / extreme sea level | tropical, coastal-humid |
| `DROUGHT` | Drought (multi-year water deficit) | arid, mediterranean, monsoon |
| `LANDSLIDE` | Landslide susceptibility | temperate, alpine, monsoon |

Every climate type scores exactly the dimensions in its row above — the engine must not compute others. **What to do when a listed dimension has no data for the area** is defined per hazard file (fallback chain, always terminating in score 1 with a `low_confidence` flag).

## 4. How a final 1–5 structure risk is composed

Per structure `i` in an area with climate type `C`:

1. For each applicable dimension `d` (set `A_C` from `HAZARDS.md`), compute the integer score `s_d ∈ {1..5}` using that hazard's rule.
2. Combine with the **max-vs-weighted-mean blend** (exact formula, weights, rounding and tie-breaks in `COMBINATION_RULE.md`):

   ```
   R_i = clamp( round( 0.65·max(s_d) + 0.35·Σ w_d·s_d ), 1, 5 )
   ```

3. Record `dominant_hazard` = dimension with the largest `s_d` (tie-break: higher weight, then alphabetical ID) — this powers the area "dominant hazard" KPI.
4. Persist per-structure: `R_i`, all `s_d`, `dominant_hazard`, and per-dimension **source attribution + resolution + coverage flag** (see §5).

## 5. What the engine must persist per analysis (license compliance)

Licences require attribution; the app must be able to show it. Every stored structure score row and every area analysis must carry (JSON column `sources`):

```
{
  "climate_type": "tropical",
  "hazards": {
    "FLOOD":       {"dataset": "WRI Aqueduct Floods (riverine, 100-yr)", "resolution_km": 1, "coverage_ok": true, "attribution": "WRI Aqueduct — CC BY 4.0"},
    "CYCLONE_WIND":{"dataset": "NOAA IBTrACS v4 (track proximity heuristic)", "resolution_km": 50, "coverage_ok": true, "attribution": "NOAA/NCEI IBTrACS — public domain"},
    ...
  }
}
```

The PDF report generator must print the attribution strings. `resolution_km` values are the *layer* resolution as defined per hazard file (used by the UI caveat banner: "≤ ~1 km resolution — indicative only").

## 6. Reference architecture for the engineer

- **Footprints:** OSM building polygons already ingested (Slice 2). Engine iterates structures with `(lat, lng)` (polygon centroid + bounding-box min/max elevation if DEM sampling used).
- **Hazard layers:** served to the engine as raster tiles / GeoTIFFs / per-cell NetCDF-derived tables. Slice 3 may pre-sample layers into the app's own SQLite cache keyed by cell id to keep scoring O(structures) instead of O(layers). All layers are global so no area should fail on coverage; where a layer is genuinely missing for a region the hazard file defines the fallback.
- **Determinism:** identical inputs must yield identical scores — no randomness, no time-of-day effects. Layer versions are pinned in `sources` so a later re-run is reproducible.
- **Sampling:** nearest-neighbour sampling of the raster at the building centroid is the default; bi-linear is optional. Distance measures use haversine (≈6,371 km radius).
- **Performance:** max ~10 km radius areas, typically ≤ 5,000–50,000 OSM structures; per-structure point sampling of 1–5 layers is trivial for SQLite + JS.

## 7. Verified vs assumed (summary)

- **Verified (fetched / resolved during writing):** JRC flood-hazard maps for Europe+Mediterranean (DOI + ESSD paper), WRI Aqueduct Floods page, EFAS, Copernicus EMS, ECMWF, NOAA IBTrACS product page, ThinkHazard front page, WorldClim v2.1 + Bioclim pages, Copernicus CDS + the ERA5 monthly-single-levels dataset page, NASA GFWED, NRCan FWI danger-class page, GFED4s, GWIS, EFFIS, NASA Global Landslide Catalog Export (CKAN metadata + CSV URL) and its two required citations, the CIESIN/NGI Global Landslide Hazard Distribution (DOI 10.7927/H4P848VZ, via NASA CKAN), the SPEI methodology paper (DOI), U.S. Drought Monitor, EM-DAT, GTSR paper (DOI) and its data DOI (10.4121/uuid:aa4a6ad5-e92c-468e-841b-de07f7133786), NOAA US Climate Normals, USGS EarthExplorer.
- **Real but not reachable from the dev box (flag for prod test):** SPEI Global Drought Monitor portal (spei.csic.es — request blocked by local egress), FEMA NFHL page (fema.gov bot-blocks curl), SEDAC download pages (blocked), Dartmouth Flood Observatory (floodobservatory.colorado.edu — network timeout). These are established sources; production reachability must be tested, see `OPEN_QUESTIONS.md`.
- **Assumed (heuristics we build ourselves, always labeled):** the 1–5 thresholds per hazard (rationale given in each hazard file), IBTrACS proximity scoring, snow-load conversion from ERA5 snow water equivalent, WorldClim BIO5 heat bands, GFWED 90th-percentile FWI season metric.

Every threshold in this spec is a *decision* recorded here so the engineer does not re-derive it; the validation file explains how we check it is sane.