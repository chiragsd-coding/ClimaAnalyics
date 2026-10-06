# WILDFIRE — fire danger exposure

**Canonical ID:** `WILDFIRE`. Applies to `tropical`, `arid`, `temperate`, `continental`, `mediterranean`, `alpine`, `monsoon` (not `coastal-humid`).

**What it measures:** how dangerous the local fire weather regime is — the level the **Canadian Fire Weather Index (FWI)** typically reaches in the fire season. This is a *weather-driven danger* proxy: same dataset family used operationally by European and Canadian agencies. It does **not** model vegetation type, fuel load, or suppression resources (structure-level ignition risk would need those).

---

## Candidate public datasets

| Dataset | Provider | URL (verified) | Measures | Resolution / coverage | Licence | Cadence | Notes |
|---|---|---|---|---|---|---|---|
| **Global Fire WEather Database (GFWED)** | NASA GISS (Field et al.) | https://data.giss.nasa.gov/impacts/gfwed/ | Daily FWI & components (FFMC, DMC, DC, ISI, BUI) back to ~2001 | **0.25° ≈ 25 km**, global land | NASA public domain (US Gov works); cite NASA GISS GFWED | Daily (archive to present) | **Recommended FWI source.** Research-grade; processing pipeline needed to make climatology. |
| ERA5-based Fire Danger Indices (FWI) | ECMWF / Copernicus CDS | https://cds.climate.copernicus.eu/ (search "Fire danger indices" — the current dataset slug was NOT resolvable from the dev box during spec writing, see OPEN_QUESTIONS §12) | Daily FWI from ERA5 | 0.25°, global land | Copernicus Licence (free, attribution) | Daily/monthly aggregations | Alternate channel if the CDS dataset slug is confirmed; same FWI concept |
| GFED4s burned area | Global Fire Emissions Database (NASA/UC) | https://www.globalfiredata.org/ | Monthly burned-area fraction 1997–2016 | 0.25°, global | Public with attribution (site terms) | Static (4s) | Used for **validation** (burned-area frequency vs our FWI score) and as fallback. |
| EFFIS / GWIS (Europe + global) | EC JRC / Copernicus | https://effis.jrc.ec.europa.eu/ · https://gwis.jrc.ec.europa.eu/ | FWI-based danger maps, fire events, seasonal outlooks | Europe high-res; global products | Copernicus licence | Daily | Context + validation for European areas. |
| FWI danger classes (reference) | Natural Resources Canada (CW-FIS) | https://cwfis.cfs.nrcan.gc.ca/background/summary/fwi | Official interpretation bands of FWI values | — (methodology) | Public | — | Source of the class bands used below. |

---

## Recommended primary (MVP)

**FWI climatology from GFWED, 2001–2022, 0.25°.** (GFWED is the verified channel. The CDS-era "Fire danger indices" dataset is a licence-equivalent alternative — the engineer may switch only after confirming its current slug works, and must then record the choice in the layer attribution; same scoring applies either way.)

Per grid cell, compute the **90th percentile of daily FWI over 2001–2022** (this is the *typical peak-season* fire-danger level; 90th pct is robust to rare outliers). Call it `FWI_p90`. (If only monthly data are available, use the mean of the top-3 monthly means per year — but daily percentile is preferred; the engineer picks whichever one is available from their chosen channel, both are valid, record which in the score provenance.)

Score with the **standard FWI danger classes** (NRCan):

| FWI_p90 | Class | Score |
|---|---|---|
| `< 5.2` | Very Low | 1 |
| `5.2 – 11.2` | Low | 2 |
| `11.2 – 21.3` | Moderate | 3 |
| `21.3 – 38.0` | High | 4 |
| `≥ 38.0` | Extreme | 5 |

Threshold rationale: these are the published Canadian FWI danger bands used by fire agencies across the world (source URL above) — we adopt the public standard rather than inventing bands. A cell whose *typical peak season* sits in Extreme is a landscape where structures are regularly threatened.

## Fallback — no FWI climatology ingested for the area

**GFED4s burned-area frequency heuristic:** for each 0.25° cell, `F` = fraction of years 1997–2016 with a burned fraction > 0.5% of the cell.

| F | Score |
|---|---|
| `F = 0` | 1 |
| `0 < F ≤ 0.10` | 2 |
| `0.10 < F ≤ 0.25` | 3 |
| `0.25 < F ≤ 0.40` | 4 |
| `F > 0.40` | 5 |

(Observed burn frequency ≠ danger, but it is a defensible, real-data proxy when FWI is unavailable. Flag `low_confidence`.)

If neither layer exists → `score = 1`, `low_confidence = true`.

## Missing-data & coverage notes

- GFWED skips some high-latitude (>80°N) and small-island cells: those fall through to GFED4s (also 0.25°) → if both empty → 1 with flag.
- 0.25° is coarse: a Mediterranean hillside and its valley town share one cell. Accepted for MVP; UI caveat ("~25 km fire-weather cell").

## Implementation notes (engineer)

- GFWED download: NetCDF/ASCII via the GISS page; per-cell 90th percentile over ~8,000 daily values — one-pass quantiles over a precomputed per-year monthly-max table is fine.
- Do **not** ship 22 years of daily data to the client; precompute the p90 raster once and tile it.
- Attribution: "NASA GISS GFWED (Field et al.); public domain" or "Copernicus C3S ERA5 FWI — © ECMWF"; plus "FWI classes: Natural Resources Canada".

## Upgrade path

Fuel-model + ignitions/suppression layers (e.g., USFS Wildfire Hazard Potential for the US, public domain) or GWIS exposure layers; structure-level ignition modelling is post-MVP.