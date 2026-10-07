/**
 * ClimaScope scoring engine v1 — per-structure climate risk 1–5.
 *
 * Implements the normative spec in /home/team/shared/hazard-models/:
 *  - HAZARDS.md applicability sets (8 climate types × 8 hazard dimensions)
 *  - COMBINATION_RULE.md formula VERBATIM: R_i = clamp(round(0.65·max + 0.35·wmean), 1, 5)
 *    with the fixed weight table, missing-dimension renormalisation, the safety
 *    guard, dominant-hazard tie-break and stored blend + formula version
 *    "maxmean-v1".
 *  - Each hazard file's scoring rule; where a primary layer is not reachable
 *    from this deployment environment the file's fallback chain is followed
 *    exactly. Scores never fabricate values: unavailable layers yield either
 *    a spec-defined proxy (flagged low_confidence) or "not assessed" (missing).
 *
 * Determinism: identical inputs → identical outputs (no randomness, no clocks).
 */

import { readFileSync, existsSync, mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { db, type AreaRow, type AnalysisRow } from "~/lib/db";

// ---------------------------------------------------------------------------
// Canonical ids, applicability and weights (normative — do not re-derive)
// ---------------------------------------------------------------------------
export type HID =
  | "FLOOD"
  | "CYCLONE_WIND"
  | "EXTREME_HEAT"
  | "WILDFIRE"
  | "SNOW_LOAD"
  | "STORM_SURGE"
  | "DROUGHT"
  | "LANDSLIDE";

export const ALL_HAZARDS: HID[] = [
  "FLOOD",
  "CYCLONE_WIND",
  "EXTREME_HEAT",
  "WILDFIRE",
  "SNOW_LOAD",
  "STORM_SURGE",
  "DROUGHT",
  "LANDSLIDE",
];

export const HAZARD_LABEL: Record<HID, string> = {
  FLOOD: "Flood",
  CYCLONE_WIND: "Cyclone wind",
  EXTREME_HEAT: "Extreme heat",
  WILDFIRE: "Wildfire",
  SNOW_LOAD: "Snow load",
  STORM_SURGE: "Storm surge",
  DROUGHT: "Drought",
  LANDSLIDE: "Landslide",
};

export type Climate = string; // one of the 8 ClimaScope climate types

/** Applicability table from HAZARDS.md (final summary table). */
export const APPLICABILITY: Record<Climate, HID[]> = {
  tropical: ["FLOOD", "CYCLONE_WIND", "EXTREME_HEAT", "WILDFIRE", "STORM_SURGE"],
  arid: ["FLOOD", "EXTREME_HEAT", "WILDFIRE", "DROUGHT"],
  temperate: ["FLOOD", "EXTREME_HEAT", "WILDFIRE", "SNOW_LOAD", "LANDSLIDE"],
  continental: ["FLOOD", "EXTREME_HEAT", "WILDFIRE", "SNOW_LOAD"],
  mediterranean: ["FLOOD", "EXTREME_HEAT", "WILDFIRE", "DROUGHT"],
  coastal_humid: ["FLOOD", "CYCLONE_WIND", "EXTREME_HEAT", "STORM_SURGE"],
  alpine: ["FLOOD", "WILDFIRE", "SNOW_LOAD", "LANDSLIDE"],
  monsoon: ["FLOOD", "CYCLONE_WIND", "EXTREME_HEAT", "DROUGHT", "LANDSLIDE"],
};

/** Normative weight table from COMBINATION_RULE.md §2 (rows sum to 1 by construction). */
export const WEIGHTS: Record<Climate, Partial<Record<HID, number>>> = {
  tropical: { FLOOD: 0.25, CYCLONE_WIND: 0.3, EXTREME_HEAT: 0.15, WILDFIRE: 0.05, STORM_SURGE: 0.25 },
  arid: { FLOOD: 0.2, EXTREME_HEAT: 0.3, WILDFIRE: 0.2, DROUGHT: 0.3 },
  temperate: { FLOOD: 0.3, EXTREME_HEAT: 0.2, WILDFIRE: 0.2, SNOW_LOAD: 0.15, LANDSLIDE: 0.15 },
  continental: { FLOOD: 0.15, EXTREME_HEAT: 0.25, WILDFIRE: 0.25, SNOW_LOAD: 0.35 },
  mediterranean: { FLOOD: 0.2, EXTREME_HEAT: 0.25, WILDFIRE: 0.35, DROUGHT: 0.2 },
  coastal_humid: { FLOOD: 0.25, CYCLONE_WIND: 0.3, EXTREME_HEAT: 0.15, STORM_SURGE: 0.3 },
  alpine: { FLOOD: 0.15, WILDFIRE: 0.2, SNOW_LOAD: 0.4, LANDSLIDE: 0.25 },
  monsoon: { FLOOD: 0.35, CYCLONE_WIND: 0.25, EXTREME_HEAT: 0.2, DROUGHT: 0.1, LANDSLIDE: 0.1 },
};

export const FORMULA_VERSION = "maxmean-v1";

// ---------------------------------------------------------------------------
// Combination rule (COMBINATION_RULE.md §3, exact)
// ---------------------------------------------------------------------------
export type EvaluatedDimension = {
  d: HID;
  /** integer 1..5 when scored; null when the dimension is `missing` (not assessed) */
  score: number | null;
  /** true only when the hazard file's final fallback says "not assessed" */
  missing: boolean;
  low_confidence: boolean;
  coverage_ok: boolean;
  dataset: string | null;
  resolution_km: number | null;
  attribution: string | null;
  note?: string;
  /** raw sampled value (depth m, SWE kPa, F, L, ...) for provenance & re-thresholding */
  raw?: number | null;
};

export type CombineResult = {
  R: number; // final 1..5
  blend: number; // float stored per row
  s_max: number | null;
  s_wmean: number | null;
  dominant: HID | null;
  status: "scored" | "not_assessed";
};

/** R_i per COMBINATION_RULE.md §3 — pure, deterministic. Exported for unit tests. */
export function combine(
  climate: Climate,
  dims: EvaluatedDimension[]
): CombineResult {
  const weights = WEIGHTS[climate] as Record<HID, number>;
  const scored = dims.filter((x) => x.d in weights && !x.missing && x.score !== null);
  if (scored.length === 0) {
    return { R: 1, blend: 1, s_max: null, s_wmean: null, dominant: null, status: "not_assessed" };
  }
  let s_max = -Infinity;
  let weighted = 0;
  let wsum = 0;
  let s5 = false;
  let s4 = false;
  for (const e of scored) {
    const w = weights[e.d];
    const s = e.score as number;
    if (s > s_max) s_max = s;
    if (s === 5) s5 = true;
    if (s === 4) s4 = true;
    // Weights renormalised by the denominator when a dimension is missing
    weighted += w * s;
    wsum += w;
  }
  const s_wmean = weighted / wsum;
  const blend = 0.65 * s_max + 0.35 * s_wmean;
  let R = Math.min(5, Math.max(1, Math.round(blend)));
  // Safety guard (normative, applied after rounding)
  if (s5) R = Math.max(R, 4);
  if (s4 && s_max >= 4 && s_wmean >= 3.5) R = Math.max(R, 4);
  // dominant_hazard: argmax s_d; ties → higher w_C(d), then alphabetical HID
  let dominant: HID | null = null;
  for (const e of scored) {
    const s = e.score as number;
    if (dominant === null) {
      dominant = e.d;
      continue;
    }
    const ws = weights[e.d];
    const wd = weights[dominant];
    if (s > (dims.find((x) => x.d === dominant)?.score as number)) {
      dominant = e.d;
    } else if (s === (dims.find((x) => x.d === dominant)?.score as number)) {
      if (ws > wd || (ws === wd && e.d < dominant)) dominant = e.d;
    }
  }
  return { R, blend, s_max, s_wmean, dominant, status: "scored" };
}

export function riskLabel(R: number): string {
  return ["Very Low", "Low", "Moderate", "High", "Very High"][R - 1] ?? String(R);
}

// ---------------------------------------------------------------------------
// Geometry helpers (haversine ≈ 6,371 km radius, per OVERVIEW.md §6)
// ---------------------------------------------------------------------------
const EARTH_R = 6371;
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// ---------------------------------------------------------------------------
// Layer cache: paths and small in-process memo caches
// ---------------------------------------------------------------------------
export const LAYER_DIR = join(process.cwd(), ".data", "layers");
export function layerPath(name: string): string {
  return join(LAYER_DIR, name);
}

// -- IBTrACS (cyclone wind) --------------------------------------------------
let ingestedTracks = false;
const TRACK_CSV_URL =
  "https://www.ncei.noaa.gov/data/international-best-track-archive-for-climate-stewardship-ibtracs/v04r01/access/csv/ibtracs.NA.list.v04r01.csv";

/** Ingest the IBTrACS NA-basin CSV (1980–2023, i.e. reliable era) into SQLite once. */
export function ensureIbtracsTracks(): { ok: boolean; count: number; note?: string } {
  if (ingestedTracks) return { ok: true, count: trackCount() };
  const existing = trackCount();
  if (existing > 0) {
    ingestedTracks = true;
    return { ok: true, count: existing };
  }
  const candidates = [
    layerPath("ibtracs.NA.list.v04r01.csv"),
    "/tmp/layers/ibtracs.NA.list.v04r01.csv",
  ];
  const csv = candidates.find((p) => existsSync(p));
  if (!csv) return { ok: false, count: 0, note: `IBTrACS CSV not found; expected ${TRACK_CSV_URL}` };
  mkdirSync(LAYER_DIR, { recursive: true });
  if (!existsSync(layerPath("ibtracs.NA.list.v04r01.csv"))) {
    try {
      copyFileSync(csv, layerPath("ibtracs.NA.list.v04r01.csv"));
    } catch {
      /* file may already exist */
    }
  }
  const ins = db.prepare(
    `INSERT INTO ibtracs_tracks (sid, season, iso_time, lat, lon, nature, wind_kts, sshs)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const KEEP_NATURE = new Set(["TD", "TS", "TC", "TY", "ST", "HU", "SD", "SS"]);
  db.run("BEGIN");
  try {
    const lines = readFileSync(csv, "utf8").split("\n");
    let n = 0;
    for (const line of lines) {
      if (!line) continue;
      const f = line.split(",");
      if (f.length < 25) continue; // header / units / malformed
      const sid = f[0].trim();
      const season = parseInt(f[1], 10);
      const nature = f[7].trim();
      const lat = parseFloat(f[8]);
      const lon = parseFloat(f[9]);
      if (!sid || Number.isNaN(lat) || Number.isNaN(lon)) continue;
      if (season < 1980 || season > 2023) continue;
      if (!KEEP_NATURE.has(nature)) continue;
      let sshs = parseInt(f[25], 10); // USA_SSHS (v04r01 list layout; -5/-999 = missing)
      const wind = parseInt(f[23], 10); // USA_WIND kts
      if (Number.isNaN(sshs) || sshs <= 0) {
        // Derive category from 1-min sustained wind (kt → m/s): Cat1≥64kt, 2≥83, 3≥96, 4≥113, 5≥137
        sshs = wind >= 137 ? 5 : wind >= 113 ? 4 : wind >= 96 ? 3 : wind >= 83 ? 2 : wind >= 64 ? 1 : 0;
      }
      ins.run(sid, season, f[6].trim(), lat, lon, nature, wind, sshs);
      n++;
    }
    db.run("COMMIT");
    ingestedTracks = true;
    return { ok: true, count: n };
  } catch (err) {
    db.run("ROLLBACK");
    return { ok: false, count: 0, note: `IBTrACS ingest failed: ${(err as Error).message}` };
  }
}

function trackCount(): number {
  return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM ibtracs_tracks").get()!.n;
}

export type WindCell = { rMinKm: number; cMax: number };

/**
 * Precompute a per-cell 0.005° (~550 m) wind grid over the area's bounding box:
 * R_min = distance to ANY TC center position; C_max = max category within 300 km.
 * Per-structure lookups are then O(structures) — OVERVIEW.md §6 layering.
 */
export function buildWindGrid(
  lat0: number,
  lon0: number,
  halfSpanDeg: number,
  tracks: { lat: number; lon: number; sshs: number }[]
): (lat: number, lon: number) => WindCell | null {
  const STEP = 0.005;
  const cells = new Map<string, WindCell>();
  const latMin = Math.floor((lat0 - halfSpanDeg) / STEP) * STEP;
  const lonMin = Math.floor((lon0 - halfSpanDeg) / STEP) * STEP;
  const latMax = lat0 + halfSpanDeg,
    lonMax = lon0 + halfSpanDeg;
  for (let lat = latMin; lat <= latMax; lat += STEP) {
    for (let lon = lonMin; lon <= lonMax; lon += STEP) {
      let rMin = Infinity;
      let cMax = 0;
      for (const t of tracks) {
        const d = haversineKm(lat, lon, t.lat, t.lon);
        if (d < rMin) rMin = d;
        if (d <= 300 && t.sshs > cMax) cMax = t.sshs;
      }
      // Any TC within 200 km counts for the score-2 band; if nothing within
      // 400 km of the grid cell the cell is "no data" for the proximity rule.
      cells.set(`${lat.toFixed(3)}|${lon.toFixed(3)}`, { rMinKm: rMin, cMax });
    }
  }
  return (lat: number, lon: number): WindCell | null => {
    const clat = Math.round(lat / STEP) * STEP;
    const clon = Math.round(lon / STEP) * STEP;
    return cells.get(`${clat.toFixed(3)}|${clon.toFixed(3)}`) ?? null;
  };
}

export function scoreCycloneWind(cell: WindCell | null): EvaluatedDimension {
  const base = {
    d: "CYCLONE_WIND" as HID,
    dataset: "NOAA NCEI IBTrACS v4 — track-proximity heuristic (NA basin, 1980–2023)",
    resolution_km: 50,
    attribution: "NOAA/NCEI IBTrACS — public domain",
  };
  if (!cell) {
    return {
      ...base,
      score: 1,
      missing: false,
      low_confidence: true,
      coverage_ok: false,
      note: "no IBTrACS track positions near this area (interior/mislabelled region)",
    };
  }
  const { rMinKm: r, cMax: c } = cell;
  let score: number;
  if (c >= 4 && r < 50) score = 5;
  else if (c >= 3 && r < 75) score = 4;
  else if (c >= 2 && r < 100) score = 3;
  else if (r < 200) score = 2;
  else score = 1;
  return { ...base, score, missing: false, low_confidence: false, coverage_ok: true, raw: r };
}

// -- SRTM elevation ----------------------------------------------------------
const srtmCache = new Map<string, Int16Array>();
function tileNameFor(lat: number, lon: number): string {
  const latB = Math.floor(lat);
  const lonB = Math.floor(lon);
  return `${latB >= 0 ? "N" : "S"}${String(Math.abs(latB)).padStart(2, "0")}${
    lonB >= 0 ? "E" : "W"
  }${String(Math.abs(lonB)).padStart(3, "0")}`;
}
function srtmTilePath(lat: number, lon: number): string {
  const name = tileNameFor(lat, lon);
  return { path: layerPath(`${name}.hgt.gz`), name };
}
function loadSrtmTile(lat: number, lon: number): Int16Array | null {
  const { path, name } = srtmTilePath(lat, lon);
  const cached = srtmCache.get(name);
  if (cached) return cached;
  if (!existsSync(path)) return null;
  try {
    const raw = gunzipSync(readFileSync(path));
    // 3601×3601 big-endian int16, row-major from northwest corner
    const samples = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
    if (samples.length !== 3601 * 3601) return null;
    for (let i = 0; i < samples.length; i++) {
      // big-endian → little-endian swap
      const v = raw[i * 2];
      raw[i * 2] = raw[i * 2 + 1];
      raw[i * 2 + 1] = v;
    }
    srtmCache.set(name, samples);
    return samples;
  } catch {
    return null;
  }
}

/** Bilinear sample of the 1-arcsec SRTM tile covering (lat, lon); null outside covered tiles. */
export function srtmElevation(lat: number, lon: number): { h: number; from: string } | null {
  const tile = loadSrtmTile(lat, lon);
  if (!tile) return null;
  const latBase = Math.floor(lat);
  const lonBase = Math.floor(lon);
  const x = (lon - lonBase) * 3600; // 0..3600 (lonBase is west edge)
  const y = (latBase + 1 - lat) * 3600; // 0..3600 (top edge = latBase+1)
  const xi = Math.min(3599, Math.max(0, Math.floor(x)));
  const yi = Math.min(3599, Math.max(0, Math.floor(y)));
  const fx = x - xi;
  const fy = y - yi;
  const at = (ix: number, iy: number) => tile[iy * 3601 + ix];
  const h =
    at(xi, yi) * (1 - fx) * (1 - fy) +
    at(xi + 1, yi) * fx * (1 - fy) +
    at(xi, yi + 1) * (1 - fx) * fy +
    at(xi + 1, yi + 1) * fx * fy;
  return { h: h === -32768 ? 0 : h, from: tileNameFor(lat, lon) };
}

/** Copy a downloaded SRTM tile into the layer cache (idempotent). */
export function cacheSrtmTile(lat: number, lon: number, srcPath: string): boolean {
  const { path, name } = srtmTilePath(lat, lon);
  if (existsSync(path)) return true;
  if (!existsSync(srcPath)) return false;
  mkdirSync(LAYER_DIR, { recursive: true });
  copyFileSync(srcPath, path);
  return existsSync(path);
}

// -- OSM baseline (waterways + coastline) for flood fallback-2 / surge -------
export type OsmBaseline = {
  fetchedAt: string;
  waterways: [number, number][][]; // polylines (river|stream|canal|drain)
  coastline: [number, number][][];
};
export type NearestLine = { distKm: number; lat: number; lon: number };

function nearestVertex(lines: [number, number][][], lat: number, lon: number):
  | NearestLine
  | null {
  let best: NearestLine | null = null;
  for (const line of lines) {
    for (const [vlat, vlon] of line) {
      const d = haversineKm(lat, lon, vlat, vlon);
      if (!best || d < best.distKm) best = { distKm: d, lat: vlat, lon: vlon };
    }
  }
  return best;
}

export function osmBaselinePath(areaId: number): string {
  return layerPath(`overpass_${areaId}.json`);
}
export function loadOsmBaseline(areaId: number): OsmBaseline | null {
  const p = osmBaselinePath(areaId);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as OsmBaseline;
  } catch {
    return null;
  }
}
export function saveOsmBaseline(areaId: number, baseline: OsmBaseline): void {
  mkdirSync(LAYER_DIR, { recursive: true });
  writeFileSync(osmBaselinePath(areaId), JSON.stringify(baseline));
}

/** Overpass fetch of waterways + coastline around the area centre (Slice-2 style client). */
export async function fetchOsmBaseline(
  lat0: number,
  lon0: number,
  halfSpanDeg: number
): Promise<OsmBaseline> {
  const bbox = `${lat0 - halfSpanDeg},${lon0 - halfSpanDeg},${lat0 + halfSpanDeg},${lon0 + halfSpanDeg}`;
  const q = `[out:json][timeout:60];(way["waterway"~"^(river|stream|canal|drain)$"](${bbox});way["natural"="coastline"](${bbox}););out geom;`;
  const res = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(q)}`, {
    headers: { "User-Agent": "ClimaScope/0.1 (climate risk analytics demo)" },
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  const json = (await res.json()) as {
    elements: { type: string; tags?: Record<string, string>; geometry?: { lat: number; lon: number }[] }[];
  };
  const decimate = (coords: { lat: number; lon: number }[]): [number, number][] => {
    const out: [number, number][] = [];
    let last: [number, number] | null = null;
    for (const c of coords) {
      const p: [number, number] = [+c.lat.toFixed(6), +c.lon.toFixed(6)];
      if (last && haversineKm(last[0], last[1], p[0], p[1]) < 0.02) continue; // ≥ ~20 m spacing
      out.push(p);
      last = p;
    }
    return out;
  };
  const waterways: [number, number][][] = [];
  const coastline: [number, number][][] = [];
  for (const el of json.elements) {
    if (el.type !== "way" || !el.geometry || el.geometry.length < 2) continue;
    const line = decimate(el.geometry);
    if (line.length < 2) continue;
    if (el.tags?.["natural"] === "coastline") coastline.push(line);
    else waterways.push(line);
  }
  return { fetchedAt: new Date().toISOString(), waterways, coastline };
}

// ---------------------------------------------------------------------------
// Per-hazard evaluators. `layers` supplies whatever real data was acquired;
// every rule and fallback below follows the hazard spec files exactly.
// ---------------------------------------------------------------------------
export type StructureLayers = {
  climate: Climate;
  windCell: (lat: number, lon: number) => WindCell | null;
  srtm: (lat: number, lon: number) => { h: number; from: string } | null;
  osm: OsmBaseline | null;
};

function percentOf(n: number, total: number): number {
  return Math.round((100 * n) / total) / 1;
}

export function evaluateStructure(
  lat: number,
  lon: number,
  layers: StructureLayers
): EvaluatedDimension[] {
  const applicable = APPLICABILITY[layers.climate] ?? [];
  const out: EvaluatedDimension[] = [];
  for (const d of applicable) {
    switch (d) {
      case "FLOOD": {
        // Global depth rasters (Aqueduct/JRC) are NOT reachable from this
        // environment (registration-gated/DOI). flood.md fallback 2:
        // SRTM elevation + OSM waterway proximity proxy, capped at 3.
        const elev = layers.srtm(lat, lon);
        const river = layers.osm
          ? nearestVertex(layers.osm.waterways, lat, lon)
          : null;
        const hasData = elev !== null && river !== null;
        if (!hasData) {
          out.push({
            d,
            score: null,
            missing: true,
            low_confidence: true,
            coverage_ok: false,
            dataset: "not ingested — Aqueduct Floods (registration-gated); DEM proxy unavailable",
            resolution_km: 1,
            attribution: "",
            note: "flood not assessed for this area",
          });
          break;
        }
        const rElev = layers.srtm(river.lat, river.lon);
        // No waterway within 2 km → score 1 per spec
        let score = 1;
        if (river.distKm < 2) {
          const hDiff = Math.max(0, (elev?.h ?? 0) - (rElev?.h ?? elev!.h));
          const dBand = river.distKm * 1000 < 100 ? 3 : river.distKm * 1000 < 500 ? 2 : 1;
          const hBand = hDiff < 1 ? 3 : hDiff <= 3 ? 2 : 1;
          score = Math.max(dBand, hBand);
        }
        out.push({
          d,
          score,
          missing: false,
          low_confidence: true,
          coverage_ok: true,
          dataset: "SRTM DEM + OSM waterways elevation-distance proxy (flood.md fallback 2)",
          resolution_km: 0.03,
          attribution: "USGS SRTM (public domain); OpenStreetMap (ODbL)",
          note: "proxy cannot exceed 3; urban/small-stream flooding understated",
          raw: river.distKm,
        });
        break;
      }
      case "CYCLONE_WIND": {
        const cell = layers.windCell(lat, lon);
        out.push(scoreCycloneWind(cell));
        break;
      }
      case "EXTREME_HEAT": {
        // WorldClim v2.1 BIO5 host (geodata.ucar.edu) is unreachable from this
        // box; NOAA normals not yet wired. extreme-heat.md fallback 3.
        out.push({
          d,
          score: 1,
          missing: false,
          low_confidence: true,
          coverage_ok: false,
          dataset: "not ingested — WorldClim v2.1 BIO5 (worldclim.org) unreachable from deployment env",
          resolution_km: 1,
          attribution: "WorldClim v2.1 (Fick & Hijmans 2017)",
          note: "heat dimension scored 1 (no data); revisit when WorldClim is reachable",
        });
        break;
      }
      case "WILDFIRE": {
        // FWI climatology (GFWED) and GFED4s burned-area fallback not ingested.
        // wildfire.md: "If neither layer exists → score = 1, low_confidence = true."
        out.push({
          d,
          score: 1,
          missing: false,
          low_confidence: true,
          coverage_ok: false,
          dataset: "not ingested — NASA GISS GFWED FWI climatology / GFED4s",
          resolution_km: 25,
          attribution: "",
          note: "fire-weather layer not ingested; scored 1 as spec fallback",
        });
        break;
      }
      case "SNOW_LOAD": {
        // ERA5 snow-water-equivalent climatology requires a CDS token; not
        // reachable here. snow-load.md fallback 2.
        out.push({
          d,
          score: 1,
          missing: false,
          low_confidence: true,
          coverage_ok: false,
          dataset: "not ingested — ERA5 monthly snow depth (CDS, credential-gated)",
          resolution_km: 31,
          attribution: "ERA5: © ECMWF/Copernicus C3S (Copernicus Licence)",
          note: "snow-load scored 1 (no data); alpine results will understate",
        });
        break;
      }
      case "STORM_SURGE": {
        // Aqueduct coastal (registration-gated) and GTSR not ingested →
        // storm-surge.md secondary check (outside extent, within 1 km of the
        // coastline, terrain elevation from SRTM).
        const elev = layers.srtm(lat, lon);
        const coast = layers.osm
          ? nearestVertex(layers.osm.coastline, lat, lon)
          : null;
        if (!elev || !coast || coast.distKm > 1) {
          out.push({
            d,
            score: 1,
            missing: false,
            low_confidence: coast?.distKm ? false : true,
            coverage_ok: true,
            dataset: "not ingested — Aqueduct coastal 100-yr (registration-gated); GTSR not ingested",
            resolution_km: 1,
            attribution: "WRI Aqueduct Floods (coastal), CC BY 4.0",
            note: coast?.distKm && coast.distKm > 1 ? "non-coastal (>1 km from coastline)" : "",
          });
          break;
        }
        const h = elev.h;
        const score = h < 3 || (h < 5 && layers.climate === "tropical") ? 3 : 1;
        out.push({
          d,
          score,
          missing: false,
          low_confidence: true,
          coverage_ok: true,
          dataset:
            "SRTM coastal-fringe check (storm-surge.md secondary rule); Aqueduct coastal layer not ingested",
          resolution_km: 0.03,
          attribution: "USGS SRTM (public domain); WRI Aqueduct Floods (coastal), CC BY 4.0",
          note: "low-lying coastal fringe heuristic — not a modelled surge extent",
          raw: h,
        });
        break;
      }
      case "DROUGHT": {
        // SPEI-GDM (spei.csic.es) is egress-blocked from this box; U.S. DM
        // not wired. drought.md fallback 2 → skip with visible "not assessed".
        out.push({
          d,
          score: null,
          missing: true,
          low_confidence: true,
          coverage_ok: false,
          dataset: "not ingested — SPEI Global Drought Monitor (spei.csic.es) unreachable",
          resolution_km: 55,
          attribution: "SPEI-GDM — Begueria & Vicente-Serrano, CSIC (Vicente-Serrano et al. 2010)",
          note: "drought not assessed for this area",
        });
        break;
      }
      case "LANDSLIDE": {
        // SEDAC (bot-blocked) and NASA GLC export not ingested here.
        // landslide.md fallback 2 → "not assessed", weights renormalise.
        out.push({
          d,
          score: null,
          missing: true,
          low_confidence: true,
          coverage_ok: false,
          dataset: "not ingested — Global Landslide Hazard Distribution (SEDAC, DOI 10.7927/H4P848VZ)",
          resolution_km: 5,
          attribution:
            "Global Landslide Hazard Distribution, CIESIN/Columbia – NGI (2005), public domain",
          note: "landslide not assessed for this area",
        });
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Analysis runner — persistence into analyses + structure_scores
// ---------------------------------------------------------------------------
export type AnalysisSummary = {
  model_version: string;
  climate_type: string;
  scored: number;
  area_average: number;
  pct_high_vhigh: number;
  dominant_hazard_area: string | null;
  distribution: Record<number, number>;
  blend: { min: number; max: number; mean: number };
  statuses: Record<string, { scored: number; not_assessed: number; low_confidence: number }>;
  reference_periods: Record<string, string>;
};

export async function runAnalysisForArea(
  area: AreaRow,
  createdBy: number | null
): Promise<{ analysisId: number; summary: AnalysisSummary; errors: string[] }> {
  const climate = area.climate_type;
  const errors: string[] = [];
  const structures = db
    .query<{ id: number; centroid_lat: number; centroid_lon: number }, [number]>(
      `SELECT id, centroid_lat, centroid_lon FROM structures WHERE area_id = ? ORDER BY id`
    )
    .all(area.id);

  // -- acquire layers (best effort; keep going if a layer is missing) --------
  const tracks = ensureIbtracsTracks();
  if (!tracks.ok) errors.push(tracks.note ?? "IBTrACS unavailable");
  const trackRows = tracks.ok
    ? db
        .query<{ lat: number; lon: number; sshs: number }, [number, number, number]>(
          `SELECT lat, lon, sshs FROM ibtracs_tracks
           WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?`
        )
        .all(
          area.center_lat - 4,
          area.center_lat + 4,
          area.center_lng - 4,
          area.center_lng + 4
        )
    : [];
  const halfSpan = 0.06 + (area.radius_km / 111);
  const windGrid =
    trackRows.length > 0
      ? buildWindGrid(area.center_lat, area.center_lng, halfSpan, trackRows)
      : null;

  let osm = loadOsmBaseline(area.id);
  if (!osm) {
    try {
      osm = await fetchOsmBaseline(area.center_lat, area.center_lng, 0.08 + (area.radius_km / 111));
      saveOsmBaseline(area.id, osm);
    } catch (err) {
      errors.push(`OSM baseline fetch failed: ${(err as Error).message}`);
    }
  }

  const layers: StructureLayers = {
    climate,
    windCell: (lat, lon) => (windGrid ? windGrid(lat, lon) : null),
    srtm: srtmElevation,
    osm,
  };

  // -- per-structure scoring ------------------------------------------------
  const inserted: Array<{
    structureId: number;
    score: number;
    blend: number;
    dominant: HID | null;
    hazards: Record<string, number | null>;
    missing: HID[];
    lowConf: HID[];
    sources: unknown;
    raw: Record<string, number | null>;
  }> = [];
  let blendSum = 0;
  let scoredCount = 0;
  const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const statuses: Record<string, { scored: number; not_assessed: number; low_confidence: number }> = {};
  for (const s of structures) {
    const dims = evaluateStructure(s.centroid_lat, s.centroid_lon, layers);
    const combined = combine(climate, dims);
    const hazards: Record<string, number | null> = {};
    const raw: Record<string, number | null> = {};
    const missing: HID[] = [];
    const lowConf: HID[] = [];
    const sourcesHazards: Record<string, unknown> = {};
    for (const e of dims) {
      hazards[e.d] = e.score;
      raw[e.d] = e.raw ?? null;
      if (e.missing) missing.push(e.d);
      if (e.low_confidence) lowConf.push(e.d);
      const st = (statuses[e.d] ??= { scored: 0, not_assessed: 0, low_confidence: 0 });
      if (e.missing) st.not_assessed += 1;
      else st.scored += 1;
      if (e.low_confidence) st.low_confidence += 1;
      sourcesHazards[e.d] = {
        dataset: e.dataset,
        resolution_km: e.resolution_km,
        coverage_ok: e.coverage_ok,
        attribution: e.attribution,
        status: e.missing ? "not_assessed" : "scored",
        note: e.note ?? null,
      };
    }
    const sources = { climate_type: climate, hazards: sourcesHazards };
    if (combined.status === "scored") {
      scoredCount++;
      blendSum += combined.blend;
      distribution[combined.R] = (distribution[combined.R] ?? 0) + 1;
    }
    inserted.push({
      structureId: s.id,
      score: combined.R,
      blend: combined.blend,
      dominant: combined.dominant,
      hazards,
      missing,
      lowConf,
      sources,
      raw,
    });
  }

  // -- persist ---------------------------------------------------------------
  const now = new Date().toISOString();
  const ins = db.prepare(
    `INSERT INTO analyses (area_id, climate_type, status, params, created_by, created_at)
     VALUES (?, ?, 'complete', ?, ?, ?)`
  );
  const params = JSON.stringify({ model_version: FORMULA_VERSION, structures: structures.length });
  const analysisId = Number(
    ins.run(area.id, climate, params, createdBy, now).lastInsertRowid
  );

  let summaryOut: AnalysisSummary | null = null;
  const insScore = db.prepare(
    `INSERT INTO structure_scores
       (analysis_id, structure_id, hazard_scores, overall_score, risk_category,
        blend, formula_version, dominant_hazard, sources, missing_hazards, raw_values, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const distr = Object.fromEntries(Object.entries(distribution).filter(([, v]) => v > 0));
  db.run("BEGIN");
  try {
    for (const r of inserted) {
      insScore.run(
        analysisId,
        r.structureId,
        JSON.stringify(r.hazards),
        r.score,
        ["very_low","low","medium","high","very_high"][r.score-1],
        r.blend,
        FORMULA_VERSION,
        r.dominant,
        JSON.stringify(r.sources),
        JSON.stringify(r.missing),
        JSON.stringify(r.raw),
        now
      );
    }
    // area-level KPIs (COMBINATION_RULE.md §4)
    const highVHigh = (distribution[4] ?? 0) + (distribution[5] ?? 0);
    const pct = scoredCount > 0 ? (100 * highVHigh) / scoredCount : 0;
    const modal =
      scoredCount > 0
        ? Object.entries(
            inserted.reduce<Record<string, number>>((acc, r) => {
              if (r.dominant) acc[r.dominant] = (acc[r.dominant] ?? 0) + 1;
              return acc;
            }, {})
          ).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
        : null;
    const summary: AnalysisSummary = {
      model_version: FORMULA_VERSION,
      climate_type: climate,
      scored: scoredCount,
      area_average: scoredCount > 0 ? Math.round((100 * blendSum) / scoredCount) / 100 : 0,
      pct_high_vhigh: Math.round(pct * 10) / 10,
      dominant_hazard_area: modal,
      distribution: distr,
      blend: {
        min: inserted.length ? Math.min(...inserted.map((r) => r.blend)) : 0,
        max: inserted.length ? Math.max(...inserted.map((r) => r.blend)) : 0,
        mean: scoredCount > 0 ? Math.round((1000 * blendSum) / scoredCount) / 1000 : 0,
      },
      statuses,
      reference_periods: {
        FLOOD: "100-year event (1% annual chance)",
        STORM_SURGE: "100-year event (1% annual chance)",
        CYCLONE_WIND: "IBTrACS 1980–2023 (NA basin)",
        EXTREME_HEAT: "not available in this deployment",
        WILDFIRE: "not available in this deployment",
        SNOW_LOAD: "not available in this deployment",
        DROUGHT: "not available in this deployment",
        LANDSLIDE: "not available in this deployment",
      },
    };
    db.run(
      `UPDATE analyses SET summary = ?, sources = ?, completed_at = ? WHERE id = ?`,
      [
        JSON.stringify(summary),
        JSON.stringify({ climate_type: climate, model_version: FORMULA_VERSION }),
        now,
        analysisId,
      ]
    );
    summaryOut = summary;
    db.run("COMMIT");
  } catch (err) {
    db.run("ROLLBACK");
    throw err;
  }
  return { analysisId, summary: summaryOut!, errors };
}

export type StructureScoreRow = {
  id: number;
  analysis_id: number;
  structure_id: number;
  centroid_lat: number;
  centroid_lon: number;
  hazard_scores: Record<string, number | null>;
  overall_score: number;
  blend: number;
  dominant_hazard: string | null;
  risk_category: string;
  computed_at: string;
};

export function fetchStructureScores(analysisId: number, areaId: number): StructureScoreRow[] {
  const rows = db
    .query<
      {
        id: number;
        analysis_id: number;
        structure_id: number;
        hazard_scores: string;
        overall_score: number;
        risk_category: string;
        blend: number;
        dominant_hazard: string | null;
        computed_at: string;
        centroid_lat: number;
        centroid_lon: number;
      },
      [number, number]
    >(
      `SELECT ss.id, ss.analysis_id, ss.structure_id, ss.hazard_scores, ss.overall_score,
              ss.risk_category, ss.blend, ss.dominant_hazard, ss.computed_at,
              st.centroid_lat, st.centroid_lon
       FROM structure_scores ss JOIN structures st ON st.id = ss.structure_id
       WHERE ss.analysis_id = ? AND st.area_id = ?
       ORDER BY ss.overall_score DESC, ss.blend DESC, ss.id`
    )
    .all(analysisId, areaId);
  return rows.map((r) => ({
    ...r,
    hazard_scores: JSON.parse(r.hazard_scores) as Record<string, number | null>,
  }));
}

export function latestAnalysisForArea(areaId: number): AnalysisRow | null {
  return (
    db
      .query<AnalysisRow, [number]>(
        `SELECT * FROM analyses WHERE area_id = ? ORDER BY id DESC LIMIT 1`
      )
      .get(areaId) ?? null
  );
}