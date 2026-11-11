/**
 * refresh-hazard-data.ts — download + normalize public hazard datasets into
 * `.data/hazard-cache/` (gitignored). Evaluators in src/lib/scoring.ts read
 * ONLY the normalized output at scoring time; this script is the one place
 * that touches the network.
 *
 *   bun scripts/refresh-hazard-data.ts            # all datasets (skips completed steps)
 *   bun scripts/refresh-hazard-data.ts --force    # re-download everything
 *   bun scripts/refresh-hazard-data.ts --only wind|heat|fire
 *
 * Steps (each independently best-effort — a failure keeps that hazard's
 * documented fallback; the others still refresh):
 *   wind — NOAA NCEI IBTrACS v04r01 NA-basin list CSV → cache + SQLite ingest
 *          (src/lib/scoring.ts ensureIbtracsTracks reads the cache).
 *   heat — WorldClim v2.1 10m BIO5 (wc2.1_10m_bio.zip) → LZW-decode the
 *          single BIO5 GeoTIFF → worldclim10m_bio5.f32 + meta.
 *   fire — NASA GISS GFWED v2 (MERRA-2) 12 long-term monthly-mean FWI files
 *          (1981–2010) → per-cell mean of the top-3 calendar months
 *          (wildfire.md's monthly-granularity statistic) → gfwed_fwi_top3.f32 + meta.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { ensureIbtracsTracks } from "~/lib/scoring";
import { HAZARD_CACHE_DIR, type GridMeta } from "~/lib/hazard-cache";

const FORCE = process.argv.includes("--force");
const ONLY = (() => {
  const i = process.argv.indexOf("--only");
  const v = i >= 0 ? process.argv[i + 1] : null;
  return v === "wind" || v === "heat" || v === "fire" ? v : null;
})();

const done: string[] = [];
const failed: string[] = [];

async function runStep(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    done.push(name);
  } catch (err) {
    failed.push(`${name}: ${(err as Error).message}`);
    console.error(`✗ ${name}: ${(err as Error).message}`);
  }
}

async function fetchToFile(url: string, dest: string, timeoutMs = 600_000): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength < 1024) throw new Error(`suspiciously small payload (${buf.byteLength} B) from ${url}`);
  writeFileSync(dest, buf);
}

// ---------------------------------------------------------------------------
// Minimal ZIP reader (store + deflate entries only — enough for WorldClim)
// ---------------------------------------------------------------------------
type ZipEntry = { name: string; method: number; compressedSize: number; localOffset: number };

function zipEntries(buf: Buffer): ZipEntry[] {
  // find End Of Central Directory (signature 0x06054b50) from the tail
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 66_000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("zip: EOCD not found");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("zip: bad central directory");
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    out.push({ name, method, compressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function zipExtract(buf: Buffer, entryName: string): Buffer {
  const e = zipEntries(buf).find((e) => e.name === entryName);
  if (!e) throw new Error(`zip: entry ${entryName} not found`);
  const p = e.localOffset;
  if (buf.readUInt32LE(p) !== 0x04034b50) throw new Error("zip: bad local header");
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + e.compressedSize);
  if (e.method === 0) return Buffer.from(raw);
  if (e.method === 8) return inflateRawSync(raw);
  throw new Error(`zip: unsupported method ${e.method}`);
}

// ---------------------------------------------------------------------------
// TIFF (little-endian, strip-based) reader + LZW decoder — enough for BIO5
// ---------------------------------------------------------------------------
type TiffInfo = {
  width: number; height: number; bitsPerSample: number; compression: number;
  stripOffsets: number[]; stripByteCounts: number[];
  pixelScale: [number, number, number]; tiepoint: [number, number, number, number, number, number];
};

function parseTiff(buf: Buffer): TiffInfo {
  if (!(buf[0] === 0x49 && buf[1] === 0x49 && buf.readUInt16LE(2) === 42)) throw new Error("tiff: not little-endian TIFF");
  // TIFF field types: 1 BYTE, 2 ASCII, 3 SHORT, 4 LONG, 5 RATIONAL, 6 SBYTE,
  // 7 UNDEFINED, 8 SSHORT, 9 SLONG, 10 SRATIONAL, 11 FLOAT, 12 DOUBLE, 13 IFD.
  const typeSize: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };
  type Tag = { type: number; count: number; valueOffset: number; inline: Buffer };
  const tags = new Map<number, Tag>();
  let p = buf.readUInt32LE(4);
  const n = buf.readUInt16LE(p); p += 2;
  for (let i = 0; i < n; i++) {
    const tag = buf.readUInt16LE(p);
    const type = buf.readUInt16LE(p + 2);
    const count = buf.readUInt32LE(p + 4);
    const sz = count * (typeSize[type] ?? 1);
    if (Number.isNaN(sz)) throw new Error(`tiff: bad type ${type}`);
    if (sz <= 4) tags.set(tag, { type, count, valueOffset: 0, inline: buf.subarray(p + 8, p + 8 + sz) });
    else tags.set(tag, { type, count, valueOffset: buf.readUInt32LE(p + 8), inline: Buffer.alloc(0) });
    p += 12;
  }
  const num = (tag: number, i: number): number => {
    const t = tags.get(tag);
    if (!t) throw new Error(`tiff: tag ${tag} missing`);
    if (t.count * typeSize[t.type] <= 4) {
      if (t.type === 3) return t.inline.readUInt16LE(i * 2);
      if (t.type === 4) return t.inline.readUInt32LE(i * 4);
      return t.inline.readUInt8(i);
    }
    const off = t.valueOffset;
    if (t.type === 3) return buf.readUInt16LE(off + i * 2);
    if (t.type === 4) return buf.readUInt32LE(off + i * 4);
    if (t.type === 5) return buf.readUInt32LE(off + i * 8); // RATIONAL numerator (unused here)
    if (t.type === 12) return buf.readDoubleLE(off + i * 8);
    throw new Error(`tiff: unsupported tag type ${t.type}`);
  };
  const numArr = (tag: number): number[] => {
    const t = tags.get(tag);
    if (!t) throw new Error(`tiff: tag ${tag} missing`);
    return Array.from({ length: t.count }, (_, i) => num(tag, i));
  };
  const dbl = (tag: number, i: number): number => {
    const t = tags.get(tag)!;
    return t.type === 12 ? buf.readDoubleLE(t.valueOffset + i * 8) : num(tag, i);
  };
  return {
    width: num(0x0100, 0),
    height: num(0x0101, 0),
    bitsPerSample: num(0x0102, 0),
    compression: num(0x0103, 0),
    stripOffsets: numArr(0x0111),
    stripByteCounts: numArr(0x0117),
    pixelScale: [dbl(0x830e, 0), dbl(0x830e, 1), dbl(0x830e, 2)],
    tiepoint: [dbl(0x8482, 0), dbl(0x8482, 1), dbl(0x8482, 2), dbl(0x8482, 3), dbl(0x8482, 4), dbl(0x8482, 5)],
  };
}

/** TIFF-LZW decode with a selectable width-switch rule (early vs late change). */
function tiffLzwDecodeStrip(src: Buffer, outBytes: number, earlyChange: boolean): Buffer {
  const out = Buffer.alloc(outBytes);
  let o = 0;
  let codeWidth = 9;
  let bitPos = 0;
  let next = 258;
  const table: Uint8Array[] = [];
  const reset = (): void => {
    table.length = 0;
    for (let i = 0; i < 256; i++) table[i] = new Uint8Array([i]);
    next = 258;
    codeWidth = 9;
  };
  reset();
  let prev: Uint8Array | null = null;
  const readCode = (): number => {
    let code = 0;
    for (let b = 0; b < codeWidth; b++) {
      const byteIdx = bitPos >> 3;
      if (byteIdx >= src.byteLength) return 257;
      const bit = (src[byteIdx] >> (7 - (bitPos & 7))) & 1;
      code = (code << 1) | bit;
      bitPos++;
    }
    return code;
  };
  for (;;) {
    const code = readCode();
    if (code === 256) { reset(); prev = null; continue; }
    if (code === 257) break;
    let entry: Uint8Array;
    if (code < next && table[code]) entry = table[code];
    else if (code === next && prev) {
      entry = new Uint8Array(prev.length + 1);
      entry.set(prev, 0);
      entry[prev.length] = prev[0];
    } else throw new Error(`lzw: bad code ${code} (next=${next})`);
    if (o + entry.length > outBytes) throw new Error("lzw: strip overflow");
    out.set(entry, o);
    o += entry.length;
    if (prev) {
      const s = new Uint8Array(prev.length + 1);
      s.set(prev, 0);
      s[prev.length] = entry[0];
      table[next++] = s;
      // TIFF writers vary by one code in when the code width grows; the caller
      // tries both rules and keeps the one that decodes the strip cleanly.
      const switchAt = earlyChange ? (1 << codeWidth) - 1 : 1 << codeWidth;
      if (next === switchAt && codeWidth < 12) codeWidth++;
    }
    prev = entry;
    if (o >= outBytes) break;
  }
  if (o !== outBytes) throw new Error(`lzw: short strip (${o}/${outBytes})`);
  return out;
}

function decodeStripAuto(src: Buffer, width: number): Buffer {
  try {
    return tiffLzwDecodeStrip(src, width, true);
  } catch {
    return tiffLzwDecodeStrip(src, width, false);
  }
}

// ---------------------------------------------------------------------------
// NetCDF-3 (classic CDF\x01 and 64-bit-offset CDF\x02) reader — enough for GFWED
// ---------------------------------------------------------------------------
type NcVar = { name: string; type: number; begin: number };
type NcFile = { dims: { name: string; size: number }[]; vars: NcVar[]; buf: Buffer };

function parseNetcdf3(buf: Buffer): NcFile {
  if (!(buf[0] === 0x43 && buf[1] === 0x44 && buf[2] === 0x46)) throw new Error("netcdf: not CDF");
  const version = buf[3]; // 1 or 2
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 4;
  const u32 = (): number => { const v = dv.getUint32(p); p += 4; return v; };
  u32(); // numrecs
  const name = (): string => {
    const n = u32();
    const s = buf.toString("latin1", p, p + n);
    p += n;
    p = (p + 3) & ~3;
    return s;
  };
  const typeSize = [0, 1, 1, 2, 4, 4, 8, 8];
  const skipAttrs = (): void => {
    const t0 = u32();
    if (t0 === 0) return;
    if (t0 !== 0x0c) throw new Error(`netcdf: bad attr tag ${t0} @${p - 4}`);
    const n = u32();
    for (let i = 0; i < n; i++) {
      name();
      const t = u32();
      const ne = u32();
      p += ne * (typeSize[t] ?? 1);
      p = (p + 3) & ~3;
    }
  };
  const dims: { name: string; size: number }[] = [];
  const tag = u32();
  if (tag === 0x0a) {
    const n = u32();
    for (let i = 0; i < n; i++) dims.push({ name: name(), size: u32() });
  }
  skipAttrs();
  const vtag = u32();
  if (vtag !== 0x0b) throw new Error("netcdf: bad var tag");
  const nvars = u32();
  const vars: NcVar[] = [];
  for (let i = 0; i < nvars; i++) {
    const vn = name();
    const nd = u32();
    for (let k = 0; k < nd; k++) u32(); // dim ids (fixed layout: time × lat × lon)
    skipAttrs();
    const type = u32();
    u32(); // vsize
    const begin = version === 2 ? Number(dv.getBigUint64(p)) : u32();
    if (version === 2) p += 8;
    vars.push({ name: vn, type, begin });
  }
  return { dims, vars, buf };
}

const ncDouble = (f: NcFile, v: NcVar, i: number): number => f.buf.readDoubleLE(v.begin + i * 8);
const ncFloat = (f: NcFile, v: NcVar, i: number): number => f.buf.readFloatLE(v.begin + i * 4);

// ---------------------------------------------------------------------------
// Pipeline steps
// ---------------------------------------------------------------------------
const IBTRACS_URL =
  "https://www.ncei.noaa.gov/data/international-best-track-archive-for-climate-stewardship-ibtracs/v04r01/access/csv/ibtracs.NA.list.v04r01.csv";
const WORLCLIM_URL = "https://geodata.ucdavis.edu/climate/worldclim/2_1/base/wc2.1_10m_bio.zip";
const GFWED_BASE =
  "https://portal.nccs.nasa.gov/datashare/GlobalFWI/v2.0/fwiCalcs.MERRA2/Default/MERRA2";

async function ibtracs(): Promise<void> {
  mkdirSync(HAZARD_CACHE_DIR, { recursive: true });
  const csv = join(HAZARD_CACHE_DIR, "ibtracs.NA.list.v04r01.csv");
  const metaPath = join(HAZARD_CACHE_DIR, "ibtracs.NA.list.v04r01.meta.json");
  if (FORCE || !existsSync(csv)) {
    console.log("wind: downloading IBTrACS NA list (~58 MB)…");
    await fetchToFile(IBTRACS_URL, csv);
  } else {
    console.log("wind: CSV already cached");
  }
  const ing = ensureIbtracsTracks();
  if (!ing.ok) throw new Error(`ingest failed: ${ing.note ?? "unknown"}`);
  writeFileSync(
    metaPath,
    JSON.stringify(
      {
        dataset: "NOAA NCEI IBTrACS v04r01 — NA basin list CSV",
        source_url: IBTRACS_URL,
        variable: "sid, season, iso_time, lat, lon, nature, USA_WIND, USA_SSHS",
        units: "lat/lon deg; wind kt; SSHS category",
        period: "1980–2023 seasons (spec window)",
        ingested_rows: ing.count,
        retrieved_at: new Date().toISOString(),
        notes: "Ingested into SQLite table ibtracs_tracks by ensureIbtracsTracks().",
      },
      null,
      2
    )
  );
  console.log(`wind: ingested ${ing.count} track points`);
}

async function worldclim(): Promise<void> {
  mkdirSync(HAZARD_CACHE_DIR, { recursive: true });
  const zipPath = join(HAZARD_CACHE_DIR, "wc2.1_10m_bio.zip");
  const f32Path = join(HAZARD_CACHE_DIR, "worldclim10m_bio5.f32");
  const metaPath = join(HAZARD_CACHE_DIR, "worldclim10m_bio5.meta.json");
  if (existsSync(f32Path) && !FORCE) {
    console.log("heat: BIO5 cache already present");
    return;
  }
  if (FORCE || !existsSync(zipPath)) {
    console.log("heat: downloading WorldClim 2.1 10m bio zip (~50 MB)…");
    await fetchToFile(WORLCLIM_URL, zipPath);
  }
  const zip = readFileSync(zipPath);
  const tif = zipExtract(zip, "wc2.1_10m_bio_5.tif");
  const info = parseTiff(tif);
  if (info.compression !== 5) throw new Error(`tiff: unexpected compression ${info.compression}`);
  if (info.bitsPerSample !== 32) throw new Error(`tiff: unexpected bits/sample ${info.bitsPerSample}`);
  // (StripByteCounts is the COMPRESSED size per strip — it does not tile the
  // raster; correctness is checked by the land-fraction sanity check below.)
  const grid = Buffer.alloc(info.width * info.height * 4);
  for (let s = 0; s < info.stripOffsets.length; s++) {
    const strip = decodeStripAuto(
      tif.subarray(info.stripOffsets[s], info.stripOffsets[s] + info.stripByteCounts[s]),
      info.width * 4
    );
    strip.copy(grid, s * info.width * 4);
  }
  const f = new Float32Array(grid.buffer, grid.byteOffset, info.width * info.height);
  let land = 0;
  for (let i = 0; i < f.length; i++) if (!Number.isNaN(f[i]) && Math.abs(f[i]) < 1e30) land++;
  if (land < f.length * 0.2) throw new Error(`heat: only ${(100 * land) / f.length}% valid cells — decode likely wrong`);
  // WorldClim ocean nodata is -3.4e38 (not NaN): normalize it to NaN so the
  // samplers' missing-value logic is uniform.
  for (let i = 0; i < f.length; i++) if (Math.abs(f[i]) >= 1e30) f[i] = NaN;
  // orientation: ModelTiepoint maps raster (0,0) → (lon -180, lat 90); row 0 is 90°N
  const dLon = info.pixelScale[0];
  const dLat = -info.pixelScale[1];
  const meta: GridMeta = {
    kind: "worldclim_bio5",
    nx: info.width,
    ny: info.height,
    lon0: info.tiepoint[3] + dLon / 2,
    lat0: info.tiepoint[4] + dLat / 2,
    dLon,
    dLat,
    source: "WorldClim v2.1 BIO5 (Fick & Hijmans 2017), 10 arc-min",
    source_url: WORLCLIM_URL,
    variable: "BIO5 — max temperature of warmest month",
    units: "°C",
    period: "1970–2000 climatology",
    retrieved_at: new Date().toISOString(),
    notes: "Extracted from wc2.1_10m_bio.zip (BIO5 only); LZW-decoded; NaN = ocean.",
  };
  writeFileSync(f32Path, grid);
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  console.log(`heat: BIO5 grid ${info.width}×${info.height}, ${land} land cells`);
}

async function gfwed(): Promise<void> {
  mkdirSync(HAZARD_CACHE_DIR, { recursive: true });
  const f32Path = join(HAZARD_CACHE_DIR, "gfwed_fwi_top3.f32");
  const metaPath = join(HAZARD_CACHE_DIR, "gfwed_fwi_top3.meta.json");
  if (existsSync(f32Path) && !FORCE) {
    console.log("fire: FWI cache already present");
    return;
  }
  const monthly: Float32Array[] = [];
  let nx = 0, ny = 0, lon0 = 0, lat0 = 0, dLon = 0, dLat = 0;
  for (let mm = 1; mm <= 12; mm++) {
    const mmS = String(mm).padStart(2, "0");
    const fname = `FWI.MERRA2.LongTermMean.Default.1981.2010.${mmS}.nc`;
    const local = join(HAZARD_CACHE_DIR, fname);
    if (FORCE || !existsSync(local)) {
      console.log(`fire: downloading GFWED LTM ${mmS}…`);
      await fetchToFile(`${GFWED_BASE}/${fname}`, local);
    }
    const nc = parseNetcdf3(readFileSync(local));
    const fwiVar = nc.vars.find((v) => v.name === "MERRA2_FWI");
    const latVar = nc.vars.find((v) => v.name === "lat");
    const lonVar = nc.vars.find((v) => v.name === "lon");
    if (!fwiVar || !latVar || !lonVar) throw new Error(`netcdf: variables missing in ${fname}`);
    const nLat = nc.dims.find((d) => d.name === "lat")!.size;
    const nLon = nc.dims.find((d) => d.name === "lon")!.size;
    if (nx === 0) {
      nx = nLon; ny = nLat;
      lon0 = ncDouble(nc, lonVar, 0);
      lat0 = ncDouble(nc, latVar, 0);
      dLon = ncDouble(nc, lonVar, 1) - lon0;
      dLat = ncDouble(nc, latVar, 1) - lat0;
    } else if (nx !== nLon || ny !== nLat) throw new Error("netcdf: grid changed between months");
    const g = new Float32Array(nLon * nLat);
    for (let i = 0; i < g.length; i++) g[i] = ncFloat(nc, fwiVar, i);
    monthly.push(g);
  }
  // per-cell: mean of the top-3 calendar-month long-term means — wildfire.md's
  // monthly-granularity statistic ("mean of the top-3 monthly means").
  const out = new Float32Array(nx * ny);
  for (let i = 0; i < out.length; i++) {
    const v = monthly.map((m) => m[i]);
    if (Number.isNaN(v[0])) { out[i] = NaN; continue; }
    v.sort((a, b) => b - a);
    out[i] = (v[0] + v[1] + v[2]) / 3;
  }
  const meta: GridMeta = {
    kind: "gfwed_fwi_top3",
    nx,
    ny,
    lon0,
    lat0,
    dLon,
    dLat,
    source: "NASA GISS GFWED v2 (MERRA-2 forcing) long-term monthly-mean FWI, 1981–2010",
    source_url: `${GFWED_BASE}/FWI.MERRA2.LongTermMean.Default.1981.2010.<MM>.nc`,
    variable: "MERRA2_FWI (monthly mean), per-cell mean of top-3 calendar months",
    units: "FWI (Canadian Fire Weather Index)",
    period: "1981–2010",
    retrieved_at: new Date().toISOString(),
    notes:
      "0.625° lon × 0.5° lat native MERRA-2 grid (spec described the 0.25° GPCP-era grid). " +
      "Monthly-mean climatology per wildfire.md fallback granularity, not the preferred daily p90 — biased LOW; scored with NRCan FWI danger classes.",
  };
  writeFileSync(f32Path, Buffer.from(out.buffer, out.byteOffset, out.byteLength));
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  let valid = 0;
  for (let i = 0; i < out.length; i++) if (!Number.isNaN(out[i])) valid++;
  console.log(`fire: FWI peak-season grid ${nx}×${ny}, ${valid} valid cells`);
}

async function main(): Promise<void> {
  console.log(`hazard cache → ${HAZARD_CACHE_DIR}`);
  mkdirSync(HAZARD_CACHE_DIR, { recursive: true });
  if (!ONLY || ONLY === "wind") await runStep("wind", ibtracs);
  if (!ONLY || ONLY === "heat") await runStep("heat", worldclim);
  if (!ONLY || ONLY === "fire") await runStep("fire", gfwed);
  console.log(`done: ${done.join(", ") || "none"}${failed.length ? `; FAILED: ${failed.join("; ")}` : ""}`);
  if (failed.length) process.exitCode = 2;
}

await main();
