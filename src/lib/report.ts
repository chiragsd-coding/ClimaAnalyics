/**
 * PDF area report builder (Slice 5).
 *
 * Generates a compliance-sensitive, downloadable area report at request time
 * from a saved analysis + its stored structure scores. Pure image-less
 * vector PDF via pdf-lib (no native deps, runs on Bun server-side).
 *
 * Content rules (CREDIBILITY_RISKS.md, normative):
 *  - Page 1: title, area + analysis meta, executive summary, the §5 disclaimer
 *    VERBATIM, demo tag for the Miami demo area.
 *  - Page 2: per-layer table with dataset, resolution, reference/return period
 *    (per CREDIBILITY_RISKS §3 — flood/surge read "100-year event (1% annual
 *    chance)"), licence attribution, and the required §4 per-hazard label.
 *  - Page 3: top ~10 structures by overall score with per-hazard breakdown.
 *  - Page 4: per-hazard `sources` JSON provenance rendered verbatim (the same
 *    merged object the /sources endpoint serves).
 *  - Banned words anywhere in generated text: verified, certified, compliant.
 *  - No present-tense "today's risk" claims — everything is climatology or
 *    long-run statistics, labelled "model estimate".
 */
import { PDFDocument, PDFFont, PDFPage, rgb, StandardFonts } from "pdf-lib";
import { db, parseJsonSafe, type AnalysisRow, type AreaRow } from "~/lib/db";

// ---------------------------------------------------------------------------
// Normative content (CREDIBILITY_RISKS.md)
// ---------------------------------------------------------------------------

/** §5 disclaimer — must appear VERBATIM on page 1. */
export const REPORT_DISCLAIMER =
  "ClimaScope risk scores are model estimates of hazard exposure at each structure's location, derived from public datasets at the stated resolutions. They are not engineering assessments of any individual building and are not a substitute for site inspection, flood insurance rate maps, or professional structural analysis.";

/** Display label per hazard dimension. */
export const HID_LABELS: Record<string, string> = {
  FLOOD: "Flood",
  CYCLONE_WIND: "Cyclone wind",
  EXTREME_HEAT: "Extreme heat",
  WILDFIRE: "Wildfire",
  SNOW_LOAD: "Snow load",
  STORM_SURGE: "Storm surge",
  DROUGHT: "Drought",
  LANDSLIDE: "Landslide",
  HAIL: "Hail",
};

/** §4 required per-hazard label (verbatim from CREDIBILITY_RISKS.md). */
export const REQUIRED_LABELS: Record<string, string> = {
  FLOOD: "River-flood model (100-yr) — urban and small-stream flooding may be understated",
  CYCLONE_WIND: "Wind score is a track-proximity heuristic, not a wind-load model",
  EXTREME_HEAT: "Heat index from warmest-month temperature; humidity not included",
  WILDFIRE: "Fire danger from weather (FWI); vegetation and suppression not modelled",
  SNOW_LOAD: "Approximate snow load from snow-water equivalent — not an engineering snow load",
  STORM_SURGE: "Coastal flood model (100-yr); sea-level rise not included",
  DROUGHT: "Drought frequency — supporting indicator",
  LANDSLIDE: "Susceptibility at ~5 km — parcel-scale landslide risk is not assessed",
};

/** §3 reference/return periods per layer (verbatim wording mandated for flood/surge). */
export const REFERENCE_PERIODS: Record<string, string> = {
  FLOOD: "100-year event (1% annual chance)",
  STORM_SURGE: "100-year event (1% annual chance)",
  CYCLONE_WIND: "IBTrACS 1980–2023 (NA basin)",
  EXTREME_HEAT: "1970–2000 WorldClim climatology",
  WILDFIRE: "2001–2022 FWI climatology",
  SNOW_LOAD: "1991–2020 snow climatology",
  DROUGHT: "1991–2022 SPEI",
  LANDSLIDE: "Static susceptibility map (v1, 2005)",
};

export const BANNED_WORDS = ["verified", "certified", "compliant"];

const RISK_CATEGORIES = ["very_low", "low", "medium", "high", "very_high"];

// ---------------------------------------------------------------------------
// Shared data helpers
// ---------------------------------------------------------------------------

export type HazardSourceMeta = {
  dataset?: string;
  resolution_km?: number | null;
  attribution?: string;
  status?: string;
  note?: string | null;
};

/**
 * Merge per-structure source metadata into one per-hazard object — the exact
 * same object served by GET /api/areas/:id/analyses/:aid/sources. Source
 * metadata is uniform per hazard dimension, so a sample of score rows suffices.
 */
export function mergedHazardSources(analysisId: number): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  const rows = db
    .query<{ sources: string | null }, [number]>(
      "SELECT sources FROM structure_scores WHERE analysis_id = ? LIMIT 25"
    )
    .all(analysisId);
  for (const r of rows) {
    const s = parseJsonSafe<{ hazards?: Record<string, unknown> }>(r.sources);
    for (const [hid, meta] of Object.entries(s?.hazards ?? {})) {
      if (!(hid in merged)) merged[hid] = meta;
    }
  }
  return merged;
}

export type ReportTopStructure = {
  structure_id: number;
  lat: number;
  lng: number;
  overall_score: number;
  risk_category: string;
  blend: number;
  dominant_hazard: string | null;
  hazard_scores: Record<string, number>;
};

export type ReportInput = {
  area: AreaRow;
  analysis: AnalysisRow;
  summary: Record<string, unknown>;
  /** Merged per-hazard sources (as served by /sources). */
  hazards: Record<string, unknown>;
  topStructures: ReportTopStructure[];
};

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function sanitize(s: string): string {
  // WinAnsi-safe: pdf-lib's standard 14 fonts only encode Latin-1 + a few
  // punctuation. Map the common non-WinAnsi maths glyphs; drop the rest.
  return s
    .replace(/≈/g, "~")
    .replace(/≤/g, "<=")
    .replace(/≥/g, ">=")
    .replace(/[^\x20-\x7E\u00A0-\u00FF]/g, (ch) => {
      // Keep WinAnsi punctuation/diacritics (en/em dashes are WinAnsi); the
      // few maths glyphs outside WinAnsi become text equivalents.
      const map: Record<string, string> = {
        "–": "–",
        "—": "—",
        "‘": "'",
        "’": "'",
        "“": '"',
        "”": '"',
        "°": " deg",
        "×": "x",
      };
      return map[ch] ?? "?";
    });
}

function wrapText(s: string, maxChars: number): string[] {
  if (s.length <= maxChars) return [s];
  const words = s.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur.length === 0) cur = w;
    else if (cur.length + 1 + w.length <= maxChars) cur += " " + w;
    else {
      lines.push(cur);
      cur = w.length > maxChars ? w.slice(0, maxChars) : w;
    }
  }
  if (cur.length > 0) lines.push(cur);
  return lines;
}

type DrawOpts = {
  size?: number;
  color?: [number, number, number];
  bold?: boolean;
  maxChars?: number;
  gap?: number;
};

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

const PAGE_W = 595.28; // A4
const PAGE_H = 841.89;
const MARGIN = 50;
const CONTENT_W = PAGE_W - MARGIN * 2;
const INK = rgb(0.078, 0.09, 0.125); // slate-900
const MUTED = rgb(0.4, 0.44, 0.52);
const TEAL = rgb(0.047, 0.418, 0.408);
const RULE = rgb(0.85, 0.87, 0.9);

export async function buildReportPdf(input: ReportInput): Promise<{ bytes: Uint8Array; text: string }> {
  const texts: string[] = [];
  const push = (s: string) => texts.push(s);

  const doc = await PDFDocument.create();
  const font = await doc.embedStandardFont(StandardFonts.Helvetica);
  const bold = await doc.embedStandardFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedStandardFont(StandardFonts.Courier);

  const summary = input.summary;
  const num = (v: unknown, dp = 2): string =>
    typeof v === "number" && Number.isFinite(v) ? v.toFixed(dp) : "—";
  const area = input.area;
  const isDemo = area.is_demo === 1;
  const scored = typeof summary.scored === "number" ? summary.scored : 0;

  function drawText(
    page: PDFPage,
    f: PDFFont,
    size: number,
    x: number,
    y: number,
    s: string,
    color: [number, number, number] = INK,
    maxChars?: number
  ): number {
    const clean = sanitize(s);
    const lines = maxChars ? wrapText(clean, maxChars) : clean.split("\n");
    let yy = y;
    for (const ln of lines) {
      page.drawText(ln, { x, y: yy, size, font: f, color });
      push(ln);
      yy -= size + 2;
    }
    return yy;
  }

  function newPage(): PDFPage {
    const p = doc.addPage([PAGE_W, PAGE_H]);
    return p;
  }

  // ---- page 1: title + meta + executive summary + disclaimer ---------------
  let page = newPage();
  let y = PAGE_H - MARGIN;

  y = drawText(page, bold, 20, MARGIN, y, "ClimaScope Climate Risk Area Report", INK);
  y -= 4;
  y = drawText(page, font, 10, MARGIN, y, "Model v1 — heuristic estimates from public hazard layers (formula maxmean-v1)", MUTED);
  y -= 10;
  page.drawRectangle({ x: MARGIN, y, width: CONTENT_W, height: 1.2, color: TEAL });
  y -= 16;

  function meta(label: string, value: string) {
    // eslint-disable-next-line prefer-const
    let yy = y;
    drawText(page, bold, 9.5, MARGIN, yy, label, MUTED);
    yy = drawText(page, font, 10, MARGIN + 130, yy, value);
    y = yy - 2;
  }

  meta("Area", area.name ?? "—");
  meta("Centroid", `${(area.center_lat ?? 0).toFixed(4)}, ${(area.center_lng ?? 0).toFixed(4)}`);
  meta("Radius", `${area.radius_km ?? 0} km`);
  meta("Climate type", area.climate_type ?? "—");
  meta("Analysis id", `#${input.analysis.id}`);
  meta("Run date", `${(input.analysis.completed_at ?? input.analysis.created_at).slice(0, 16).replace("T", " ")} UTC`);
  y -= 6;

  const statuses = (summary.statuses ?? {}) as Record<string, { scored: number; not_assessed: number; low_confidence: number }>;
  const anyNotAssessed = Object.values(statuses).some((s) => s?.not_assessed > 0);
  const anyLowConf = Object.values(statuses).some((s) => s?.low_confidence > 0);
  if (isDemo || anyNotAssessed || anyLowConf) {
    y -= 2;
    const tag = isDemo ? "Demo — public data only" : "Some dimensions are not assessed or low confidence — see layer table";
    page.drawRectangle({ x: MARGIN, y: y - 6, width: drawTextWidth(bold, 9, tag) + 14, height: 16, color: rgb(0.96, 0.96, 0.93) });
    y = drawText(page, bold, 9, MARGIN + 7, y - 10, tag, rgb(0.55, 0.44, 0.1));
    y -= 6;
  }

  // Executive summary block
  y -= 6;
  drawText(page, bold, 12, MARGIN, y, "Executive summary", INK);
  y -= 20;
  page.drawRectangle({ x: MARGIN, y: y - 54, width: CONTENT_W, height: 54, color: rgb(0.975, 0.98, 0.98) });
  const kpis: [string, string][] = [
    ["Area risk average", `${num(summary.area_average)} / 5`],
    ["High + very-high", `${num(summary.pct_high_vhigh, 1)}% of scored structures`],
    ["Dominant hazard", HID_LABELS[(summary.dominant_hazard_area as string) ?? ""] ?? (summary.dominant_hazard_area as string) ?? "—"],
    ["Structures scored", scored.toLocaleString()],
  ];
  const colW = CONTENT_W / 4;
  kpis.forEach(([k, v], i) => {
    const x = MARGIN + i * colW + 12;
    drawText(page, font, 8, x, y - 6, k.toUpperCase(), MUTED);
    drawText(page, bold, 12, x, y - 26, v, INK, 26);
  });
  y -= 64;

  // Disclaimer (verbatim §5)
  y -= 10;
  drawText(page, bold, 10, MARGIN, y, "Important disclaimer", INK);
  y -= 14;
  for (const ln of wrapText(REPORT_DISCLAIMER, 96)) {
    y = drawText(page, font, 9.5, MARGIN, y, ln, MUTED);
    y -= 2;
  }

  // Banner from §6.2 + scale note
  y -= 8;
  page.drawRectangle({ x: MARGIN, y: y + 2, width: CONTENT_W, height: 18, color: rgb(0.95, 0.975, 0.975) });
  y = drawText(page, font, 9, MARGIN + 6, y - 4, "Indicative model estimates from public data — see the layer table and provenance page for sources and limits.", TEAL);

  // ---- page 2: per-layer table --------------------------------------------
  page = newPage();
  y = PAGE_H - MARGIN;
  drawText(page, bold, 16, MARGIN, y, "Hazard layers", INK);
  y -= 6;
  drawText(page, font, 9.5, MARGIN, y, "Dataset, resolution, reference period and licence per scored hazard dimension.", MUTED);
  y -= 18;

  const hazards = Object.entries(input.hazards) as [string, Record<string, unknown>][];
  if (hazards.length === 0) {
    y = drawText(page, font, 10, MARGIN, y, "No hazard dimension was scored for this analysis.", MUTED);
  }
  for (const [hid, meta] of hazards) {
    const label = HID_LABELS[hid] ?? hid;
    const ds = sanitize(String(meta?.dataset ?? "unknown dataset"));
    const attrib = sanitize(String(meta?.attribution ?? "attribution n/a"));
    const res = meta?.resolution_km != null ? `~${meta.resolution_km} km` : "n/a";
    const ref = REFERENCE_PERIODS[hid] ?? "—";
    const reqLabel = REQUIRED_LABELS[hid] ?? "";
    const status = sanitize(String(meta?.status ?? ""));

    // header strip
    drawText(page, bold, 10, MARGIN, y, label, INK);
    if (status) {
      const stTag = status === "scored" ? "scored" : status;
      drawText(page, font, 8, MARGIN + 90, y + 2, `[${stTag}]`, MUTED);
    }
    y -= 15;
    const rows: [string, string][] = [
      ["Dataset", ds],
      ["Resolution", res],
      ["Reference / return period", ref],
      ["Licence attribution", attrib],
      ["Required label (spec §4)", reqLabel],
    ];
    for (const [k, v] of rows) {
      drawText(page, bold, 8.5, MARGIN + 12, y, k, MUTED);
      if (v) {
        const maxChars = 78;
        const lines = wrapText(v, maxChars);
        let yy = y;
        yy = drawText(page, font, 8.5, MARGIN + 118, yy, lines[0] ?? "", INK, maxChars);
        for (let i = 1; i < lines.length; i++) yy = drawText(page, font, 8.5, MARGIN + 118, yy, lines[i], INK, maxChars);
        y = Math.min(y, yy) - 2;
      } else {
        y -= 12;
      }
      y -= 2;
    }
    page.drawRectangle({ x: MARGIN, y: y, width: CONTENT_W, height: 0.6, color: RULE });
    y -= 14;
    if (y < 90) {
      page = newPage();
      y = PAGE_H - MARGIN;
    }
  }

  // ---- page 3: top-risk structures ----------------------------------------
  page = newPage();
  y = PAGE_H - MARGIN;
  drawText(page, bold, 16, MARGIN, y, "Top-risk structures", INK);
  y -= 6;
  drawText(page, font, 9.5, MARGIN, y, `The ${Math.min(10, input.topStructures.length)} structures with the highest overall risk score R_i (1–5, higher = greater exposure).`, MUTED);
  y -= 16;

  // header
  const hazardCols = hazards.map(([h]) => h);
  drawText(page, bold, 7.5, MARGIN, y, "#", MUTED);
  drawText(page, bold, 7.5, MARGIN + 24, y, "LAT, LON", MUTED);
  drawText(page, bold, 7.5, MARGIN + 118, y, "Ri", MUTED);
  let hx = MARGIN + 150;
  for (const h of hazardCols.slice(0, 6)) {
    drawText(page, bold, 7, hx, y, HID_LABELS[h]?.split(" ")[0] ?? h, MUTED, 9);
    hx += 34;
  }
  y -= 4;
  page.drawRectangle({ x: MARGIN, y, width: CONTENT_W, height: 0.6, color: RULE });
  y -= 12;

  for (const s of input.topStructures) {
    drawText(page, font, 8.5, MARGIN, y, `#${s.structure_id}`, MUTED);
    drawText(page, font, 8.5, MARGIN + 24, y, `${s.lat.toFixed(4)}, ${s.lng.toFixed(4)}`, INK); // lat/lon
    drawText(page, bold, 9, MARGIN + 118, y, `${s.overall_score}`, INK);
    let xx = MARGIN + 150;
    for (const h of hazardCols.slice(0, 6)) {
      const v = s.hazard_scores?.[h];
      drawText(page, font, 8, xx, y + 1, v != null ? String(v) : "—", v != null ? INK : MUTED);
      xx += 34;
    }
    y -= 14;
    if (y < 80) {
      page = newPage();
      y = PAGE_H - MARGIN;
      drawText(page, bold, 16, MARGIN, y, "Top-risk structures (cont.)", INK);
      y -= 16;
    }
  }
  if (input.topStructures.length === 0) {
    drawText(page, font, 10, MARGIN, y, "No scored structures to list.", MUTED);
  }

  // ---- page 4: provenance JSON verbatim ------------------------------------
  page = newPage();
  y = PAGE_H - MARGIN;
  drawText(page, bold, 16, MARGIN, y, "Data provenance", INK);
  y -= 6;
  drawText(page, font, 9.5, MARGIN, y, "Per-hazard source metadata exactly as stored with the analysis (same object served by the sources endpoint).", MUTED);
  y -= 16;
  const prov = JSON.stringify({ climate_type: input.analysis.climate_type, model_version: input.analysis.params ? (parseJsonSafe<{ model_version?: string }>(input.analysis.params)?.model_version ?? "maxmean-v1") : "maxmean-v1", hazards: input.hazards }, null, 2);
  for (const ln of prov.split("\n")) {
    const clean = sanitize(ln.length > 0 ? ln : "\u00A0");
    const chunks = wrapText(clean, 104);
    for (const c of chunks) {
      if (y < 60) {
        page = newPage();
        y = PAGE_H - MARGIN;
      }
      page.drawText(c, { x: MARGIN, y, size: 8, font: mono, color: INK });
      push(c);
      y -= 10.5;
    }
  }

  // footers
  const total = doc.getPageCount();
  for (let i = 0; i < total; i++) {
    const p = doc.getPage(i);
    p.drawText(`ClimaScope — Model v1 heuristic estimates (maxmean-v1) · page ${i + 1} of ${total}`, {
      x: MARGIN, y: 30, size: 8, font, color: MUTED,
    });
  }

  const bytes = await doc.save();
  return { bytes, text: texts.join("\n") };
}

function drawTextWidth(f: PDFFont, size: number, s: string): number {
  return f.widthOfTextAtSize(sanitize(s), size);
}

/** Load report input rows from the DB for an analysis (used by the endpoint). */
export function loadReportData(area: AreaRow, analysis: AnalysisRow): ReportInput {
  const summary = parseJsonSafe<Record<string, unknown>>(analysis.summary) ?? {};
  const hazards = mergedHazardSources(analysis.id);
  const top = db
    .query<
      {
        structure_id: number;
        centroid_lat: number;
        centroid_lon: number;
        overall_score: number;
        risk_category: string;
        blend: number;
        dominant_hazard: string | null;
        hazard_scores: string | null;
      },
      [number]
    >(
      `SELECT sc.structure_id, s.centroid_lat, s.centroid_lon, sc.overall_score,
              sc.risk_category, sc.blend, sc.dominant_hazard, sc.hazard_scores
       FROM structure_scores sc JOIN structures s ON s.id = sc.structure_id
       WHERE sc.analysis_id = ?
       ORDER BY sc.overall_score DESC, sc.blend DESC
       LIMIT 10`
    )
    .all(analysis.id);
  return {
    area,
    analysis,
    summary,
    hazards,
    topStructures: top.map((t) => ({
      structure_id: t.structure_id,
      lat: t.centroid_lat,
      lng: t.centroid_lon,
      overall_score: t.overall_score,
      risk_category: RISK_CATEGORIES[Math.max(0, Math.min(4, t.overall_score - 1))] ?? t.risk_category,
      blend: t.blend,
      dominant_hazard: t.dominant_hazard,
      hazard_scores: parseJsonSafe<Record<string, number>>(t.hazard_scores) ?? {},
    })),
  };
}