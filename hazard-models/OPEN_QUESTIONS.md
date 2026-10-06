# OPEN_QUESTIONS.md — genuinely open decisions (owner / engineer / legal)

Only items the spec itself could not settle. Everything else in this directory is normative. Each item says who should decide and what happens if it goes the other way.

## 1. WorldClim v2.1 licence wording for commercial resale
- **What:** WorldClim grants free access with attribution, but the exact CC terms for a *subscription product that resells derived scores* were not verifiable from the dev box (license text on the site's JS pages didn't extract). 
- **Who:** owner + legal review before subscription launch.
- **If restricted:** switch the heat layer to ERA5-derived warmest-month temperature (Copernicus licence, free for any use with attribution) at ~31 km; same thresholds; ~1 day of engineer time. MVP can ship WorldClim, but flag the risk in the release evidence.

## 2. WRI Aqueduct Floods licence confirmation
- **What:** the Aqueduct page (verified) carries WRI's standard CC BY 4.0 data licence; the download is free but **registration-gated**. Confirm no per-seat/API restrictions apply to serving derived per-structure scores to subscribers.
- **Who:** engineer (during ingest) + owner (if terms differ).
- **If restricted:** JRC Europe+Med covers Europe; the US can use FEMA NFHL; other regions would fall back to the extent/elevation heuristics — degrade, not block.

## 3. ThinkHazard data-access mechanics & licence
- **What:** the former `/en/resources` download page 404s; the site (verified) publishes per-location hazard reports. If we want ThinkHazard as the cyclone fallback, the engineer must confirm the data/API access route and terms from the live site.
- **Who:** engineer.
- **If unavailable:** IBTrACS proximity scoring alone remains the primary; no impact.

## 4. NOAA IBTrACS version pinning
- **What:** product line is v4 with release letters; pin the exact release (e.g., v04r01) and record it in `sources` so scores are reproducible. Decide whether NOAA's "we request attribution to NOAA/NCEI IBTrACS" wording in the PDF footer suffices (it does for MVP; legal can weigh in later).
- **Who:** engineer (pin) — no decision needed upstream.

## 5. Heat: add humidity/wet-bulb term, or not?
- **What:** MVP heat = warmest-month temperature only. A WBGT/heat-index augmentation (ERA5 dew point + 2 m temp) is a clean Slice-4 improvement and meaningful for `coastal-humid` and `monsoon` (humid heat is deadlier). 
- **Who:** owner (scope decision).
- **Default if no answer:** stay on temperature-only for MVP; `OPEN_QUESTIONS` entry in the report preview text ("humidity not included").

## 6. SPEI portal reachability & redistribution terms
- **What:** spei.csic.es is the canonical SPEI-GDM source but was **blocked from the dev box** (page: "The URL you has been blocked" — egress restriction, not necessarily a site fault). Confirm reachability from the production network, and confirm the site's reuse terms (it requests citation of Vicente-Serrano et al. 2010; redistribution of derived rasters needs their ok).
- **Who:** engineer (reachability) + owner (terms).
- **If unreachable:** implement the "skip drought with 'not assessed'" fallback from `drought.md` (weights re-normalise) — do **not** swap in an unverified drought dataset.

## 7. SEDAC access & preferred landslide channel
- **What:** sedac.ciesin.columbia.edu blocks curl from the dev box; the Global Landslide Hazard Distribution is verified (DOI 10.7927/H4P848VZ, NASA catalog record with US-Gov-public-domain licence). Engineer should pull it via the WMS services link listed on the SEDAC page or via NASA Earthdata search once network access is sorted. Also: NASA publishes newer susceptibility products (GSLM family) — check the NASA catalog for a newer public raster **before** wiring ingest; if one exists with a working URL, prefer it, keeping the same 1–5 mapping (values are 0–1 probabilities → bands ≥0.05/0.15/0.3/0.5 require the engineer to re-derive with this file's logic and record the mapping).
- **Who:** engineer.

## 8. Storm surge for `monsoon` coasts
- **What:** Bay-of-Bengal/South-China-Sea surges are real and the `monsoon` set currently excludes `STORM_SURGE` (kept out to limit MVP scope; cyclone+flood weights carry the signal). 
- **Who:** owner.
- **Default:** keep excluded; re-open if a South-Asian customer lands.

## 9. Landslide for `mediterranean`
- **What:** mediterranean hillsides fail (Italy, Greece) but the type excludes landslide in the MVP. 
- **Who:** owner.
- **Default:** excluded; the layer exists and it is ~1 line of config to add it back with a weight re-normalisation.

## 10. Köppen check reference for the climate-mismatch banner
- **What:** the normative banner in `CREDIBILITY_RISKS.md` §2 compares the user's climate pick to the area's Köppen class. The cleanest source is a published global Köppen map raster (e.g., Beck et al. 2018 *Scientific Data*, CC BY 4.0 — dataset on figshare/zenodo), but we could not verify a stable download URL this session.
- **Who:** engineer locates it (30 min); if not found, implement the fallback empirical rule: `tropical` if BIO12 ≥ 1,500 mm/yr AND BIO5 ≥ 27 °C; `arid` if BIO12 < 350 mm/yr OR (BIO12 < 2·(BIO1+7) per Köppen's aridity index... simplest defensible cutoff: BIO12 < 400 mm/yr); else `temperate`. Record which rule was used next to the banner.
- **Impact if missed:** banner silently absent (UI still works); lower priority than everything else on this list.

## 11. FEMA NFHL access route in production
- **What:** fema.gov bot-blocks curl; NFHL data is served via FEMA's public ArcGIS REST map service (no key for read-only use). Engineer must confirm the service endpoint and its attribution string during Slice 3 validation (US cities only).
- **Who:** engineer.

## 12. GFWED vs CDS ERA5-FWI channel choice
- **What:** either channel yields the same FWI climatology; GFWED is NASA-public-domain and its URL is verified. A CDS "Fire danger indices" dataset exists in the catalogue, but **no current dataset slug resolved from the dev box** (`fire-danger-indices-*` all 404). 
- **Who:** engineer — try the CDS catalogue search; if a working slug is found, either channel is acceptable (pick by download ergonomics, record the choice in the layer's attribution). If not, **GFWED is the primary channel** — no impact on scoring.
- **Rule:** use daily values, one channel, document it.

---

**Items needing the owner before subscription launch (upstream of product):** #1 (WorldClim commercial terms), #2 (Aqueduct terms), #6 (SPEI terms), #8/#9 (climate-set scope). Everything else is engineer-runnable now.