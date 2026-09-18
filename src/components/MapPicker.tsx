/**
 * Area-creation map (client-only). Click anywhere to set the centre; the radius
 * circle preview follows the form state. Strictly local: no API traffic while
 * picking — the Overpass ingest happens once, when the form is submitted.
 */
import { useEffect, useRef, useState } from "react";
import type { Circle, CircleMarker, Map as LeafletMap } from "leaflet";
import {
  loadLeaflet,
  OSM_ATTRIBUTION,
  OSM_TILE_URL,
  type LatLng,
  type Leaflet,
} from "~/lib/leaflet";

/** Initial view: the Downtown Miami demo area, a recognisable starting point. */
const DEFAULT_VIEW: [number, number] = [25.7743, -80.1937];

export function MapPicker({
  center,
  radiusKm,
  onPick,
}: {
  center: LatLng | null;
  radiusKm: number;
  onPick: (c: LatLng) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const LRef = useRef<Leaflet | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const circleRef = useRef<Circle | null>(null);
  const markerRef = useRef<CircleMarker | null>(null);
  const onPickRef = useRef(onPick);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    onPickRef.current = onPick;
  }, [onPick]);

  useEffect(() => {
    let disposed = false;
    void loadLeaflet().then((L) => {
      if (disposed || !containerRef.current || mapRef.current) return;
      LRef.current = L;
      const map = L.map(containerRef.current, { center: DEFAULT_VIEW, zoom: 12 });
      L.tileLayer(OSM_TILE_URL, { maxZoom: 19, attribution: OSM_ATTRIBUTION }).addTo(map);
      map.on("click", (e) => onPickRef.current({ lat: e.latlng.lat, lng: e.latlng.lng }));
      mapRef.current = map;
      setReady(true);
    });
    return () => {
      disposed = true;
      mapRef.current?.remove();
      mapRef.current = null;
      circleRef.current = null;
      markerRef.current = null;
    };
  }, []);

  // Keep the circle + centre marker (and viewport) in sync with the form state.
  useEffect(() => {
    const L = LRef.current;
    const map = mapRef.current;
    if (!ready || !L || !map || !center) return;
    const ll: [number, number] = [center.lat, center.lng];
    if (!circleRef.current) {
      circleRef.current = L.circle(ll, {
        radius: radiusKm * 1000,
        color: "#0f766e",
        weight: 2,
        fillColor: "#14b8a6",
        fillOpacity: 0.1,
      }).addTo(map);
      markerRef.current = L.circleMarker(ll, {
        radius: 6,
        color: "#0f766e",
        weight: 2,
        fillColor: "#ffffff",
        fillOpacity: 1,
      }).addTo(map);
    } else {
      circleRef.current.setLatLng(ll);
      circleRef.current.setRadius(radiusKm * 1000);
      markerRef.current?.setLatLng(ll);
    }
    map.setView(ll, Math.max(map.getZoom(), 11));
  }, [ready, center, radiusKm]);

  return (
    <div className="relative z-0 overflow-hidden rounded-xl border border-slate-200">
      <div
        ref={containerRef}
        className="h-[340px] w-full sm:h-[430px]"
        aria-label="Area picker map — click to set the area centre"
      />
      {!ready && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-slate-100 text-sm text-slate-500">
          Loading map…
        </div>
      )}
      {ready && !center && (
        <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center">
          <span className="rounded-full bg-white/95 px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm ring-1 ring-slate-200">
            Click the map to set the area centre
          </span>
        </div>
      )}
    </div>
  );
}
