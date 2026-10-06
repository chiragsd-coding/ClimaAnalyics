# CREDIBILITY_RISKS.md — where scores could mislead, and what the UI must label

This file exists because we sell to insurers and municipal teams: a defenceless score is a liability. Every risk below is either mitigated by a UI label (normative) or flagged as a known limitation in the report. **The UI labels in §6 are requirements for Slice 3, not suggestions.**

## 1. Coarse resolution (the big one)

- Global layers are ~1 km to ~31 km per cell (`flood ~1 km`, `FWI ~25 km`, `snow ~31 km`, `SPEI ~55 km`, `landslide ~5 km`). A 1 km flood cell can contain dry high ground and a true floodplain; a 25 km fire cell spans a whole valley.
- Mitigation: every hazard chip shows its resolution ("≤ ~1 km", "~25 km"); the map legend carries "Resolution-limited model estimate"; the PDF lists each layer's resolution next to its score. 

## 2. Climate-type mislabeling (user picks the type)

- The user selects the climate type; scores are computed for that type. A user picking `temperate` for Miami gets cyclone/surge dropped from the set and the whole result is wrong.
- Mitigation (normative): **(a)** the engine must compare the selected type to the Köppen class of the area centroid sampled from the nearest WorldClim tile (BIO data already ingested — a single extra raster lookup; use the standard Köppen map classification at ~1 km if available in the WorldClim family, else use WorldClim BIO12/BIO5-based empirical rule — see OPEN_QUESTIONS §10 if the engineer wants the reference map, otherwise implement the BIO12/BIO5 rule described there); **(b)** if they disagree, show a banner: `Selected "temperate" but this area is classified "tropical" (Am/Aw). Scores below assume a temperate hazard set.` — non-blocking, but unavoidable in the UI; **(c)** the area editor lists each climate type with its hazard chips (from `HAZARDS.md`) so the mismatch is visible *before* scoring.

## 3. Seasonal / temporal assumptions

- Everything is **climatology or long-run statistics** (1970–2000 WorldClim, 1980–2023 IBTrACS, 2001–2022 FWI, 1991–2020 snow, 1991–2022 SPEI). The UI must never read as "current" or forecast: scores are static per analysis and the PDF states the reference periods per layer. No "today's risk" language, no seasonal phrasing ("hurricane season peak") unless the underlying metric is seasonal by construction (FWI p90 is peak-season by design — say exactly that: "typical fire-season danger").
- Flood/surge are 1-in-100-year events — the UI must say `100-year event (1% annual chance)`, not "will flood".

## 4. Heuristic-specific gaps a savvy buyer will spot

| Hazard | Known gap | Required label |
|---|---|---|
| Flood | small-stream & urban pluvial floods missed; levees not modelled | "River-flood model (100-yr) — urban and small-stream flooding may be understated" |
| Cyclone wind | track proximity ≠ wind field; no gusts, no inland decay, no storm size | "Wind score is a track-proximity heuristic, not a wind-load model" |
| Extreme heat | no humidity/wet-bulb, no urban heat island | "Heat index from warmest-month temperature; humidity not included" |
| Wildfire | weather-only; no fuel/vegetation/suppression | "Fire danger from weather (FWI); vegetation and suppression not modelled" |
| Snow load | climatological max SWE ≠ design ground snow load; single events understated | "Approximate snow load from snow-water equivalent — not an engineering snow load" |
| Storm surge | 1 km coastal cells; no sea-level-rise scenario; wave setup embedded only | "Coastal flood model (100-yr); sea-level rise not included" |
| Drought | 0.5° cell; slow-onset indicator, indirect structural relevance | "Drought frequency — supporting indicator" |
| Landslide | 5 km susceptibility ≠ parcel hazard | "Susceptibility at ~5 km — parcel-scale landslide risk is not assessed" |

## 5. Structural-vulnerability vacuum

OSM footprints carry area/geometry but rarely height, roof type, or construction. Scores are **exposure at the location** — an empty lot and a brick hospital in the same cell score the same. Normative label (map legend + PDF disclaimer):

> "ClimaScope risk scores are model estimates of hazard exposure at each structure's location, derived from public datasets at the stated resolutions. They are not engineering assessments of any individual building and are not a substitute for site inspection, flood insurance rate maps, or professional structural analysis."

## 6. Normative UI/PDF requirements (checklist for Slice 3)

1. **Per-hazard chip (structure detail + map legend):** dataset name, resolution, reference period/return period, licence attribution, and "model estimate" tag. Not assessed (\`missing\`) dimensions show "not assessed for this area".
2. **Result header banner:** `Indicative model estimates from public data — see report for sources and limits.`
3. **Climate-mismatch banner** (§2b) whenever the sampled Köppen class disagrees with the selection.
4. **Map legend:** score ramp 1–5 with the disclaimers above at ≤ 12 px but present on hover/legend panel.
5. **PDF report:** first page — executive summary + this disclaimer verbatim + per-layer source/resolution/licence table; last page — the `sources` JSON provenance per hazard. PDF must not imply certification ("verified", "certified", "compliant" are banned words).
6. **Demo area badge:** the Miami demo area renders a small "Demo — public data only" tag.
7. **No manufacturing of certainty:** never a single combined "risk score" without the breakdown — the KPI cards already include "dominant hazard"; keep per-hazard bars visible by default (Slice 2's sortable table covers this).

## 7. Licensing/attribution failure modes (operational)

- Shipping a layer without its attribution string (WRI CC BY 4.0, JRC/EU open data terms, NASA citations incl. the GLC *required* citations, Copernicus licence notice for ERA5) — avoided by rendering `sources` verbatim.
- Redistributing the NASA GLC without the two required citations — avoided by the hard-coded attribution string in `landslide.md`.
- Displaying "public" for restricted paths (EM-DAT commercial terms; Aqueduct registration-gated download; ThinkHazard site terms) — avoided by the licensed/paid note column in `OPEN_QUESTIONS.md`.

## 8. What we deliberately do NOT claim (post-MVP honesty anchors)

- No loss-cost/expected-damage estimates (needs vulnerability + claim data — future).
- No climate *change* projections (all layers are historical climatology; the Aqueduct +SLR variant and CMIP-driven layers are explicitly excluded from the MVP).
- No per-parcel regulatory status (scores are not FEMA/NFIP determinations).