/**
 * Hazard data cache (.data/hazard-cache/) — normalized, gitignored local copies
 * of public datasets, produced by `bun scripts/refresh-hazard-data.ts`.
 *
 * Evaluators in src/lib/scoring.ts read ONLY these normalized files at scoring
 * time — never the network. If a file/meta is missing or unreadable the sampler
 * factory returns null and the caller keeps its documented honest fallback.
 *
 * Normalized formats (kept deliberately dead simple):
 *  - <name>.f32            raw little-endian float32 row-major grid (ny × nx)
 *  - <name>.meta.json      GridMeta (orientation, spacing, provenance)
 *
 * Missing values are NaN in the .f32 payload (ocean cells, skipped cells).
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const HAZARD_CACHE_DIR = join(process.cwd(), ".data", "hazard-cache");

export type GridMeta = {
  kind: "worldclim_bio5" | "gfwed_fwi_top3";
  nx: number; // columns (longitude)
  ny: number; // rows (latitude)
  lon0: number; // longitude of column 0 center (°E)
  lat0: number; // latitude of row 0 center (°N)
  dLon: number; // column step (°) — always positive; wraps globally
  dLat: number; // row step (°) — positive when rows ascend with latitude, negative when they descend
  source: string;
  source_url: string;
  variable: string;
  units: string;
  period: string;
  retrieved_at: string;
  notes?: string;
};

function readMeta(dir: string, name: string): GridMeta | null {
  const p = join(dir, `${name}.meta.json`);
  if (!existsSync(p)) return null;
  try {
    const m = JSON.parse(readFileSync(p, "utf8")) as GridMeta;
    if (!m || typeof m.nx !== "number" || typeof m.ny !== "number") return null;
    return m;
  } catch {
    return null;
  }
}

type Grid = { meta: GridMeta; data: Float32Array };

const gridCache = new Map<string, Grid | null>();

function loadGrid(dir: string, name: string): Grid | null {
  const key = `${dir}|${name}`;
  if (gridCache.has(key)) return gridCache.get(key)!;
  let g: Grid | null = null;
  const meta = readMeta(dir, name);
  const bin = join(dir, `${name}.f32`);
  if (meta && existsSync(bin)) {
    try {
      const buf = readFileSync(bin);
      const expected = meta.nx * meta.ny * 4;
      if (buf.byteLength >= expected) {
        g = { meta, data: new Float32Array(buf.buffer, buf.byteOffset, meta.nx * meta.ny) };
      }
    } catch {
      g = null;
    }
  }
  gridCache.set(key, g);
  return g;
}

/** Nearest-cell index with global wrap on longitude; null outside the latitude span. */
function cellAt(g: Grid, lat: number, lon: number): { r: number; c: number } | null {
  const { meta } = g;
  const nLon = meta.dLon;
  let c = Math.floor((lon - meta.lon0) / nLon + 0.5);
  c = ((c % meta.nx) + meta.nx) % meta.nx;
  const latStep = meta.dLat;
  const dRows = latStep > 0 ? (lat - meta.lat0) / latStep : (meta.lat0 - lat) / -latStep;
  const r = Math.floor(dRows + 0.5);
  if (r < 0 || r >= meta.ny) return null;
  return { r, c };
}

function valueAt(g: Grid, r: number, c: number): number {
  return g.data[r * g.meta.nx + c];
}

/**
 * WorldClim v2.1 BIO5 (max temperature of warmest month, °C) sampler.
 * Spec fallback 1: if the nearest cell is empty (ocean/coast gap), take the
 * nearest valid cell within 0.5°; if none, returns null → caller's fallback 3.
 * Returns null when the cache is absent/corrupt (caller keeps its fallback).
 */
export function createBio5Sampler(
  dir: string = HAZARD_CACHE_DIR
): ((lat: number, lon: number) => { t: number } | null) | null {
  const g = loadGrid(dir, "worldclim10m_bio5");
  if (!g) return null;
  const { meta } = g;
  // Spec fallback 1: nearest valid cell within 0.5° (degree window, not cells —
  // works for any grid spacing; a point whose whole 0.5° neighbourhood is NaN
  // gets the honest fallback 3 instead of a value that is too far away).
  const offLat = Math.max(1, Math.ceil(0.50001 / Math.abs(meta.dLat)));
  const offLon = Math.max(1, Math.ceil(0.50001 / Math.abs(meta.dLon)));
  return (lat, lon) => {
    const cell = cellAt(g, lat, lon);
    if (!cell) return null;
    const v = valueAt(g, cell.r, cell.c);
    if (!Number.isNaN(v) && Math.abs(v) < 1e30) return { t: v };
    // search a degree-limited neighbourhood and take the truly NEAREST valid
    // cell (degree distance; ties broken by smaller row/col offset)
    let best: { v: number; d2: number } | null = null;
    for (let dr = -offLat; dr <= offLat; dr++) {
      const dLat = Math.abs(dr * meta.dLat);
      if (dLat > 0.50001) continue;
      for (let dc = -offLon; dc <= offLon; dc++) {
        if (dr === 0 && dc === 0) continue;
        const dLon = Math.abs(dc * meta.dLon);
        if (dLon > 0.50001) continue;
        const r = cell.r + dr;
        if (r < 0 || r >= meta.ny) continue;
        const c = ((cell.c + dc) % meta.nx + meta.nx) % meta.nx;
        const v2 = valueAt(g, r, c);
        if (Number.isNaN(v2) || Math.abs(v2) >= 1e30) continue;
        const d2 = dLat * dLat + dLon * dLon;
        if (!best || d2 < best.d2) best = { v: v2, d2 };
      }
    }
    return best ? { t: best.v } : null;
  };
}

/**
 * GFWED FWI climatology sampler (per-cell peak-season FWI, see meta `notes`).
 * Strict nearest cell — wildfire.md gives no nearest-neighbour escape for FWI;
 * a NaN (ocean / GFWED-skipped cell) returns null → caller's fallback.
 */
export function createFwiSampler(
  dir: string = HAZARD_CACHE_DIR
): ((lat: number, lon: number) => { fwi: number } | null) | null {
  const g = loadGrid(dir, "gfwed_fwi_top3");
  if (!g) return null;
  return (lat, lon) => {
    const cell = cellAt(g, lat, lon);
    if (!cell) return null;
    const v = valueAt(g, cell.r, cell.c);
    if (Number.isNaN(v) || Math.abs(v) >= 1e30) return null;
    return { fwi: v };
  };
}
