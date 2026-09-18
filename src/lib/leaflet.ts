/**
 * Client-only lazy loader for Leaflet.
 *
 * Leaflet touches `window`/`document` as soon as it is evaluated, so it must
 * never run during SSR. Map components obtain the library exclusively through
 * `loadLeaflet()` from inside an effect — the SSR bundle never executes it.
 * Leaflet's CSS ships in the global bundle (imported from app.css) so tiles are
 * styled on first paint.
 */
export type Leaflet = typeof import("leaflet");

let mod: Promise<Leaflet> | null = null;

export function loadLeaflet(): Promise<Leaflet> {
  mod ??= import("leaflet").then((m) => {
    // Vite interop: the CJS build exposes the L namespace both directly and as `default`.
    const withDefault = m as unknown as { default?: Leaflet };
    return withDefault.default ?? (m as Leaflet);
  });
  return mod;
}

/**
 * OpenStreetMap raster tiles. Attribution with a link is required by the OSM
 * licence/usage policy — never render tiles without it.
 */
export const OSM_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
export const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors';

export type LatLng = { lat: number; lng: number };
