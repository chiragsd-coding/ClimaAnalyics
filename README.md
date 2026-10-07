# ClimaScope — Climate Risk Analytics Platform

Street-level climate risk scores for every rooftop in an area of interest, built for insurers, reinsurers, municipal planning teams, and property-portfolio managers.

Define an area (click the map or enter coordinates + radius, 0.5–10 km), pick a climate type, and ClimaScope scores every OSM structure in that area **1–5 (Very Low → Very High)** for climate risk using real public hazard datasets — shown on a color-coded map with per-structure metrics, an area average, and a downloadable PDF report (roadmap).

## Status (MVP in progress)

| Slice | What | Status |
|---|---|---|
| 1 | Auth + area-scoped RBAC (users see only granted areas + public demo) | ✅ Done |
| 2 | Map-driven area definition + OSM footprint ingestion | ✅ Done |
| 3 | Scoring engine v1 — 8 hazard dimensions, spec combination rule (maxmean-v1), persisted analyses, area-scoped REST | ✅ Done (Miami demo band-checked, avg 4.16) |
| 4 | Results UI — risk-colored map overlay, sortable table, distribution chart, KPI cards, saved results | 🔨 In progress |
| 5 | PDF area report (risk profile + top-risk structures) | ⏳ Queued |
| 6 | Subscription tiers (Free demo-only / Pro $99-mo / Enterprise custom), paywall, polish | ⏳ Queued |

## Stack

- **TanStack Start** (React 19 + Vite + Tailwind CSS 4) on **Bun**
- **bun:sqlite** single-file DB (`.data/climascope.db`, gitignored)
- **Leaflet** for maps
- Served on port 3000; deploy with `bun run publish` from this directory (the app tree is both source and deploy target — keep `main` deployable at all times)

## Scoring

The hazard-model specification lives in [`hazard-models/`](hazard-models/README.md) — real, cited public datasets (NOAA IBTrACS hurricane tracks, SRTM elevation, JRC flood maps, WorldClim, NASA GFWED, and more) mapped to 8 climate types, each with concrete 1–5 thresholds and a normative combination rule (max-vs-weighted-mean blend, `maxmean-v1`). Build/OSM footprints come from OpenStreetMap. Scores are **model estimates, clearly labeled**, not engineering surveys; each score row persists dataset attribution for licence compliance.

## Quickstart

```bash
bun install
bun scripts/seed.ts        # seeds admin + demo accounts and the Miami demo area (writes CREDENTIALS.md at /home/team/shared/CREDENTIALS.md)
bun run dev                # local dev
bun scripts/rbac-test.ts   # RBAC unit tests
bun scripts/scoring-test.ts --demo   # scoring unit tests + Miami demo band check
bun run publish            # build + serve on :3000 (live deploy)
```

Seed accounts are documented in `/home/team/shared/CREDENTIALS.md` (private, never committed). Reset the demo DB with `bun scripts/seed.ts --reset`.

## Repo layout

```
src/lib/db.ts          # schema + migrations (PRAGMA user_version guarded)
src/lib/scoring.ts     # scoring engine: hazard evaluators + combine() per spec
src/lib/overpass.ts    # OSM footprint ingestion
src/lib/rbac.ts        # area-scoped access control
src/rest/api.ts        # REST endpoints (areas, structures, analyses, scores)
src/routes/            # TanStack Start routes (dashboard, area detail, auth)
hazard-models/         # the normative hazard-model specification (Slice 3 input)
scripts/               # seed + unit tests
```

## Conventions

- `main` is always deployable; slice work lands as direct commits on `master`, pushed fast-forward to `origin/main` (see `/home/team/shared/WORKFLOW.md`).
- `.data/` (DB), `dist/`, and credentials are gitignored — never commit them.
- Scores are honest outputs of real data: where a layer is unavailable (e.g. OpenStreetMap unreachable from the dev box), dimensions are flagged `not_assessed` / `low_confidence` rather than fabricated.