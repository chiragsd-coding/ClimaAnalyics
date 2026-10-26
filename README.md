# ClimaScope — Climate Risk Analytics Platform

Street-level climate risk scores for every rooftop in an area of interest, built for insurers, reinsurers, municipal planning teams, and property-portfolio managers.

Define an area (click the map or enter coordinates + radius, 0.5–10 km), pick a climate type, and ClimaScope scores every OSM structure in that area **1–5 for climate risk** — **1 Very Low, 2 Low, 3 Moderate, 4 High, 5 Very High** — using real public hazard datasets, shown on a color-coded map with per-structure metrics, an area average, and two downloadable PDF reports: per-analysis, and per-area with a rooftop-level visualization (every building drawn individually in its risk-band color).

## Status (MVP complete)

| Slice | What | Status |
|---|---|---|
| 1 | Auth + area-scoped RBAC (users see only granted areas + public demo) | ✅ Done |
| 2 | Map-driven area definition + OSM footprint ingestion | ✅ Done |
| 3 | Scoring engine v1 — 8 hazard dimensions, spec combination rule (maxmean-v1), persisted analyses, area-scoped REST | ✅ Done (Miami demo band-checked, avg 4.00) |
| 4 | Results UI — risk-colored map overlay, sortable table, distribution chart, KPI cards, saved results, provenance/sources disclosure | ✅ Done (verified in-browser on the live site) |
| 5 | PDF area report (risk profile + top-risk structures, per-analysis) | ✅ Done (verified live: PDF endpoint, RBAC 401/403/404, all report tests green) |
| 6 | Subscription tiers (Free demo-only / Pro $99-mo / Enterprise custom), paywall, plan badge, upsell panels, Enterprise lead capture | ✅ Done (tiers live, gates in-app; real payments pending provider credentials) |
| 7 | Billing gateway — env-selected provider (Stripe or Razorpay), checkout + signature-verified webhooks | ✅ Done (provider-selection contract proven by env-switch test; runs honestly disabled until real credentials land) |
| 8 | Per-area rooftop-level PDF report — every building drawn individually in its risk-band color | ✅ Done (verified live: Pro → 312 KB 5-page A4 PDF for the Miami demo; Free → 403 with Pro upsell) |

## Scoring

The hazard-model specification lives in [`hazard-models/`](hazard-models/README.md) — real, cited public datasets (NOAA IBTrACS hurricane tracks, SRTM elevation, JRC flood maps, WorldClim, NASA GFWED, and more) mapped to 8 climate types, each with concrete 1–5 thresholds and a normative combination rule (max-vs-weighted-mean blend, `maxmean-v1`). Build/OSM footprints come from OpenStreetMap.

The 1–5 band labels are **owner-pinned and must stay verbatim** everywhere (UI legend, PDFs, tests): `1 Very Low · 2 Low · 3 Moderate · 4 High · 5 Very High`.

Scores are **model estimates, clearly labeled**, not engineering surveys; each score row persists dataset attribution for licence compliance. Where a data layer is unavailable, dimensions are flagged `not_assessed` / `low_confidence` rather than fabricated — in PDFs, not-assessed buildings are drawn in neutral gray and counted honestly.

## Billing (env-configurable gateway)

The payment gateway is **selected in the env file** — no code changes to switch or add providers:

```bash
# .env (gitignored; .env.example documents the names with DUMMY placeholders)
BILLING_PROVIDER=stripe        # "stripe" or "razorpay"; unset = billing disabled

# Stripe (required when BILLING_PROVIDER=stripe)
STRIPE_SECRET_KEY=…            # secret API key
STRIPE_PRICE_ID=…              # recurring Price object for Pro ($99/month)
STRIPE_WEBHOOK_SECRET=…        # signing secret for POST /api/billing/webhook/stripe

# Razorpay (required when BILLING_PROVIDER=razorpay)
RAZORPAY_KEY_ID=…
RAZORPAY_KEY_SECRET=…
RAZORPAY_WEBHOOK_SECRET=…      # for POST /api/billing/webhook/razorpay
RAZORPAY_CURRENCY=INR          # optional, default INR
```

- **Only the selected provider's values are passed to the code** (per-request resolution). Flipping `BILLING_PROVIDER` switches gateways; the other provider's variables are never read. This contract is proven by the env-switch test in `scripts/billing-test.ts` (section s) and the h2 guard tests.
- **Honest disabled state**: a value is "configured" only when non-empty and not a `DUMMY_` placeholder. With placeholders (the committed default), checkout returns the standard "billing is being connected" note — no fabricated checkout URLs — and **no tier can ever upgrade**: a tier becomes `pro` ONLY via a signature-verified provider webhook while the provider is fully configured. Even an event signed with the placeholder webhook secret is rejected (guard enforced in `src/lib/billing/index.ts`, tested in section h2).
- **Adding other providers**: implement the `BillingProvider` interface (`createCheckoutSession`, `verifyWebhook`) in one new file under `src/lib/billing/`, register it in the resolver, and add its env var names to `BILLING_ENV_VARS` + `.env.example`. Everything else (checkout endpoint, webhook routing, tier gating, tests) is provider-agnostic.
- Pro price is a single config value: `PRO_PRICE_MONTHLY` in `src/lib/plans.ts`.

## API summary

| Endpoint | What |
|---|---|
| `POST /api/auth/register · login · logout`, `GET /api/me` | session auth |
| `GET/POST/PATCH/DELETE /api/areas…`, `/api/areas/:id/access…` | areas + area-scoped grants |
| `POST /api/areas/:id/analyses`, `GET …/analyses/:id/scores · sources` | run + fetch scoring results |
| `GET /api/areas/:id/analyses/:aid/report.pdf` | per-analysis PDF report |
| `GET /api/areas/:id/report.pdf` | per-area rooftop PDF report (latest completed analysis) |
| `POST /api/billing/checkout` | provider-hosted checkout for Pro (honest no-creds state without credentials) |
| `POST /api/billing/webhook/stripe · razorpay` | signature-verified payment events — the only tier-upgrade path |

Area-scoped RBAC applies everywhere: no grant → 404 (matching the app-wide convention), viewer role → 403, free tier on gated downloads → 403 with Pro upsell copy.

## Stack

- **TanStack Start** (React 19 + Vite + Tailwind CSS 4) on **Bun**
- **bun:sqlite** single-file DB (`.data/climascope.db`, gitignored)
- **Leaflet** for maps; **pdf-lib** for PDF generation (no SDK dependency for billing — plain REST via fetch)
- Served on port 3000; deploy with `bun run publish` from this directory (the app tree is both source and deploy target — keep `main` deployable at all times)

## Quickstart

```bash
bun install
bun scripts/seed.ts        # seeds admin + demo accounts and the Miami demo area (writes CREDENTIALS.md at /home/team/shared/CREDENTIALS.md)
bun run dev                # local dev
bun scripts/rbac-test.ts   # RBAC unit tests
bun scripts/scoring-test.ts --demo   # scoring unit tests + Miami demo band check
bun scripts/report-test.ts # PDF report tests (both reports: content, RBAC, tier gates)
bun scripts/billing-test.ts          # billing gateway tests (selection, honest state, signatures, h2 guard)
bun scripts/plans-test.ts  # pricing/tier gate tests
bun run publish            # build + serve on :3000 (live deploy)
```

Seed accounts are documented in `/home/team/shared/CREDENTIALS.md` (private, never committed). Reset the demo DB with `bun scripts/seed.ts --reset`.

## Repo layout

```
src/lib/db.ts          # schema + migrations (PRAGMA user_version guarded)
src/lib/scoring.ts     # scoring engine: hazard evaluators + combine() per spec
src/lib/overpass.ts    # OSM footprint ingestion
src/lib/rbac.ts        # area-scoped access control
src/lib/plans.ts       # tiers + pricing config (PRO_PRICE_MONTHLY, billingNote)
src/lib/report.ts      # per-analysis PDF builder (band colors, disclaimer)
src/lib/area-report.ts # per-area rooftop PDF builder (footprint visualization page)
src/lib/billing/       # env-selected payment gateway (index + stripe.ts + razorpay.ts)
src/rest/api.ts        # REST endpoints (areas, structures, analyses, scores, reports, billing)
src/components/        # ResultsPanel (downloads + upsell), Plans, AreaMap, Dashboard
src/routes/            # TanStack Start routes (dashboard, area detail, auth)
hazard-models/         # the normative hazard-model specification (Slice 3 input)
scripts/               # seed + unit tests
```

## Conventions

- `main` is always deployable; slice work lands as direct commits on `master`, pushed fast-forward to `origin/main` (see `/home/team/shared/WORKFLOW.md`).
- `.data/` (DB), `.env` (real credentials), `dist/`, and credentials files are gitignored — never commit them. `.env.example` documents variable NAMES with `DUMMY_` placeholder values only.
- Scores are honest outputs of real data: where a layer is unavailable (e.g. OpenStreetMap unreachable from the dev box), dimensions are flagged `not_assessed` / `low_confidence` rather than fabricated.
- Owner-pinned wording (band labels, tier prices, the billing note) must stay verbatim across UI, PDFs, and tests.
