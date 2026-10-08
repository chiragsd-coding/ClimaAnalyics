# ClimaScope — Climate Risk Analytics Platform

Street-level climate risk scores for every rooftop in an area of interest, built for insurers, reinsurers, municipal planning teams, and property-portfolio managers.

Define an area (click the map or enter coordinates + radius, 0.5–10 km), pick a climate type, and ClimaScope scores every OSM structure in that area **1–5 (Very Low → Very High)** for climate risk using real public hazard datasets — shown on a color-coded map with per-structure metrics, an area average, and a downloadable PDF report. Access is area-scoped: users see only areas they're granted plus a public demo area.

## Status (MVP in progress)

| Slice | What | Status |
|---|---|---|
| 1 | Auth + area-scoped RBAC (users see only granted areas + public demo) | ✅ Done |
| 2 | Map-driven area definition + OSM footprint ingestion | ✅ Done |
| 3 | Scoring engine v1 — 8 hazard dimensions, spec combination rule (maxmean-v1), persisted analyses, area-scoped REST | ✅ Done (Miami demo band-checked; area average = mean of structure scores per spec) |
| 4 | Results UI — risk-colored map overlay, sortable table, distribution chart, KPI cards, saved results, provenance/sources disclosure | ✅ Done (verified in-browser on the live site) |
| 5 | PDF area report (risk profile + top-risk structures + sources provenance) | 🔨 In progress |
| 6 | Subscription tiers (Free demo-only / Pro $99-mo / Enterprise custom), paywall, polish | ⏳ Queued |

## Pricing (owner-ratified 2026-10-06)

- **Free** — $0 — demo area only (Miami), limited/no saved analyses or reports
- **Pro** — $99/month — owned areas, saved results, PDF reports
- **Enterprise** — custom/contact — team RBAC, bulk areas, API

Real billing is blocked until the owner connects Stripe on the Finance tab; until then the paywall gates features in-app but no real money moves.

## Workspace layout

```
/home/team/shared/
├── README.md          ← this file (project + workspace overview)
├── WORKFLOW.md        ← team code workflow (branches, PRs, deploy rules)
├── CREDENTIALS.md     ← seed accounts (private — never commit)
├── hazard-models/     ← normative hazard-model spec (cited datasets, thresholds, combination rule, validation)
├── site/              ← the app working tree (TanStack Start on Bun) — also the deploy tree; origin = chiragsd-coding/ClimaAnalyics
├── repo-scaffold/     ← original scaffold LICENSE + README (preserved, not in the app tree)
└── slice2-evidence/   ← recorded verification evidence
```

## Team

- CTO (lead) — planning, delegation, verification
- Engineer — full-stack web (frontend, backend, geospatial scoring, PDF, deploy)
- Climate-risk researcher — hazard datasets, per-climate-type hazard model spec, validation

## Repo & code workflow

- GitHub: `chiragsd-coding/ClimaAnalyics` (origin of `/home/team/shared/site`)
- The app tree is both source and deploy target: `main` must stay deployable at all times.
- Slice work lands as direct commits on `master`, pushed fast-forward to `origin/main` (see `WORKFLOW.md` for the approved exception; speculative/auth/billing changes go through PRs).
- The repo root `README.md` documents the app itself: stack, quickstart, scoring, repo layout.
