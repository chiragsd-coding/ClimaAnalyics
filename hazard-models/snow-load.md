# SNOW_LOAD — roof snow load exposure

**Canonical ID:** `SNOW_LOAD`. Applies to `temperate`, `continental`, `alpine` (not the other five types).

**What it measures:** the climatological peak snow water equivalent at the location, converted to a **ground snow load** (kPa) and compared against bands tied to typical engineering design loads. This is explicitly a **heuristic**: modern design codes compute site-specific ground snow loads from extreme-value statistics of snowfall, with density assumptions; we use a 30-year reanalysis climatological maximum as a defensible stand-in for the MVP, labeled as such.

---

## Candidate public datasets

| Dataset | Provider | URL (verified) | Measures | Resolution / coverage | Licence | Cadence | Notes |
|---|---|---|---|---|---|---|---|
| **ERA5 monthly means, single levels** (variables: `snow depth` `sd` [m of water equivalent] and `snow density` `rsn` [kg/m³]) | ECMWF / Copernicus CDS | https://cds.climate.copernicus.eu/ · dataset https://cds.climate.copernicus.eu/datasets/reanalysis-era5-single-levels-monthly-means | Monthly snow depth (supplied in metres of water equivalent in ERA5) & snow density, reanalysis | **0.25° ≈ 31 km**; global incl. polar | Copernicus Licence (free for any use; attribution "© ECMWF/Copernicus C3S") | Monthly (climatology 1991–2020) | **MVP primary.** Global, reanalysis (measured/assimilated), standard. |
| ERA5-Land (snow depth water equivalent) | ECMWF / Copernicus CDS | https://cds.climate.copernicus.eu/ (dataset "ERA5-Land monthly averaged data") | Same at higher detail | **0.1° ≈ 9 km**, global land | Copernicus Licence | Monthly | Preferred resolution upgrade if download budget allows; same scoring. |
| U.S. Climate Normals (snow depth/snowfall) | NOAA NCEI | https://www.ncei.noaa.gov/products/land-based-station/us-climate-normals | Station snow climatology | US stations | US public domain | Every 10 years | US cross-check. |
| Design snow load references | — | Eurocode EN 1991-1-3; ASCE 7 (US) minimum/ground snow load maps | — | Jurisdictional | — | — | Used only to justify the score bands (not a dataset). |

---

## Recommended primary (MVP)

**ERA5 (or ERA5-Land) monthly snow depth `sd` (m w.e.), 1991–2020 climatological maximum per cell.**

1. Per cell: `SWE_max` (kg/m²) = max of the 12 monthly mean `sd` values over the climatology period, × 1000.
2. Ground snow load: `S (kPa) = SWE_max × 9.81 / 1000`  (≈ SWE in m × 9.81 kPa, since 1 m w.e. ≈ 9.81 kPa).

### Scoring rule

| S (kPa) | Score |
|---|---|
| `< 0.5` | 1 |
| `0.5 – 1.0` | 2 |
| `1.0 – 1.7` | 3 |
| `1.7 – 2.5` | 4 |
| `≥ 2.5` | 5 |

Threshold rationale: 0.5 kPa is a typical "light snow" zone lower bound in European design practice (EN 1991-1-3 ground snow classes start near 0.5–0.9 kPa for mild regions); 1.0 kPa ≈ ordinary continental winter; 1.7 ≈ heavy-snow regions (e.g., central European/New-England design snow); 2.5 kPa ≈ mountain/upper-midwest-heavy zones where snow is a *governing* structural load. Buildings designed to modern codes handle their mapped design load — this score says "the local regime exceeds design-load ranges common for mild structures".

## Fallbacks

1. **ERA5 unavailable** (never in practice) → NOAA/NCEI normals max snow depth (cm) → `S ≈ snow_depth_cm × 0.22 / 100` kPa? *Avoid inventing a density factor:* instead, use the station's snow-depth climatology with the same ERA5-only bands replaced by: `max snow depth ≥ 50 cm → 4; 25–50 cm → 3; 5–25 cm → 2; < 5 cm → 1` (a documented empirical heuristic: 25 cm fresh snow ≈ 0.5–1 kPa). Flag `low_confidence`.
2. No data at all (polar void / bad cell) → `score = 1`, `low_confidence = true`.

## Intentional limitations

- Climatological monthly-mean maximum **understates** extreme single events (a 1-day blizzard's SWE can double a monthly mean); for `alpine` especially this is a known underestimate — see `CREDIBILITY_RISKS.md` and `VALIDATION.md`.
- Design codes use return-period ground snow load (e.g., 50-yr) with density treatment; we approximate with 30-yr climatological max. Label: "approximate snow load, heuristic".

## Implementation notes (engineer)

- CDS download of monthly means (12 months × 30 years, 2 variables) is a single request; compute the climatological max per cell once, tile as a ~31 km (or 9 km ERA5-Land) raster.
- Be careful: ERA5 `sd` is documented as **m of water equivalent**; do not multiply by snow density again (or if the chosen variable is volumetric depth, use `rsn` to convert: `S = depth_m × rsn × 9.81 / 1000` kPa). State which variable the pipeline uses in the score provenance.
- Attribution: "ERA5: © ECMWF/Copernicus C3S (Copernicus Licence)".

## Upgrade path

National/regional design snow-load maps (ASCE 7 for the US — public via NIST/FEMA publications; EN 1991-1-3 national annexes) would replace the heuristic where coverage exists.