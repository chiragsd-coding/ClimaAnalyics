import { useEffect, useRef, useState } from "react";
import {
  loadLeaflet,
  OSM_ATTRIBUTION,
  OSM_TILE_URL,
  type LatLng,
  type Leaflet,
} from "~/lib/leaflet";

/** Risk category → color, 1 (Very Low) → 5 (Very High). Shared with the results UI. */
export const RISK_COLORS = ["#15803d", "#65a30d", "#d97706", "#ea580c", "#dc2626"];
export const RISK_LABELS = ["1 · Very Low", "2 · Low", "3 · Medium", "4 · High", "5 · Very High"];

export type RiskPoint = { lat: number; lng: number; cat: number };

/**
 * Deterministic thinning: keeps ~maxPoints evenly spread across the input
 * (index-order independent of score ordering), so a 8.7k-row demo stays
 * responsive without ever fabricating a denser grid than the data has.
 */
function thin(points: RiskPoint[], max: number): RiskPoint[] {
  if (points.length <= max) return points;
  const seen = new Set<number>();
  const out: RiskPoint[] = [];
  for (let i = 0; i < points.length; i++) {
    const bucket = Math.floor((i * max) / points.length);
    if (!seen.has(bucket)) {
      seen.add(bucket);
      out.push(points[i]);
    }
  }
  return out;
}

export function AreaMap({
  center,
  radiusKm,
  footprints,
  points,
  maxPoints = 2000,
}: {
  center: LatLng;
  radiusKm: number;
  /** Simplified footprint rings; the overlay is rebuilt when this identity changes. */
  footprints: LatLng[][];
  /** Optional risk overlay: per-structure markers colored by risk category. */
  points?: RiskPoint[];
  /** Maximum markers to draw when points exceed it (deterministic thinning). */
  maxPoints?: number;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const LRef = useRef<Leaflet | null>(null);
  const mapRef = useRef<ReturnType<Leaflet["map"]> | null>(null);
  const fpLayerRef = useRef<ReturnType<Leaflet["layerGroup"]> | null>(null);
  const riskLayerRef = useRef<ReturnType<Leaflet["layerGroup"]> | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let disposed = false;
    void loadLeaflet()
      .then((L) => {
        if (disposed || !containerRef.current || mapRef.current) return;
        LRef.current = L;
        // Leaflet only attaches layers once the map has a view: a map created
        // without a centre/zoom stays `_loaded === false`. Seeding the view
        // from the area centre makes the layers attach synchronously;
        // `fitBounds` below then frames the radius.
        const map = L.map(containerRef.current, { center: [center.lat, center.lng], zoom: 12 });
        L.tileLayer(OSM_TILE_URL, { maxZoom: 19, attribution: OSM_ATTRIBUTION }).addTo(map);
        const circle = L.circle([center.lat, center.lng], {
          radius: radiusKm * 1000,
          color: "#0f766e",
          weight: 2,
          fillColor: "#14b8a6",
          fillOpacity: 0.08,
        }).addTo(map);
        map.fitBounds(circle.getBounds(), { padding: [24, 24] });
        fpLayerRef.current = L.layerGroup().addTo(map);
        riskLayerRef.current = L.layerGroup().addTo(map);
        mapRef.current = map;
        setReady(true);
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
      mapRef.current?.remove();
      mapRef.current = null;
      fpLayerRef.current = null;
      riskLayerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Footprint polygons (source data context, drawn under the risk layer).
  useEffect(() => {
    const L = LRef.current;
    const layer = fpLayerRef.current;
    if (!ready || !L || !layer) return;
    layer.clearLayers();
    for (const ring of footprints) {
      if (ring.length < 3) continue;
      L.polygon(
        ring.map((p) => [p.lat, p.lng] as [number, number]),
        { color: "#64748b", weight: 1, opacity: 0.6, fillColor: "#cbd5e1", fillOpacity: 0.25 }
      ).addTo(layer);
    }
  }, [ready, footprints]);

  // Risk-colored marker overlay.
  const shown = points ? thin(points, maxPoints) : [];
  useEffect(() => {
    const L = LRef.current;
    const layer = riskLayerRef.current;
    if (!ready || !L || !layer) return;
    layer.clearLayers();
    for (const p of shown) {
      const color = RISK_COLORS[Math.max(1, Math.min(5, Math.round(p.cat || 1))) - 1];
      L.circleMarker([p.lat, p.lng], {
        radius: 5,
        color: "#fff",
        weight: 1,
        fillColor: color,
        fillOpacity: 0.85,
      }).addTo(layer);
    }
  }, [ready, shown]);

  return (
    <div className="relative z-0 overflow-hidden rounded-xl border border-slate-200">
      <div
        ref={containerRef}
        className="h-[360px] w-full sm:h-[460px]"
        aria-label={`Map of the area with its ${radiusKm} km radius`}
      />
      {points && points.length > 0 && (
        <div className="absolute right-3 top-3 z-[1000] rounded-lg border border-slate-200 bg-white/95 px-3 py-2 shadow-sm">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            Risk category
          </p>
          <ul className="mt-1 space-y-0.5">
            {RISK_LABELS.map((label, i) => (
              <li key={label} className="flex items-center gap-1.5 text-[11px] text-slate-700">
                <span
                  className="h-2.5 w-2.5 rounded-full ring-1 ring-white"
                  style={{ backgroundColor: RISK_COLORS[i] }}
                />
                {label}
              </li>
            ))}
          </ul>
          {shown.length < points.length && (
            <p className="mt-1.5 border-t border-slate-100 pt-1 text-[10px] text-slate-400">
              Showing {shown.length.toLocaleString()} of {points.length.toLocaleString()} structures
              (thinned for performance)
            </p>
          )}
        </div>
      )}
      {!ready && !failed && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-slate-100 text-sm text-slate-500">
          Loading map…
        </div>
      )}
      {failed && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-slate-100 px-6 text-center text-sm text-slate-500">
          The map could not be initialised. The area coordinates, KPIs and table above are
          unaffected — reload the page to retry.
        </div>
      )}
    </div>
  );
}