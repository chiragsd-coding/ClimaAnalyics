/**
 * Slice 2 — area detail: map with the radius circle and an OSM footprint
 * overlay, footprint count, explicit fetch/refresh action, and the climate's
 * hazard-model set. Read actions use the SSR loader; the only writes are the
 * explicit fetch button (server enforces canEditArea) — viewers get a
 * read-only page, and inaccessible areas 404 here exactly like in the API.
 */
import { createFileRoute, Link, notFound, redirect } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AreaMap } from "~/components/AreaMap";
import { Nav } from "~/components/Nav";
import { ResultsPanel } from "~/components/ResultsPanel";
import { Alert, ClimateChip, DemoBadge, Spinner } from "~/components/ui";
import { climateByValue, HAZARD_LABELS } from "~/lib/climates";
import { fmtCoord, fmtDate, fmtDateTime } from "~/lib/format";
import type { LatLng } from "~/lib/leaflet";
import { getAreaDataFn, type AreaPublic, type DashboardUser } from "~/lib/server/queries";

export const Route = createFileRoute("/areas/$areaId")({
  loader: async ({ params }) => {
    const areaId = Number(params.areaId);
    if (!Number.isInteger(areaId) || areaId <= 0) throw notFound();
    const data = await getAreaDataFn({ data: areaId });
    if (!data.user) throw redirect({ to: "/login", search: { next: `/areas/${areaId}` } });
    if (!data.area) throw notFound();
    return data;
  },
  component: AreaDetailPage,
});

/** Shape of the structures fetch response (mirrors IngestResult in overpass.ts). */
type IngestInfo = {
  status: "ok" | "failed";
  count: number;
  reported: number | null;
  capped: boolean;
  note: string;
  took_ms: number;
};

function isPoint(p: unknown): p is [number, number] {
  return Array.isArray(p) && p.length === 2 && typeof p[0] === "number" && typeof p[1] === "number";
}

/** Overlay sample size — the full set can be 12k polygons; this is a preview. */
const OVERLAY_LIMIT = 600;

function AreaDetailPage() {
  // The loader redirects (no session) or throws notFound() (no access) unless
  // both user and area are present, so this shape is guaranteed here.
  const boot = Route.useLoaderData() as { user: DashboardUser; area: AreaPublic; canEdit: boolean };
  const [area, setArea] = useState<AreaPublic>(boot.area);
  const canEdit = boot.canEdit;

  const [footprints, setFootprints] = useState<LatLng[][] | null>(null);
  const [overlayVersion, setOverlayVersion] = useState(0);
  const [fetchState, setFetchState] = useState<"idle" | "running" | "success" | "error">("idle");
  const [fetchMsg, setFetchMsg] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);

  // Footprint overlay: one REST read per area+version. Never on keystrokes or
  // re-renders — the Overpass/ingest traffic stays behind explicit buttons.
  useEffect(() => {
    if (area.structures_count === 0) {
      setFootprints([]);
      return;
    }
    const ctrl = new AbortController();
    setFootprints(null);
    void (async () => {
      try {
        const res = await fetch(`/api/areas/${area.id}/structures?limit=${OVERLAY_LIMIT}`, {
          signal: ctrl.signal,
        });
        if (!res.ok) {
          setFootprints([]);
          return;
        }
        const data = (await res.json().catch(() => null)) as {
          structures?: Array<{ footprint: unknown }>;
        } | null;
        const rings: LatLng[][] = (data?.structures ?? []).flatMap((s) => {
          if (!Array.isArray(s.footprint) || s.footprint.length < 3) return [];
          return [s.footprint.filter(isPoint).map((p) => ({ lat: p[0], lng: p[1] }))];
        });
        setFootprints(rings);
      } catch {
        setFootprints([]);
      }
    })();
    return () => ctrl.abort();
  }, [area.id, area.structures_count, overlayVersion]);

  async function runFetch() {
    if (fetchState === "running") return;
    setFetchState("running");
    setFetchMsg(null);
    setElapsed(0);
    const started = Date.now();
    const ticker = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    // The server ingests under a ~55 s budget; leave generous headroom so a
    // slow but successful run is never cut off, yet the UI can never hang forever.
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 150_000);
    try {
      const res = await fetch(`/api/areas/${area.id}/structures/fetch`, {
        method: "POST",
        signal: ctrl.signal,
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        area?: AreaPublic;
        structures?: IngestInfo;
      };
      if (!res.ok) {
        setFetchState("error");
        setFetchMsg(data.error ?? "Footprint fetch failed — please try again.");
        return;
      }
      if (data.area) setArea(data.area);
      setOverlayVersion((v) => v + 1);
      if (data.structures?.status === "failed") {
        setFetchState("error");
        setFetchMsg(data.structures.note);
      } else {
        setFetchState("success");
        setFetchMsg(data.structures?.note ?? `Loaded ${data.structures?.count ?? 0} footprints.`);
      }
    } catch (err) {
      setFetchState("error");
      setFetchMsg(
        (err as Error | undefined)?.name === "AbortError"
          ? "Gave up waiting after 150 s — the fetch may still have completed server-side; reload this page to see the result."
          : "Network error while fetching footprints — please retry."
      );
    } finally {
      clearInterval(ticker);
      clearTimeout(timeout);
    }
  }

  const climate = climateByValue(area.climate_type);
  const overlayText =
    area.structures_count === 0
      ? "No footprints yet — fetch building footprints from OpenStreetMap."
      : footprints === null
        ? "Drawing footprint overlay…"
        : footprints.length < area.structures_count
          ? `Overlay shows a sample of ${footprints.length.toLocaleString()} of ${area.structures_count.toLocaleString()} footprints.`
          : `${footprints.length.toLocaleString()} footprints drawn.`;

  return (
    <main className="min-h-dvh bg-slate-50">
      <Nav user={{ name: boot.user.name, role: boot.user.role }} active="dashboard" />
      <div className="mx-auto max-w-6xl px-6 py-10">
        <p className="text-sm text-slate-500">
          <Link to="/dashboard" className="hover:text-slate-900">
            ← All areas
          </Link>
        </p>

        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-slate-900">
              {area.name}
              {area.is_demo && <DemoBadge />}
            </h1>
            <p className="mt-0.5 text-sm text-slate-500">
              {[area.city, area.country].filter(Boolean).join(", ") || "No location text"} · created{" "}
              {fmtDate(area.created_at)}
            </p>
          </div>
          {!canEdit && (
            <span className="chip bg-slate-100 text-slate-700 ring-1 ring-slate-200 ring-inset">
              Read-only access
            </span>
          )}
        </div>

        {/* KPI row */}
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Building footprints"
            value={area.structures_count.toLocaleString()}
            hint={
              area.structures_count > 0
                ? `Fetched ${area.fetched_at ? fmtDateTime(area.fetched_at) : "recently"}`
                : "No footprint fetch yet"
            }
          />
          <StatTile
            label="Radius"
            value={`${area.radius_km} km`}
            hint={`≈ ${(Math.PI * area.radius_km * area.radius_km).toFixed(1)} km² covered`}
          />
          <StatTile label="Centre" value={fmtCoord(area.center_lat, area.center_lng)} hint="Click the map to pan" />
          <StatTile
            label="Fetch status"
            value={
              area.fetch_status === "ok" ? "OK" : area.fetch_status === "failed" ? "Failed" : "Never fetched"
            }
            hint={area.fetch_status === "failed" ? "See the notice below" : "OpenStreetMap source data"}
          />
        </div>

        {/* Server-side ingest state (survives reloads; the button result is transient) */}
        {fetchState === "idle" && area.fetch_status === "failed" && (
          <div className="mt-4">
            <Alert kind="error">
              Last footprint fetch failed: {area.fetch_note || "unknown error"} — use the fetch
              button to retry.
            </Alert>
          </div>
        )}
        {fetchState === "idle" && area.fetch_status === "ok" && area.fetch_note && (
          <div className="mt-4">
            <Alert kind="info">{area.fetch_note}</Alert>
          </div>
        )}

        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          {/* Map + fetch actions */}
          <section>
            <AreaMap
              key={area.id}
              center={{ lat: area.center_lat, lng: area.center_lng }}
              radiusKm={area.radius_km}
              footprints={footprints ?? []}
            />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-slate-500">{overlayText}</p>
              <p className="text-xs text-slate-400">
                Footprints © OpenStreetMap contributors — source data, not model output.
              </p>
            </div>

            {fetchState === "success" && fetchMsg && (
              <div className="mt-3">
                <Alert kind="success">{fetchMsg}</Alert>
              </div>
            )}
            {fetchState === "error" && fetchMsg && (
              <div className="mt-3">
                <Alert kind="error">{fetchMsg}</Alert>
              </div>
            )}

            {canEdit ? (
              <div className="card mt-4 p-4">
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={() => void runFetch()}
                    disabled={fetchState === "running"}
                    className="btn-primary"
                  >
                    {fetchState === "running" && <Spinner />}
                    {fetchState === "running"
                      ? `Fetching footprints… ${elapsed}s`
                      : area.structures_count > 0
                        ? "Refresh footprints"
                        : "Fetch building footprints"}
                  </button>
                  <p className="text-xs text-slate-500">
                    Queries OpenStreetMap via Overpass — usually seconds, budgeted at ~1 minute.
                    {area.structures_count > 0 && " Refreshing replaces the stored footprints."}
                  </p>
                </div>
              </div>
            ) : (
              <div className="mt-4">
                <Alert kind="info">
                  {area.is_demo
                    ? "The demo area is read-only — only admins can fetch its building footprints."
                    : "Read-only access — only the area owner or an admin can fetch building footprints."}
                </Alert>
              </div>
            )}
          </section>

          {/* Climate + hazard models */}
          <aside className="space-y-4">
            <section className="card p-5">
              <h2 className="text-sm font-semibold text-slate-900">Climate &amp; hazard models</h2>
              <div className="mt-3">
                <ClimateChip value={area.climate_type} />
              </div>
              {climate && <p className="mt-2 text-sm text-slate-600">{climate.blurb}</p>}
              <div className="mt-3 flex flex-wrap gap-1.5">
                {(climate?.hazards ?? []).map((h) => (
                  <span
                    key={h}
                    className="chip bg-slate-100 text-slate-700 ring-1 ring-slate-200 ring-inset"
                  >
                    {HAZARD_LABELS[h]}
                  </span>
                ))}
              </div>
              <p className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-400">
                These hazard models feed per-structure risk scoring (Model v1 — heuristic
                estimates) once the scoring engine ships.
              </p>
            </section>
          </aside>
        </div>
        {/* Slice 4 — risk results: KPIs, risk map, distribution, sortable table,
            status/provenance, saved analyses (auto-loads the latest). */}
        <div className="mt-6">
          <ResultsPanel area={area} canRun={boot.user.role !== "viewer"} />
        </div>

      </div>
    </main>
  );
}

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</p>
      <p className="mt-1 text-xl font-bold tracking-tight text-slate-900">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}
