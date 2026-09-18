/**
 * Area detail map (client-only): the area circle plus an optional OpenStreetMap
 * building-footprint overlay. Purely a view — writes go through explicit
 * buttons on the page, never through this component.
 */
import { useEffect, useRef, useState } from "react";
import type { LayerGroup, Map as LeafletMap } from "leaflet";
import {
  loadLeaflet,
  OSM_ATTRIBUTION,
  OSM_TILE_URL,
  type LatLng,
  type Leaflet,
} from "~/lib/leaflet";

export function AreaMap({
  center,
  radiusKm,
  footprints,
}: {
  center: LatLng;
  radiusKm: number;
  /** Simplified footprint rings; the overlay is rebuilt when this identity changes. */
  footprints: LatLng[][];
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const LRef = useRef<Leaflet | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const fpLayerRef = useRef<LayerGroup | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let disposed = false;
    void loadLeaflet().then((L) => {
      if (disposed || !containerRef.current || mapRef.current) return;
      LRef.current = L;
      const map = L.map(containerRef.current);
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
      mapRef.current = map;
      setReady(true);
    });
    // Geometry is fixed while an area page is mounted (the page remounts per
    // area id via `key`), so the one-time setup intentionally reads initial props.
    return () => {
      disposed = true;
      mapRef.current?.remove();
      mapRef.current = null;
      fpLayerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const L = LRef.current;
    const layer = fpLayerRef.current;
    if (!ready || !L || !layer) return;
    layer.clearLayers();
    for (const ring of footprints) {
      if (ring.length < 3) continue;
      L.polygon(
        ring.map((p) => [p.lat, p.lng] as [number, number]),
        { color: "#0d9488", weight: 1, opacity: 0.75, fillColor: "#14b8a6", fillOpacity: 0.3 }
      ).addTo(layer);
    }
  }, [ready, footprints]);

  return (
    <div className="relative z-0 overflow-hidden rounded-xl border border-slate-200">
      <div
        ref={containerRef}
        className="h-[360px] w-full sm:h-[460px]"
        aria-label={`Map of the area with its ${radiusKm} km radius`}
      />
      {!ready && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-slate-100 text-sm text-slate-500">
          Loading map…
        </div>
      )}
    </div>
  );
}
