# CYCLONE_WIND — tropical-cyclone wind exposure

**Canonical ID:** `CYCLONE_WIND`. Applies to `tropical`, `coastal-humid`, `monsoon` (see `HAZARDS.md`).

**What it measures:** how often and how hard tropical cyclones pass near the structure. The MVP has **no wind-field model**; it scores a **track-proximity heuristic** derived from the historical best-track record, clearly labeled as such (a Cat-4 passing 100 km away implies strong winds even though the exact gust at the site is unmodelled).

---

## Candidate public datasets

| Dataset | Provider | URL (verified) | Measures | Resolution / coverage | Licence | Cadence | Notes |
|---|---|---|---|---|---|---|---|
| **IBTrACS v4** (International Best Track Archive for Climate Stewardship) | NOAA NCEI | https://www.ncei.noaa.gov/products/international-best-track-archive | 6-hourly TC center positions + max sustained wind + Saffir–Simpson category, all basins, 1842–present (reliable density ~1980+) | Point tracks, global basins | US public domain (NOAA); cite NOAA/NCEI IBTrACS | Annual-ish releases (v4, release letter on page) | **MVP primary.** |
| ThinkHazard "Cyclone" hazard class | GFDRR (World Bank) | https://thinkhazard.org/ (hazard report per location; the former `/en/resources` download page now 404s — data access via the site/API to confirm) | Per-location hazard class (Low / Medium / High) derived from cyclone-track proximity + intensity (methodology on site) | Administrative/location-level classes (method uses IBTrACS-GAR15 family) | Site terms; see OPEN_QUESTIONS §3 | Static | Good independent cross-check for validation; secondary fallback. |
| NOAA SLOSH (US basins only) | NOAA NWS | https://slosh.nws.noaa.gov/ (reference, not verified this session) | Storm surge hydrographs — wind-driven surge, not wind load | US coastal basins | US public domain | Per-storm | For surge mixtures; not used in MVP wind score. |

*Not used:* EM-DAT (event records — validation only, https://www.emdat.be/).

---

## Recommended primary (MVP)

**IBTrACS v4 track-proximity heuristic.** Rationale: the only fully public, authoritative global cyclone record; simple to rasterize; fully transparent ("X cyclones of category ≥ Y passed within Z km since 1980"). Wind speed at the structure is *not* modelled — that is stated in the UI string (see `CREDIBILITY_RISKS.md`).

### Scoring rule

Precompute per 0.05° cell (or on the fly per structure) over **all IBTrACS records for 1980-01-01 → 2023-12-31**:

- `R_min` = distance (km, haversine) from structure to **any** TC center position in the record;
- `C_max` = maximum Saffir–Simpson category among TC center positions within **300 km** of the structure (use the best-track `USA_WIND` or basin-agency category field; prefer `SSHWS`/category field where present, else derive from max wind: Cat 1 ≥33 m/s, 2 ≥43, 3 ≥50, 4 ≥58, 5 ≥70 — 1-min sustained).

| Condition | Score |
|---|---|
| `C_max ≥ 4` **and** `R_min < 50 km` | 5 |
| `C_max ≥ 3` **and** `R_min < 75 km` | 4 |
| `C_max ≥ 2` **and** `R_min < 100 km` | 3 |
| any TC (including Cat 1) with `R_min < 200 km` | 2 |
| otherwise | 1 |

Rationale: a structure inside the radius where a strong TC *actually* tracked is exposed to its wind field; the bands get stricter with intensity. Inland decay and storm-relative asymmetry are **not** modelled (documented limitation). For `tropical`/`coastal-humid` users this is the dominant input for coastal cities (Miami: expect 4–5 along the coast, 3–4 slightly inland at ~1 km resolution — see `VALIDATION.md`).

## Fallback — no IBTrACS data ingested / import failure

Use **ThinkHazard cyclone class** for the area center: `Low → 2`, `Medium → 3`, `High → 4` applied to every structure in the area, with `low_confidence = true` (classed layer, no 5 possible). If ThinkHazard also unavailable → `score = 1`, flag "not assessed".

## Missing-data handle

IBTrACS covers all basins globally; the only genuine gap is pre-1980 (excluded by design). No other missing-data path exists in practice; if the import yields zero tracks within 500 km since 1980 (e.g., a mislabelled interior area), score = 1 and flag it.

## Implementation notes (engineer)

- IBTrACS distribution: CSV/NetCDF for v4r0x; ingest to a local table (id, time, lat, lon, wind, category, basin). ~50k–100k rows/year → trivial for SQLite.
- Precompute per-cell aggregates only for areas that actually request scoring (or cache globally at 0.05° once — 7.2M cells × 2 ints ≈ 60 MB; either is fine).
- Distance calc: haversine with Earth radius 6,371 km; per structure vs. all track points is O(N×M) — bound it with a coarse cell-index on tracks.
- Attribution: "NOAA NCEI IBTrACS v4, public domain".

## Upgrade path

GAR15/global wind-field rasters (e.g., design wind speed at 50-yr RP) or a Holland/wind-profile model applied to the same IBTrACS tracks — a genuine accuracy jump for the tropical product later.