# EXTREME_HEAT — heat exposure

**Canonical ID:** `EXTREME_HEAT`. Applies to `tropical`, `arid`, `temperate`, `continental`, `mediterranean`, `coastal-humid`, `monsoon` (not `alpine`).

**What it measures:** the long-term climatological level of extreme heat at the location (warmest-month daily-maximum temperature), used as a structural *and* occupant-exposure proxy. The MVP does **not** model individual heat waves, humidity/wet-bulb stress, or urban heat islands.

---

## Candidate public datasets

| Dataset | Provider | URL (verified) | Measures | Resolution / coverage | Licence | Cadence | Notes |
|---|---|---|---|---|---|---|---|
| **WorldClim v2.1 BIO5** (max temperature of warmest month; also BIO1/BIO10) | WorldClim (Fick & Hijmans 2017) | https://www.worldclim.org/data/worldclim21.html · https://www.worldclim.org/data/bioclim.html | 1970–2000 mean of daily max temp of the warmest month, °C | 30 arcsec ≈ **1 km** (also 2.5/5/10 min); global land | Free access with attribution (site terms; exact CC wording & commercial terms to confirm — see OPEN_QUESTIONS §1) | Static (v2.1, released Jan 2020) | **MVP primary** — simple, global, standard. |
| ERA5 monthly means (2 m temperature) | ECMWF / Copernicus CDS | https://cds.climate.copernicus.eu/ · dataset: https://cds.climate.copernicus.eu/datasets/reanalysis-era5-single-levels-monthly-means | Reanalysis 2 m temperature 1940–present (climatologies 1991–2020) | ~0.25° ≈ **31 km**; global incl. oceans | Copernicus Licence (free for any use, attribution "© ECMWF/Copernicus C3S") | Monthly rolling | Upgrade path + recent-heatwave **validation**; coarser than WorldClim but *measured*, not interpolated. |
| NOAA/NCEI U.S. Climate Normals (1991–2020, daily max temp) | NOAA NCEI | https://www.ncei.noaa.gov/products/land-based-station/us-climate-normals | Station-based normals incl. July max temp | US stations | US public domain | Every 10 years | Alternative for US areas if preferred. |

---

## Recommended primary (MVP)

**WorldClim v2.1 BIO5** (°C, ~1 km, 1970–2000 climatology). Rationale: nominal 1 km (much finer than ERA5), global, standard in climate-risk work, one small raster to ship.

### Scoring rule

Let `T` = BIO5 (°C) at the building centroid.

| T (°C) | Score |
|---|---|
| `T < 32` | 1 |
| `32 ≤ T < 35` | 2 |
| `35 ≤ T < 38` | 3 |
| `38 ≤ T < 41` | 4 |
| `T ≥ 41` | 5 |

Threshold rationale: 32 °C ≈ typical "heat advisory" territory for many agencies; 35 °C ≈ dangerous heat for sustained periods (NWS heat-index warnings start near here at moderate humidity); 38 °C ≈ severe heat-wave days (2003 Europe, 2010 Russia); 41 °C ≈ extreme (Pakistan 2022, US Southwest events) — rare and dangerous even for healthy people. These are *climatological means of the warmest month*, so an area scoring 4–5 genuinely lives in a heat regime where structures and occupants are regularly stressed.

## Fallbacks

1. **No WorldClim cell** (rare — offshore tiny islands): use the nearest valid cell within 0.5°; if none, sample the ERA5 warmest-month climatology (1991–2020) from the CDS dataset and apply **the same thresholds** (ERA5 is rounded to 0.25° but the same bands are meaningful at that scale; flag `low_confidence`).
2. **US areas:** NOAA/NCEI normals are an acceptable equivalent (station → nearest structure within 50 km; else fall through to WorldClim).
3. Missing entirely (no path resolves) → `score = 1`, `low_confidence = true`.

## Intentional limitations (see also CREDIBILITY_RISKS.md)

- **No humidity/wet-bulb term** in the MVP: a 38 °C humid coastal city and a 38 °C dry desert city score the same. Accepted for MVP; flagged as an open improvement (OPEN_QUESTIONS §5 — a heat-index/WBGT augmentation is a clean Slice-4 upgrade).
- **No urban heat island** (impervious-surface add-on) — the 1 km climatology understates dense-city heat; UI caveat.
- **Climatology, not forecast** — the UI must never imply a current-day heat risk.

## Implementation notes (engineer)

- WorldClim BIO5 = `wc2.1_30s_bio/wc2.1_30s_bio_5.tif` inside the Bio zip on the WorldClim download page; WGS84 GeoTIFF, °C (×10 scaling in some versions — verify the scale factor at ingest!).
- Attribution: "WorldClim v2.1 (Fick & Hijmans 2017), free access with attribution".

## Upgrade path

ERA5-Based WBGT / Heat-Index layers (e.g., CDS derived monthly indicators) — or the NOAA/NCEI heat-index model on ERA5-Land 2 m temp + dew point.