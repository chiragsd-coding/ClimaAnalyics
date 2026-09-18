/**
 * Building-footprint ingestion from the OpenStreetMap Overpass API.
 *
 * Server-only (imported by src/rest/api.ts and scripts/*). Given an area, query
 * `way["building"](around:<r_m>,lat,lng)`, simplify each footprint, and store a
 * deterministic subset into the structures table.
 *
 * Engineering care encoded here:
 *  - Overpass is best-effort: bounded deadline (default 55s), one retry when the
 *    failure was fast (network error / 429 / 5xx), never throws — callers get an
 *    IngestResult and the area stays usable without footprints.
 *  - Deterministic: results are sorted by osm_id and, when the count exceeds the
 *    cap, the first cap-many by osm_id are kept — stable across retries.
 *  - Payload hygiene: Douglas-Peucker simplification (3 m tolerance, decimated
 *    to ≤ 64 vertices), absurd vertex counts (> 512 raw points) skipped,
 *    coordinates rounded to ~1 cm, response size bounded.
 *  - Provenance: stored props keep the OSM tags the estimates derive from and
 *    are labelled as source data, not model output.
 */
import { db, type AreaRow } from "./db";

// --- tunables -----------------------------------------------------------------

/** Hard cap on stored structures per area (deterministic subset by osm_id). */
export const MAX_STRUCTURES_PER_AREA = 12000;
/** Skip raw rings with more than this many vertices (absurd / micro-mapped). */
const MAX_RAW_RING_VERTICES = 512;
/** Simplified footprints are decimated to at most this many vertices. */
const MAX_RING_VERTICES = 64;
/** Douglas-Peucker tolerance in meters. */
const SIMPLIFY_TOLERANCE_M = 3;
/** Reject Overpass payloads larger than this (bytes) — protects memory. */
const MAX_RESPONSE_BYTES = 120_000_000;
/** Default wall-clock budget for the whole ingestion (ms). */
export const DEFAULT_INGEST_BUDGET_MS = 55_000;

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const EARTH_R = 6371000;

export type IngestResult = {
  status: "ok" | "failed";
  /** Structures actually stored (after the deterministic subset). */
  count: number;
  /** How many buildings Overpass reported, when known. */
  reported: number | null;
  capped: boolean;
  /** Human-readable note — surfaced verbatim in the UI. */
  note: string;
  took_ms: number;
};

// --- geometry helpers (local equirectangular meters around the area center) ---

function toLocal(lat: number, lon: number, lat0: number, lon0: number): [number, number] {
  const rad = Math.PI / 180;
  const x = EARTH_R * rad * (lon - lon0) * Math.cos(rad * lat0);
  const y = EARTH_R * rad * (lat - lat0);
  return [x, y];
}

function perpDistance(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Iterative Douglas-Peucker on local-meter coordinates. */
function simplifyRing(pts: [number, number][], tolerance: number): [number, number][] {
  if (pts.length <= 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    let maxDist = -1;
    let idx = -1;
    for (let i = start + 1; i < end; i++) {
      const d = perpDistance(pts[i], pts[start], pts[end]);
      if (d > maxDist) {
        maxDist = d;
        idx = i;
      }
    }
    if (idx !== -1 && maxDist > tolerance) {
      keep[idx] = 1;
      stack.push([start, idx], [idx, end]);
    }
  }
  const out: [number, number][] = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

/** Shoelace area (m²) of a ring in local meters — sign-agnostic. */
function ringAreaM2(ring: [number, number][]): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return Math.abs(sum) / 2;
}

/** Polygon centroid via shoelace; falls back to the vertex average when degenerate. */
function ringCentroid(ring: [number, number][]): [number, number] {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const cross = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    a += cross;
    cx += (ring[j][0] + ring[i][0]) * cross;
    cy += (ring[j][1] + ring[i][1]) * cross;
  }
  a /= 2;
  if (Math.abs(a) < 1e-9) {
    let sx = 0;
    let sy = 0;
    for (const [x, y] of ring) {
      sx += x;
      sy += y;
    }
    return [sx / ring.length, sy / ring.length];
  }
  return [cx / (6 * a), cy / (6 * a)];
}

// --- Overpass fetch ------------------------------------------------------------

type OverpassElement = {
  type: string;
  id: number;
  tags?: Record<string, string>;
  geometry?: Array<{ lat: number; lon: number }>;
};

async function queryOverpass(
  lat: number,
  lng: number,
  radiusM: number,
  deadlineAt: number
): Promise<{ elements: OverpassElement[] }> {
  const q =
    `[out:json][timeout:50];` +
    `way["building"](around:${Math.round(radiusM)},${lat.toFixed(6)},${lng.toFixed(6)});` +
    `out geom;`;

  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const remaining = deadlineAt - Date.now();
    if (remaining < 3_000) {
      throw new Error(
        `Overpass did not answer within the ${Math.round(DEFAULT_INGEST_BUDGET_MS / 1000)}s budget.`
      );
    }
    const signal = AbortSignal.timeout(Math.min(remaining, 52_000));
    const attemptStart = Date.now();
    try {
      const res = await fetch(OVERPASS_URL, {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          // Overpass politely asks clients to identify themselves.
          "User-Agent": "ClimaScope/0.1 (building-footprint ingestion; demo platform)",
        },
        body: new URLSearchParams({ data: q }).toString(),
      });
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`Overpass responded ${res.status} (busy) — try again shortly.`);
      }
      if (!res.ok) throw new Error(`Overpass responded ${res.status}.`);
      const len = Number(res.headers.get("content-length") ?? "0");
      if (len > MAX_RESPONSE_BYTES) {
        throw new Error(`Overpass payload too large (${Math.round(len / 1e6)} MB).`);
      }
      const text = await res.text();
      if (text.length > MAX_RESPONSE_BYTES) throw new Error("Overpass payload too large.");
      const parsed = JSON.parse(text) as { elements?: OverpassElement[] };
      if (!Array.isArray(parsed.elements)) throw new Error("Unexpected Overpass response shape.");
      return { elements: parsed.elements };
    } catch (err) {
      lastErr = err;
      // Retry once only when it failed fast (busy / network blip); a slow
      // timeout has already consumed the budget.
      if (attempt === 1 && Date.now() - attemptStart < 10_000) continue;
      break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Overpass request failed.");
}

// --- ingestion ------------------------------------------------------------------

function parseLevels(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n < 0 || n > 200) return null;
  return Math.round(n);
}

/**
 * Fetch + store footprints for an area. Never throws; updates the area's
 * fetch_status / fetch_note / fetched_at either way. Replaces previous
 * structures for the area (delete + insert in one transaction).
 */
export async function ingestStructuresForArea(
  area: Pick<AreaRow, "id" | "center_lat" | "center_lng" | "radius_km">,
  opts: { budgetMs?: number } = {}
): Promise<IngestResult> {
  const started = Date.now();
  const budgetMs = opts.budgetMs ?? DEFAULT_INGEST_BUDGET_MS;
  const deadlineAt = started + budgetMs;

  let elements: OverpassElement[];
  try {
    ({ elements } = await queryOverpass(
      area.center_lat,
      area.center_lng,
      area.radius_km * 1000,
      deadlineAt
    ));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown Overpass error.";
    const note = `Building-footprint fetch failed: ${msg} The area was saved — use “Fetch building footprints” to retry.`;
    db.run("UPDATE areas SET fetch_status = 'failed', fetch_note = ?, fetched_at = ? WHERE id = ?", [
      msg,
      new Date().toISOString(),
      area.id,
    ]);
    return { status: "failed", count: 0, reported: null, capped: false, note, took_ms: Date.now() - started };
  }

  const lat0 = area.center_lat;
  const lon0 = area.center_lng;
  const latMPerRad = EARTH_R * (Math.PI / 180); // meters per radian of latitude
  const lngMPerRad = latMPerRad * Math.cos(lat0 * (Math.PI / 180));

  type Prepared = {
    osmId: string;
    osmNum: number;
    centroid: [number, number]; // [lat, lon]
    footprint: [number, number][]; // [lat, lon], simplified
    areaM2: number;
    levels: number | null;
    building: string;
    name: string | null;
  };

  const prepared: Prepared[] = [];
  let skippedComplex = 0;
  for (const el of elements) {
    if (el.type !== "way" || !Array.isArray(el.geometry) || el.geometry.length < 4) continue;
    if (el.geometry.length > MAX_RAW_RING_VERTICES) {
      skippedComplex++;
      continue;
    }
    const local = el.geometry.map((p) => toLocal(p.lat, p.lon, lat0, lon0));
    const simplified = simplifyRing(local, SIMPLIFY_TOLERANCE_M);
    let ring = simplified;
    if (ring.length > MAX_RING_VERTICES) {
      // Deterministic decimation: every Nth vertex, always keeping the last.
      const step = Math.ceil(ring.length / MAX_RING_VERTICES);
      const decimated: [number, number][] = [];
      for (let i = 0; i < ring.length; i += step) decimated.push(ring[i]);
      if (decimated[decimated.length - 1] !== ring[ring.length - 1]) {
        decimated[decimated.length - 1] = ring[ring.length - 1];
      }
      ring = decimated;
    }
    const areaM2 = ringAreaM2(ring);
    if (areaM2 < 1) continue; // slivers / degenerate rings
    const [cx, cy] = ringCentroid(ring);
    const toLat = (y: number): number => +(lat0 + y / latMPerRad).toFixed(6);
    const toLng = (x: number): number => +(lon0 + x / lngMPerRad).toFixed(6);
    const tags = el.tags ?? {};
    prepared.push({
      osmId: `way/${el.id}`,
      osmNum: el.id,
      centroid: [toLat(cy), toLng(cx)],
      footprint: ring.map(([y, x]) => [toLat(y), toLng(x)] as [number, number]),
      areaM2,
      levels: parseLevels(tags["building:levels"] ?? tags["levels"] ?? tags["roof:levels"]),
      building: tags.building ?? "yes",
      name: tags.name ?? null,
    });
  }

  // Deterministic ordering + subset: ascending osm numeric id.
  prepared.sort((a, b) => a.osmNum - b.osmNum);
  const capped = prepared.length > MAX_STRUCTURES_PER_AREA;
  const kept = capped ? prepared.slice(0, MAX_STRUCTURES_PER_AREA) : prepared;

  const insert = db.prepare(
    `INSERT OR IGNORE INTO structures (area_id, osm_id, centroid_lat, centroid_lon, footprint, props)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const now = new Date().toISOString();

  db.run("BEGIN");
  try {
    db.run("DELETE FROM structures WHERE area_id = ?", [area.id]);
    for (const s of kept) {
      const props: Record<string, unknown> = {
        area_m2: Math.round(s.areaM2),
        levels: s.levels,
        building: s.building,
        source: "OpenStreetMap via Overpass API",
      };
      if (s.name) props.name = s.name;
      insert.run(
        area.id,
        s.osmId,
        s.centroid[0],
        s.centroid[1],
        JSON.stringify(s.footprint),
        JSON.stringify(props)
      );
    }
    const note = capped
      ? `Overpass returned ${prepared.length.toLocaleString()} buildings; stored the first ${kept.length.toLocaleString()} by osm_id (deterministic cap for this slice).`
      : "";
    db.run(`UPDATE areas SET fetch_status = 'ok', fetch_note = ?, fetched_at = ? WHERE id = ?`, [
      note,
      now,
      area.id,
    ]);
    db.run("COMMIT");
    return {
      status: "ok",
      count: kept.length,
      reported: prepared.length + skippedComplex,
      capped,
      note: note || `Loaded ${kept.length.toLocaleString()} building footprints from OpenStreetMap.`,
      took_ms: Date.now() - started,
    };
  } catch (err) {
    db.run("ROLLBACK");
    const msg = err instanceof Error ? err.message : "Failed to store footprints.";
    db.run("UPDATE areas SET fetch_status = 'failed', fetch_note = ?, fetched_at = ? WHERE id = ?", [
      msg,
      now,
      area.id,
    ]);
    return {
      status: "failed",
      count: 0,
      reported: null,
      capped: false,
      note: `Could not store footprints: ${msg}`,
      took_ms: Date.now() - started,
    };
  }
}
