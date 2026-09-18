# Slice 2 — map-driven areas & OSM footprint ingestion (engineering notes)

Slice 2 adds the map-driven area UI on top of the slice-1 auth/RBAC/SQLite core.
This doc records the ingest contract that **Slice 3 (scoring engine) builds on**.

## Endpoints (all under session auth; errors are `{ "error": string }`)

| Method & path | Who | Notes |
|---|---|---|
| `POST /api/areas` | admin, analyst | Creates the area, auto-grants the creator, then runs the **inline** Overpass ingest (55 s budget). Returns 201 `{ area, structures }` even when the ingest fails (area still exists, `fetch_status='failed'`). |
| `POST /api/areas/:id/structures/fetch` | area owner or admin (`canEditArea`) | Re-ingests, replacing stored footprints. Returns `{ area, structures, structures_cap }`. RBAC: `requireAreaAccess` (404 when no access) + `canEditArea` (403). |
| `GET /api/areas/:id/structures` | any user with area access | `?limit=` 1–5000 (default 5000). Read-only. |
| `GET /api/areas/:id` | any user with area access | `publicArea` shape incl. `fetch_status`, `fetch_note`, `fetched_at`, `structures_count`. |

Missing access is always **404, never 403** (`requireAreaAccess`) so other users'
areas are not discoverable. Demo areas are readable by everyone, editable only by admins.

## Ingest result shape (`IngestResult`, src/lib/overpass.ts)

```ts
{
  status: "ok" | "failed",   // "failed" never throws to the caller
  count: number,             // structures actually stored (after deterministic cap)
  reported: number | null,   // buildings Overpass reported, when known
  capped: boolean,           // true when count hit MAX_STRUCTURES_PER_AREA (12,000)
  note: string,              // human-readable, surfaced verbatim in the UI
  took_ms: number,
}
```

## Structures table rows (what the scoring engine consumes)

Per area, one row per OSM `way["building"]` (deterministic subset: sorted by
numeric osm id, first 12,000 kept):

- `osm_id` — `way/<numeric id>` (unique per area via partial unique index)
- `centroid_lat`, `centroid_lon` — polygon centroid, 6-decimal (~1 m)
- `footprint` — JSON array of `[lat, lng]` pairs, closed ring, simplified
  (Douglas-Peucker 3 m tolerance, decimated to ≤ 64 vertices)
- `props` — JSON:
  ```json
  {
    "area_m2": 142,                // shoelace area of the simplified ring
    "levels": 3,                   // from building:levels / levels / roof:levels, or null
    "building": "yes",             // OSM building tag value
    "name": "Optional OSM name",
    "source": "OpenStreetMap via Overpass API"
  }
  ```
- `props` is **source data from OSM**, not model output. Risk scores live in
  `structure_scores` (slice 3) and must never be written back into `props`.

## Overpass etiquette (encoded in src/lib/overpass.ts — keep it)

- Identified `User-Agent: ClimaScope/0.1 (building-footprint ingestion; demo platform)`
- `[timeout:50]` server-side; client-side budget `DEFAULT_INGEST_BUDGET_MS = 55s`
- One fast-fail retry (429/5xx/network blip < 10 s); payload cap 120 MB;
  raw rings > 512 vertices skipped; `MAX_STRUCTURES_PER_AREA = 12000`
- **Ingest is only ever triggered by an explicit user action** (create flow or
  the area page button) — never on page load, keystroke, or re-render.

## Frontend map (slice 2 UI)

- Leaflet 1.9 + OpenStreetMap raster tiles with attribution; Leaflet is
  dynamically imported inside effects only (`src/lib/leaflet.ts`) so SSR never
  evaluates it (`vite.config.ts` keeps it out of the SSR bundle).
- `/areas/new` — click-to-centre or typed coordinates, radius slider 0.5–10 km
  with live circle preview, all-8 climate picker with per-type hazard chips.
- `/areas/$areaId` — area map + circle + footprint overlay sample (≤ 600 rings
  via `?limit=`), KPI tiles (count/radius/centre/fetch status), fetch button
  with elapsed-seconds progress + 150 s client abort, climate & hazard panel.
  Viewers and non-owner demo visits are read-only by design.
