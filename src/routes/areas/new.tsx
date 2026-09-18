/**
 * Slice 2 — area creation with the map picker. Admin/analyst only (viewers are
 * redirected; the server would reject them anyway). Everything here is local
 * state until "Create area" posts once to POST /api/areas, which also runs the
 * inline Overpass ingest (up to ~1 min) — the button shows progress for it.
 */
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { MapPicker } from "~/components/MapPicker";
import { Nav } from "~/components/Nav";
import { Alert, Spinner } from "~/components/ui";
import { CLIMATE_TYPES, HAZARD_LABELS } from "~/lib/climates";
import type { LatLng } from "~/lib/leaflet";
import { getSessionUserFn } from "~/lib/server/queries";

export const Route = createFileRoute("/areas/new")({
  loader: async () => {
    const { user } = await getSessionUserFn();
    if (!user) throw redirect({ to: "/login", search: { next: "/areas/new" } });
    if (user.role === "viewer") throw redirect({ to: "/dashboard" });
    return { user };
  },
  component: NewAreaPage,
});

/** Radius is clamped server-side too (DB CHECK 0.5–10); mirror it in the UI. */
function clampRadius(km: number): number {
  if (!Number.isFinite(km)) return 3;
  return Math.min(10, Math.max(0.5, Math.round(km * 2) / 2));
}

function NewAreaPage() {
  const data = Route.useLoaderData();
  const user = data.user!;
  const navigate = useNavigate();

  // Centre lives in the coordinate text fields; the map and circle derive from
  // it. One source of truth, no input/map sync bugs.
  const [latText, setLatText] = useState("");
  const [lngText, setLngText] = useState("");
  const [radiusKm, setRadiusKm] = useState(3);
  const [name, setName] = useState("");
  const [city, setCity] = useState("");
  const [country, setCountry] = useState("");
  const [climateType, setClimateType] = useState(CLIMATE_TYPES[0]!.value);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  const lat = Number.parseFloat(latText);
  const lng = Number.parseFloat(lngText);
  const center = useMemo<LatLng | null>(() => {
    if (!Number.isFinite(lat) || Math.abs(lat) > 90) return null;
    if (!Number.isFinite(lng) || Math.abs(lng) > 180) return null;
    return { lat, lng };
  }, [lat, lng]);

  // Ticker so the inline ingest (up to ~55 s server-side) never feels hung.
  useEffect(() => {
    if (!creating) return;
    const started = Date.now();
    const iv = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(iv);
  }, [creating]);

  function pick(c: LatLng) {
    setLatText(c.lat.toFixed(5));
    setLngText(c.lng.toFixed(5));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!center) {
      setError("Set the area centre — click the map or type coordinates.");
      return;
    }
    if (!name.trim()) {
      setError("Give the area a name.");
      return;
    }
    setCreating(true);
    setElapsed(0);
    try {
      const res = await fetch("/api/areas", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          city: city.trim(),
          country: country.trim(),
          center_lat: center.lat,
          center_lng: center.lng,
          radius_km: radiusKm,
          climate_type: climateType,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        area?: { id: number };
      };
      if (!res.ok || !data.area) {
        setError(data.error ?? "Could not create the area.");
        setCreating(false);
        return;
      }
      // The area exists from here on, even if the inline footprint fetch
      // failed — the detail page surfaces that with a retry button.
      await navigate({ to: "/areas/$areaId", params: { areaId: String(data.area.id) } });
    } catch {
      setError("Network error — please try again.");
      setCreating(false);
    }
  }

  const coverageKm2 = (Math.PI * radiusKm * radiusKm).toFixed(1);

  return (
    <main className="min-h-dvh bg-slate-50">
      <Nav user={{ name: user.name, role: user.role }} active="dashboard" />
      <div className="mx-auto max-w-6xl px-6 py-10">
        <p className="text-sm text-slate-500">
          <a href="/dashboard" className="hover:text-slate-900">
            ← All areas
          </a>
        </p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-900">Create an area</h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-500">
          Click the map to drop the centre (or type coordinates), set a radius between 0.5 and
          10 km, and pick the climate type — it decides which hazard models score the area.
          Building footprints are pulled live from OpenStreetMap right after the area is created.
        </p>

        <form onSubmit={submit} className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
          {/* Map + radius */}
          <div className="space-y-4">
            <MapPicker center={center} radiusKm={radiusKm} onPick={pick} />

            <div className="card p-4">
              <div className="flex flex-wrap items-end gap-4">
                <div className="min-w-48 grow">
                  <label htmlFor="radius-range" className="label">
                    Radius: <span className="font-semibold text-slate-900">{radiusKm} km</span>
                    <span className="ml-2 font-normal text-slate-400">
                      ≈ {coverageKm2} km² covered
                    </span>
                  </label>
                  <input
                    id="radius-range"
                    type="range"
                    min={0.5}
                    max={10}
                    step={0.5}
                    value={radiusKm}
                    onChange={(e) => setRadiusKm(clampRadius(Number(e.target.value)))}
                    className="w-full accent-teal-700"
                    disabled={creating}
                  />
                </div>
                <div className="w-24">
                  <label htmlFor="radius-number" className="label">
                    km
                  </label>
                  <input
                    id="radius-number"
                    type="number"
                    min={0.5}
                    max={10}
                    step={0.5}
                    value={radiusKm}
                    onChange={(e) => setRadiusKm(clampRadius(Number(e.target.value)))}
                    className="input"
                    disabled={creating}
                  />
                </div>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="lat-input" className="label">
                    Center latitude
                  </label>
                  <input
                    id="lat-input"
                    type="number"
                    step="0.00001"
                    min={-90}
                    max={90}
                    required
                    className="input"
                    placeholder="25.77430"
                    value={latText}
                    onChange={(e) => setLatText(e.target.value)}
                    disabled={creating}
                  />
                </div>
                <div>
                  <label htmlFor="lng-input" className="label">
                    Center longitude
                  </label>
                  <input
                    id="lng-input"
                    type="number"
                    step="0.00001"
                    min={-180}
                    max={180}
                    required
                    className="input"
                    placeholder="-80.19370"
                    value={lngText}
                    onChange={(e) => setLngText(e.target.value)}
                    disabled={creating}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Details */}
          <div className="space-y-4">
            <div className="card p-4">
              <div className="space-y-3">
                <div>
                  <label htmlFor="area-name" className="label">
                    Area name
                  </label>
                  <input
                    id="area-name"
                    required
                    maxLength={120}
                    className="input"
                    placeholder="Brickell portfolio"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    disabled={creating}
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="area-city" className="label">
                      City
                    </label>
                    <input
                      id="area-city"
                      maxLength={120}
                      className="input"
                      placeholder="Miami"
                      value={city}
                      onChange={(e) => setCity(e.target.value)}
                      disabled={creating}
                    />
                  </div>
                  <div>
                    <label htmlFor="area-country" className="label">
                      Country
                    </label>
                    <input
                      id="area-country"
                      maxLength={120}
                      className="input"
                      placeholder="US"
                      value={country}
                      onChange={(e) => setCountry(e.target.value)}
                      disabled={creating}
                    />
                  </div>
                </div>
              </div>
            </div>

            <fieldset className="card p-4">
              <legend className="px-1 text-sm font-semibold text-slate-900">Climate type</legend>
              <p className="mb-3 text-xs text-slate-500">
                Each climate maps to the hazard models used for scoring.
              </p>
              <div className="grid gap-2">
                {CLIMATE_TYPES.map((c) => {
                  const selected = climateType === c.value;
                  return (
                    <label
                      key={c.value}
                      className={`cursor-pointer rounded-lg border p-2.5 transition-colors ${
                        selected
                          ? "border-brand-600 bg-brand-50/60 ring-2 ring-brand-600/20"
                          : "border-slate-200 bg-white hover:border-slate-300"
                      }`}
                    >
                      <input
                        type="radio"
                        name="climate_type"
                        value={c.value}
                        checked={selected}
                        onChange={() => setClimateType(c.value)}
                        className="sr-only"
                        disabled={creating}
                      />
                      <span className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-slate-900">{c.label}</span>
                        {selected && (
                          <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0 text-brand-700" fill="currentColor" aria-hidden>
                            <path
                              fillRule="evenodd"
                              d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0L3.3 9.7a1 1 0 1 1 1.4-1.4l3.8 3.8 6.8-6.8a1 1 0 0 1 1.4 0Z"
                              clipRule="evenodd"
                            />
                          </svg>
                        )}
                      </span>
                      <span className="mt-0.5 block text-xs text-slate-500">{c.blurb}</span>
                      <span className="mt-1.5 flex flex-wrap gap-1">
                        {c.hazards.map((h) => (
                          <span
                            key={h}
                            className="chip bg-slate-100 text-slate-700 ring-1 ring-slate-200 ring-inset"
                          >
                            {HAZARD_LABELS[h]}
                          </span>
                        ))}
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>

            {error && <Alert kind="error">{error}</Alert>}

            <button type="submit" disabled={creating} className="btn-primary w-full">
              {creating && <Spinner />}
              {creating
                ? `Creating area… fetching footprints (${elapsed}s — can take up to a minute)`
                : "Create area"}
            </button>
            <p className="text-center text-xs text-slate-400">
              Creating runs a live OpenStreetMap query for building footprints; you will land on
              the new area either way.
            </p>
          </div>
        </form>
      </div>
    </main>
  );
}
