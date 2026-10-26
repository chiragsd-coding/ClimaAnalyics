/**
 * Per-area rooftop-level PDF risk report (backlog b4580d9e).
 *
 * Builds a risk analytics PDF for an AREA from its most recent completed
 * analysis, with a dedicated rooftop-level visualization page: every structure
 * in the area is drawn individually (OSM footprint polygon where ingested,
 * else a centroid marker sized by footprint area when known, else uniform)
 * and filled with the same risk-band colour the results UI uses.
 *
 * Honesty rules (normative, mirror src/lib/report.ts):
 *  - Structures WITHOUT a score are drawn neutral grey, counted as
 *    "not assessed", and never given an invented number.
 *  - Everything is a model estimate — the page-1 disclaimer (REPORT_DISCLAIMER)
 *    is verbatim, and the projection is labelled on the map page.
 *  - Band labels are owner-pinned verbatim: 1 Very Low, 2 Low, 3 Moderate,
 *    4 High, 5 Very High.
 */
import { PDFDocument, PDFFont, PDFPage, rgb, StandardFonts } from "pdf-lib";
import { db, parseJsonSafe, type AnalysisRow, type AreaRow } from "~/lib/db";
import {
  drawTextWidth,
  INK,
  MARGIN,
  MUTED,
  PAGE_H,
  PAGE_W,
  REPORT_DISCLAIMER,
  RULE,
  sanitize,
  TEAL,
  wrapText,
} from "~/lib/report";

// ---------------------------------------------------------------------------
// Owner-pinned band labels + result-UI band colours
// ---------------------------------------------------------------------------

/** Owner-pinned labels for composite scores 1–5 (EXACT strings, verbatim). */
export const BAND_LABELS = ["Very Low", "Low", "Moderate", "High", "Very High"] as const;

/**
 * Band colours — keep in sync with RISK_COLORS in src/components/AreaMap.tsx
 * (the results UI map/table uses these exact values; duplicated here because
 * AreaMap is a client/Leaflet component that must not be imported server-side).
 */
export const BAND_HEX = ["#15803d", "#65a30d", "#d97706", "#ea580c", "#dc2626"] as const;

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Band colours as pdf-lib RGB, index = score - 1. */
export const BAND_COLORS = BAND_HEX.map(hexToRgb);

/** Neutral grey for structures without a score (never an invented number). */
export const NEUTRAL: [number, number, number] = [0.78, 0.8, 0.83];

export const NOT_ASSESSED_LABEL = "Not assessed";

/** `"3 Moderate"` — numeric score + owner-pinned label together. */
export function bandLabel(score: number): string {
  return `${score} ${BAND_LABELS[Math.max(0, Math.min(4, score - 1))]}`;
}

/** Nearest band label for a fractional average (rounds to 1–5). */
export function nearestBandLabel(avg: number): string {
  const s = Math.max(1, Math.min(5, Math.round(avg)));
  return `${BAND_LABELS[s - 1]} (${s})`;
}

// ---------------------------------------------------------------------------
// Data selection
// ---------------------------------------------------------------------------

export type AreaBuilding = {
  structureId: number;
  lat: number;
  lng: number;
  /** OSM footprint ring(s) as [lat, lon][] — null when not ingested. */
  footprint: [number, number][] | null;
  /** Footprint area in m² from props — null when unknown. */
  areaM2: number | null;
  /** Composite score 1–5, or null when the structure was not scored. */
  score: number | null;
};

export type AreaTopStructure = {
  structureId: number;
  lat: number;
  lng: number;
  score: number;
  dominantHazard: string | null;
  hazardScores: Record<string, number>;
};

export type AreaReportData = {
  area: AreaRow;
  analysis: AnalysisRow;
  generatedAt: string;
  buildings: AreaBuilding[];
  scoredCount: number;
  notAssessedCount: number;
  /** Count per band, index 0 = score 1 … index 4 = score 5. */
  distribution: number[];
  areaAverage: number | null;
  /** Merged per-hazard source metadata (same object the /sources endpoint serves). */
  hazards: Record<string, unknown>;
  topStructures: AreaTopStructure[];
};

/**
 * Pick the LATEST completed analysis for the area (created_at DESC, id DESC
 * tiebreak) with all of the area's structures joined to its scores. Structures
 * without a score row stay in the list with score = null (drawn grey, counted
 * not-assessed — never invented). Returns null when no completed analysis
 * exists (the endpoint turns that into the usual 404 JSON).
 */
export function loadAreaReportData(area: AreaRow): AreaReportData | null {
  const analysis = db
    .query<AnalysisRow, [number]>(
      `SELECT * FROM analyses
       WHERE area_id = ? AND status = 'complete'
       ORDER BY created_at DESC, id DESC
       LIMIT 1`
    )
    .get(area.id);
  if (!analysis) return null;

  const rows = db
    .query<
      {
        id: number;
        centroid_lat: number;
        centroid_lon: number;
        footprint: string | null;
        props: string | null;
        overall_score: number | null;
      },
      [number, number]
    >(
      `SELECT s.id, s.centroid_lat, s.centroid_lon, s.footprint, s.props, sc.overall_score
       FROM structures s
       LEFT JOIN structure_scores sc ON sc.structure_id = s.id AND sc.analysis_id = ?
       WHERE s.area_id = ?
       ORDER BY s.id`
    )
    .all(analysis.id, area.id);

  const buildings: AreaBuilding[] = rows.map((r) => {
    const props = parseJsonSafe<Record<string, unknown>>(r.props);
    const areaM2 = typeof props?.area_m2 === "number" ? (props.area_m2 as number) : null;
    const fp = parseJsonSafe<[number, number][]>(r.footprint);
    return {
      structureId: r.id,
      lat: r.centroid_lat,
      lng: r.centroid_lon,
      footprint: Array.isArray(fp) && fp.length >= 3 ? fp : null,
      areaM2,
      score: typeof r.overall_score === "number" ? r.overall_score : null,
    };
  });

  const distribution = [0, 0, 0, 0, 0];
  let scoredCount = 0;
  let sum = 0;
  for (const b of buildings) {
    if (b.score != null) {
      distribution[b.score - 1] += 1;
      scoredCount += 1;
      sum += b.score;
    }
  }

  const summary = parseJsonSafe<Record<string, unknown>>(analysis.summary) ?? {};
  const areaAverage =
    typeof summary.area_average === "number"
      ? summary.area_average
      : scoredCount > 0
        ? Math.round((100 * sum) / scoredCount) / 100
        : null;

  // Top-risk structures (highest composite first) with per-hazard breakdown.
  const top = db
    .query<
      {
        structure_id: number;
        centroid_lat: number;
        centroid_lon: number;
        overall_score: number;
        dominant_hazard: string | null;
        hazard_scores: string | null;
      },
      [number]
    >(
      `SELECT sc.structure_id, s.centroid_lat, s.centroid_lon, sc.overall_score,
              sc.dominant_hazard, sc.hazard_scores
       FROM structure_scores sc JOIN structures s ON s.id = sc.structure_id
       WHERE sc.analysis_id = ?
       ORDER BY sc.overall_score DESC, s.id ASC
       LIMIT 10`
    )
    .all(analysis.id);

  // Merged per-hazard provenance — same dedupe rule as mergedHazardSources in
  // src/lib/report.ts: per-structure source metadata is uniform per hazard.
  const hazards: Record<string, unknown> = {};
  const srcRows = db
    .query<{ sources: string | null }, [number]>(
      "SELECT sources FROM structure_scores WHERE analysis_id = ? LIMIT 25"
    )
    .all(analysis.id);
  for (const r of srcRows) {
    const s = parseJsonSafe<{ hazards?: Record<string, unknown> }>(r.sources);
    for (const [hid, meta] of Object.entries(s?.hazards ?? {})) {
      if (!(hid in hazards)) hazards[hid] = meta;
    }
  }

  return {
    area,
    analysis,
    generatedAt: new Date().toISOString(),
    buildings,
    scoredCount,
    notAssessedCount: buildings.length - scoredCount,
    distribution,
    areaAverage,
    hazards,
    topStructures: top.map((t) => ({
      structureId: t.structure_id,
      lat: t.centroid_lat,
      lng: t.centroid_lon,
      score: t.overall_score,
      dominantHazard: t.dominant_hazard,
      hazardScores: parseJsonSafe<Record<string, number>>(t.hazard_scores) ?? {},
    })),
  };
}

// ---------------------------------------------------------------------------
// Rooftop-level projection (local equirectangular around the area centre)
// ---------------------------------------------------------------------------

const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LON = 111320;

/** Equirectangular metres east/north around (lat0, lng0). Aspect true. */
function project(lat: number, lng: number, lat0: number, lng0: number, cosLat0: number): [number, number] {
  const mx = (lng - lng0) * M_PER_DEG_LON * cosLat0;
  const my = (lat - lat0) * M_PER_DEG_LAT;
  return [mx, my];
}

/** Pick a "nice" scale-bar length (1/2/5 × 10^m) closest under target metres. */
function niceScaleBarMeters(targetM: number): number {
  const pow = Math.pow(10, Math.floor(Math.log10(targetM)));
  for (const k of [5, 2, 1]) {
    const v = k * pow;
    if (v <= targetM) return v;
  }
  return pow;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

const MAP_H = 470; // rooftop plot height on page 2
const PAD = 18;

export type AreaReportStats = {
  /** Buildings actually painted (polygons or markers) — one fill each. */
  fills: number;
  polygonBuildings: number;
  markerBuildings: number;
};

export type AreaReportResult = {
  bytes: Uint8Array;
  text: string;
  stats: AreaReportStats;
};

export async function buildAreaReportPdf(data: AreaReportData): Promise<AreaReportResult> {
  const texts: string[] = [];
  const push = (s: string) => texts.push(s);

  const doc = await PDFDocument.create();
  const font = await doc.embedStandardFont(StandardFonts.Helvetica);
  const bold = await doc.embedStandardFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedStandardFont(StandardFonts.Courier);

  const area = data.area;
  const analysis = data.analysis;
  const CONTENT_W = PAGE_W - MARGIN * 2;
  const total = data.buildings.length;
  const bandColor = (score: number | null) =>
    score == null ? rgb(...NEUTRAL) : rgb(...BAND_COLORS[score - 1]);

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
    push(clean);
    let yy = y;
    for (const ln of lines) {
      page.drawText(ln, { x, y: yy, size, font: f, color });
      push(ln);
      yy -= size + 2;
    }
    return yy;
  }

  // ---- page 1: summary, band distribution, average, disclaimer -------------
  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  y = drawText(page, bold, 20, MARGIN, y, "ClimaScope Climate Risk Area Report", INK);
  y -= 4;
  y = drawText(page, font, 10, MARGIN, y, "Rooftop-level composite risk, every building scored 1–5 — Model v1 heuristic estimates (maxmean-v1)", MUTED);
  y -= 10;
  page.drawRectangle({ x: MARGIN, y, width: CONTENT_W, height: 1.2, color: TEAL });
  y -= 16;

  function meta(label: string, value: string) {
    let yy = y;
    drawText(page, bold, 9.5, MARGIN, yy, label, MUTED);
    yy = drawText(page, font, 10, MARGIN + 130, yy, value);
    y = yy - 2;
  }

  meta("Area", area.name ?? "—");
  meta("Centroid", `${(area.center_lat ?? 0).toFixed(4)}, ${(area.center_lng ?? 0).toFixed(4)}`);
  meta("Radius", `${area.radius_km ?? 0} km`);
  meta("Climate type", area.climate_type ?? "—");
  meta("Source analysis", `#${analysis.id} (latest completed)`);
  meta("Generated at", `${data.generatedAt.slice(0, 16).replace("T", " ")} UTC`);
  meta("Buildings", `${total.toLocaleString()} — scored ${data.scoredCount.toLocaleString()}, ${NOT_ASSESSED_LABEL.toLowerCase()} ${data.notAssessedCount.toLocaleString()}`);
  y -= 8;

  // Band distribution table — owner-pinned labels + result-UI band colours.
  drawText(page, bold, 12, MARGIN, y, "Risk band distribution", INK);
  y -= 16;
  const colBand = MARGIN;
  const colCount = MARGIN + 200;
  const colShare = MARGIN + 290;
  drawText(page, bold, 8.5, colBand, y, "BAND", MUTED);
  drawText(page, bold, 8.5, colCount, y, "BUILDINGS", MUTED);
  drawText(page, bold, 8.5, colShare, y, "SHARE", MUTED);
  y -= 4;
  page.drawRectangle({ x: MARGIN, y, width: CONTENT_W, height: 0.6, color: RULE });
  y -= 13;
  for (let score = 1; score <= 5; score++) {
    const count = data.distribution[score - 1];
    page.drawRectangle({ x: colBand, y: y - 1, width: 26, height: 8, color: rgb(...BAND_COLORS[score - 1]) });
    drawText(page, font, 9.5, colBand + 32, y, bandLabel(score), INK);
    drawText(page, bold, 9.5, colCount, y, count.toLocaleString(), INK);
    drawText(page, font, 9.5, colShare, y, total > 0 ? `${((100 * count) / total).toFixed(1)}%` : "—", MUTED);
    y -= 14;
  }
  // not-assessed row (always stated, even when zero)
  page.drawRectangle({ x: colBand, y: y - 1, width: 26, height: 8, color: rgb(...NEUTRAL) });
  drawText(page, font, 9.5, colBand + 32, y, `${NOT_ASSESSED_LABEL} — no score in this analysis`, INK);
  drawText(page, bold, 9.5, colCount, y, data.notAssessedCount.toLocaleString(), INK);
  drawText(page, font, 9.5, colShare, y, total > 0 ? `${((100 * data.notAssessedCount) / total).toFixed(1)}%` : "—", MUTED);
  y -= 20;

  // Area average — numeric + nearest owner-pinned label together.
  if (data.areaAverage != null) {
    const avgLine = `Area risk average: ${data.areaAverage.toFixed(2)} / 5 — nearest band ${nearestBandLabel(data.areaAverage)}`;
    page.drawRectangle({ x: MARGIN, y: y - 12, width: CONTENT_W, height: 18, color: rgb(0.975, 0.98, 0.98) });
    y = drawText(page, bold, 10, MARGIN + 8, y - 8, avgLine, INK);
  } else {
    y = drawText(page, font, 10, MARGIN, y, "Area risk average: — (no scored structures in this analysis)", MUTED);
  }
  y -= 14;

  // Disclaimer — verbatim §5 text from src/lib/report.ts.
  drawText(page, bold, 10, MARGIN, y, "Important disclaimer", INK);
  y -= 14;
  for (const ln of wrapText(REPORT_DISCLAIMER, 96)) {
    y = drawText(page, font, 9.5, MARGIN, y, ln, MUTED);
    y -= 2;
  }
  y -= 8;
  page.drawRectangle({ x: MARGIN, y: y + 2, width: CONTENT_W, height: 18, color: rgb(0.95, 0.975, 0.975) });
  y = drawText(page, font, 9, MARGIN + 6, y - 4, "Model estimates only — see the rooftop-level map page and top-risk table for what is and is not assessed.", TEAL);

  // ---- page 2: rooftop-level visualization ---------------------------------
  page = doc.addPage([PAGE_W, PAGE_H]);
  y = PAGE_H - MARGIN;
  y = drawText(page, bold, 16, MARGIN, y, "Rooftop-level risk map", INK);
  y -= 6;
  y = drawText(page, font, 9.5, MARGIN, y, `Every building in the area as scored in analysis #${analysis.id} — composite risk band 1–5.`, MUTED);
  y -= 8;

  const mapTop = y - 4;
  const mapBottom = mapTop - MAP_H;

  // Content bounds in metres: the radius ring must fit, buildings may hug an edge.
  const lat0 = area.center_lat;
  const lng0 = area.center_lng;
  const cosLat0 = Math.max(0.01, Math.cos((lat0 * Math.PI) / 180));
  const R = (area.radius_km ?? 0) * 1000;
  let minX = -R, maxX = R, minY = -R, maxY = R;
  const projected: { b: AreaBuilding; mx: number; my: number }[] = [];
  for (const b of data.buildings) {
    const [mx, my] = project(b.lat, b.lng, lat0, lng0, cosLat0);
    projected.push({ b, mx, my });
    if (mx < minX) minX = mx;
    if (mx > maxX) maxX = mx;
    if (my < minY) minY = my;
    if (my > maxY) maxY = my;
  }
  const wM = Math.max(1, maxX - minX);
  const hM = Math.max(1, maxY - minY);
  const s = Math.min((CONTENT_W - PAD * 2) / wM, (MAP_H - PAD * 2) / hM);
  const ox = MARGIN + (CONTENT_W - wM * s) / 2;
  const oy = mapBottom + (MAP_H - hM * s) / 2;
  const px = (mx: number) => ox + (mx - minX) * s;
  const py = (my: number) => oy + (my - minY) * s;
  const svgY = (my: number) => PAGE_H - py(my); // drawSvgPath is y-down from page top

  const stats: AreaReportStats = { fills: 0, polygonBuildings: 0, markerBuildings: 0 };

  // plot frame
  page.drawRectangle({
    x: MARGIN, y: mapBottom, width: CONTENT_W, height: MAP_H,
    borderColor: RULE, borderWidth: 0.8, color: rgb(0.985, 0.985, 0.98),
  });

  // radius ring + centre marker (drawn under buildings)
  page.drawEllipse({
    x: px(0), y: py(0), xScale: R * s, yScale: R * s,
    borderColor: MUTED, borderWidth: 1, borderDashArray: [4, 4],
  });
  page.drawEllipse({ x: px(0), y: py(0), xScale: 2.2, yScale: 2.2, color: INK });
  drawText(page, font, 7.5, px(0) + 5, py(0) - 3, "Area centre", MUTED);

  // buildings — polygon when a footprint exists, else a marker
  for (const { b, mx, my } of projected) {
    const fill = bandColor(b.score);
    const x0 = px(mx);
    const y0 = py(my);
    if (b.footprint) {
      // Ring in page units, then SVG y-down coordinates for drawSvgPath
      // (anchored at page bottom-left (0,0): svgY = PAGE_H - pageY).
      const pts = b.footprint.map(([plat, plng]) => {
        const [p, q] = project(plat, plng, lat0, lng0, cosLat0);
        return `${(px(p) - 0).toFixed(2)} ${svgY(q).toFixed(2)}`;
      });
      page.drawSvgPath(`M ${pts.join(" L ")} Z`, {
        x: 0, y: 0, color: fill, borderColor: INK, borderWidth: 0.3,
      });
      stats.fills += 1;
      stats.polygonBuildings += 1;
    } else {
      const w = b.areaM2 != null ? Math.max(1.6, Math.min(16, 2 * Math.sqrt(b.areaM2) * s)) : 3;
      page.drawRectangle({
        x: x0 - w / 2, y: y0 - w / 2, width: w, height: w,
        color: fill, borderColor: INK, borderWidth: 0.3,
      });
      stats.fills += 1;
      stats.markerBuildings += 1;
    }
  }

  // north arrow (top-right of the plot)
  const nx = MARGIN + CONTENT_W - 24;
  const nBase = mapTop - 34;
  page.drawLine({ start: { x: nx, y: nBase }, end: { x: nx, y: nBase + 22 }, color: INK, lineWidth: 1.2 });
  page.drawLine({ start: { x: nx, y: nBase + 22 }, end: { x: nx - 4, y: nBase + 14 }, color: INK, lineWidth: 1 });
  page.drawLine({ start: { x: nx, y: nBase + 22 }, end: { x: nx + 4, y: nBase + 14 }, color: INK, lineWidth: 1 });
  drawText(page, bold, 9, nx - 3, nBase + 28, "N", INK);

  // scale bar (bottom-left of the plot)
  const barPx = (CONTENT_W - PAD * 2) / 5;
  const barM = niceScaleBarMeters(barPx / s);
  const barLen = barM * s;
  const bx = MARGIN + 16;
  const by = mapBottom + 14;
  page.drawLine({ start: { x: bx, y: by }, end: { x: bx + barLen, y: by }, color: INK, lineWidth: 1.2 });
  page.drawLine({ start: { x: bx, y: by - 3 }, end: { x: bx, y: by + 3 }, color: INK, lineWidth: 1 });
  page.drawLine({ start: { x: bx + barLen, y: by - 3 }, end: { x: bx + barLen, y: by + 3 }, color: INK, lineWidth: 1 });
  drawText(page, font, 8, bx + barLen / 2 - 12, by + 6, barM >= 1000 ? `${barM / 1000} km` : `${barM} m`, INK);

  // legend — owner-pinned labels verbatim + not-assessed
  y = mapBottom - 20;
  drawText(page, bold, 9, MARGIN, y, "Legend (composite risk band):", INK);
  const legendItems: { color: [number, number, number]; label: string }[] = [
    ...BAND_COLORS.map((c, i) => ({ color: c as [number, number, number], label: `${i + 1} ${BAND_LABELS[i]}` })),
    { color: NEUTRAL, label: NOT_ASSESSED_LABEL },
  ];
  let lx = MARGIN;
  const ly = y - 14;
  for (const item of legendItems) {
    page.drawRectangle({ x: lx, y: ly - 1.5, width: 10, height: 8, color: rgb(...item.color), borderColor: INK, borderWidth: 0.3 });
    drawText(page, font, 8.5, lx + 14, ly, item.label, INK);
    lx += 26 + drawTextWidth(font, 8.5, item.label) + 12;
  }
  y = ly - 16;

  // caption — states exactly what is drawn, including the not-assessed count
  const caption = `Each shape = one building, filled by composite risk band 1–5 (grey = ${NOT_ASSESSED_LABEL.toLowerCase()}, count ${data.notAssessedCount.toLocaleString()}). Footprint polygons are OSM building outlines; buildings without a stored footprint are drawn as area-scaled squares at their centroid. ${stats.markerBuildings > 0 ? `${stats.markerBuildings.toLocaleString()} buildings had no footprint polygon and are drawn as markers.` : ""} Buildings without a score are drawn in neutral grey and counted as ${NOT_ASSESSED_LABEL.toLowerCase()} — no scores are invented.`;
  for (const ln of wrapText(caption, 108)) {
    y = drawText(page, font, 8.5, MARGIN, y, ln, MUTED);
    y -= 1;
  }
  y -= 3;
  drawText(page, font, 8.5, MARGIN, y, "Projection: equirectangular around the area centre (x = dLon x cos(lat0), y = dLat, in metres); aspect ratio true. Scale approximate.", MUTED);

  // ---- page 3: top-risk structures -----------------------------------------
  page = doc.addPage([PAGE_W, PAGE_H]);
  y = PAGE_H - MARGIN;
  drawText(page, bold, 16, MARGIN, y, "Top-risk structures", INK);
  y -= 6;
  drawText(page, font, 9.5, MARGIN, y, `The ${Math.min(10, data.topStructures.length)} structures with the highest composite score (1–5, higher = greater exposure).`, MUTED);
  y -= 16;

  const hazardCols = Object.keys(data.hazards).slice(0, 6);
  drawText(page, bold, 7.5, MARGIN, y, "#", MUTED);
  drawText(page, bold, 7.5, MARGIN + 24, y, "LAT, LON", MUTED);
  drawText(page, bold, 7.5, MARGIN + 118, y, "SCORE", MUTED);
  let hx = MARGIN + 176;
  for (const h of hazardCols) {
    drawText(page, bold, 7, hx, y, h.replace(/_/g, " ").slice(0, 11), MUTED);
    hx += 52;
  }
  y -= 4;
  page.drawRectangle({ x: MARGIN, y, width: CONTENT_W, height: 0.6, color: RULE });
  y -= 12;

  for (const t of data.topStructures) {
    drawText(page, font, 8.5, MARGIN, y, `#${t.structureId}`, MUTED);
    drawText(page, font, 8.5, MARGIN + 24, y, `${t.lat.toFixed(4)}, ${t.lng.toFixed(4)}`, INK);
    drawText(page, bold, 9, MARGIN + 118, y, `${t.score} ${BAND_LABELS[t.score - 1]}`, INK);
    let xx = MARGIN + 176;
    for (const h of hazardCols) {
      const v = t.hazardScores[h];
      drawText(page, font, 8, xx, y + 1, v != null ? String(v) : "—", v != null ? INK : MUTED);
      xx += 52;
    }
    y -= 14;
    if (y < 80) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;
      drawText(page, bold, 16, MARGIN, y, "Top-risk structures (cont.)", INK);
      y -= 16;
    }
  }
  if (data.topStructures.length === 0) {
    drawText(page, font, 10, MARGIN, y, "No scored structures to list.", MUTED);
  }
  y -= 18;
  for (const ln of wrapText("Per-hazard column values are per-hazard model estimates (1–5) for each structure; composite score = maxmean-v1 combination. Model v1 — heuristic estimates from public hazard layers.", 108)) {
    y = drawText(page, font, 8.5, MARGIN, y, ln, MUTED);
    y -= 1;
  }

  // provenance appendix (verbatim JSON, same style as the per-analysis report)
  page = doc.addPage([PAGE_W, PAGE_H]);
  y = PAGE_H - MARGIN;
  drawText(page, bold, 16, MARGIN, y, "Data provenance", INK);
  y -= 6;
  drawText(page, font, 9.5, MARGIN, y, "Per-hazard source metadata exactly as stored with the analysis (same object served by the sources endpoint).", MUTED);
  y -= 16;
  const modelVersion =
    parseJsonSafe<{ model_version?: string }>(analysis.params)?.model_version ?? "maxmean-v1";
  const prov = JSON.stringify(
    { climate_type: analysis.climate_type, model_version: modelVersion, hazards: data.hazards },
    null,
    2
  );
  for (const ln of prov.split("\n")) {
    const clean = sanitize(ln.length > 0 ? ln : "\u00A0");
    for (const c of wrapText(clean, 104)) {
      if (y < 60) {
        page = doc.addPage([PAGE_W, PAGE_H]);
        y = PAGE_H - MARGIN;
      }
      page.drawText(c, { x: MARGIN, y, size: 8, font: mono, color: INK });
      push(c);
      y -= 10.5;
    }
  }

  // footers
  const pages = doc.getPageCount();
  for (let i = 0; i < pages; i++) {
    const p = doc.getPage(i);
    p.drawText(`ClimaScope — rooftop-level area report (analysis #${analysis.id}) · Model v1 heuristic estimates (maxmean-v1) · page ${i + 1} of ${pages}`, {
      x: MARGIN, y: 30, size: 7.5, font, color: MUTED,
    });
  }

  const bytes = await doc.save();
  return { bytes, text: texts.join("\n"), stats };
}
