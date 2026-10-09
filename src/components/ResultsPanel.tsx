import { useEffect, useMemo, useState } from "react";
import { AreaMap, RISK_COLORS, type RiskPoint } from "~/components/AreaMap";
import { Alert, RiskBadge, Spinner } from "~/components/ui";
import { climateByValue } from "~/lib/climates";
import type { AreaPublic } from "~/lib/server/queries";

/** Hazard dimension id (as stored by the engine, uppercase HID) → human label. */
const HID_LABELS: Record<string, string> = {
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
/** climate.hazards values (lowercase, client-side) → engine HID. */
const HID_UPPER: Record<string, string> = {
  flood: "FLOOD",
  cyclone_wind: "CYCLONE_WIND",
  extreme_heat: "EXTREME_HEAT",
  wildfire: "WILDFIRE",
  snow_load: "SNOW_LOAD",
  storm_surge: "STORM_SURGE",
  drought: "DROUGHT",
  hail: "HAIL",
};
const CATEGORIES = ["very_low", "low", "medium", "high", "very_high"];
const PAGE_SIZE = 50;

type Summary = {
  model_version: string;
  climate_type: string;
  scored: number;
  area_average: number;
  pct_high_vhigh: number;
  dominant_hazard_area: string | null;
  distribution: Record<string, number>;
  blend: { min: number; max: number; mean: number };
  statuses: Record<string, { scored: number; not_assessed: number; low_confidence: number }>;
  reference_periods: Record<string, string>;
};
type AnalysisListRow = {
  id: number;
  status: string;
  summary: Summary | null;
  created_at: string;
  completed_at: string | null;
};
type ScoreRow = {
  structure_id: number;
  lat: number;
  lng: number;
  overall_score: number;
  risk_category: string;
  blend: number;
  dominant_hazard: string | null;
  hazard_scores: Record<string, number>;
};
type HazardSources = Record<
  string,
  {
    dataset?: string;
    resolution_km?: number | null;
    attribution?: string;
    status?: string;
    note?: string | null;
  }
>;
type SortKey = "structure_id" | "overall_score" | "blend" | "dominant_hazard";

function fmt(n: number | null | undefined, dp = 2): string {
  return n === null || n === undefined || Number.isNaN(n) ? "—" : n.toFixed(dp);
}

export function ResultsPanel({ area, canRun, tier }: { area: AreaPublic; canRun: boolean; tier?: "free" | "pro" | "enterprise" }) {
  const [list, setList] = useState<AnalysisListRow[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [scores, setScores] = useState<ScoreRow[]>([]);
  const [disclaimer, setDisclaimer] = useState("");
  const [sources, setSources] = useState<HazardSources | null>(null);
  const [loading, setLoading] = useState<"list" | "analysis" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("overall_score");
  const [sortDir, setSortDir] = useState<-1 | 1>(-1);
  const [page, setPage] = useState(1);
  const [running, setRunning] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [activeId, setActiveId] = useState<number | null>(null);

  const climate = climateByValue(area.climate_type);
  const hazardCols = useMemo(
    () => (climate?.hazards ?? []).map((h) => HID_UPPER[h]).filter(Boolean),
    [climate],
  );

  async function loadList(): Promise<AnalysisListRow[]> {
    const res = await fetch(`/api/areas/${area.id}/analyses`);
    if (!res.ok) throw new Error(`Could not load analyses (HTTP ${res.status}).`);
    const data = (await res.json()) as { analyses?: AnalysisListRow[] };
    const rows = (data.analyses ?? []).filter((a) => a.status === "complete");
    setList(rows);
    return rows;
  }

  async function openAnalysis(aid: number) {
    const [detRes, scRes] = await Promise.all([
      fetch(`/api/areas/${area.id}/analyses/${aid}`),
      fetch(`/api/areas/${area.id}/analyses/${aid}/scores`),
    ]);
    if (!detRes.ok || !scRes.ok) {
      throw new Error(`Could not load analysis ${aid} (HTTP ${detRes.status}/${scRes.status}).`);
    }
    const det = (await detRes.json()) as { analysis?: { summary: Summary } };
    const scr = (await scRes.json()) as { structures?: ScoreRow[]; disclaimer?: string };
    setSummary(det.analysis?.summary ?? null);
    setScores(scr.structures ?? []);
    setDisclaimer(scr.disclaimer ?? "");
    setPage(1);
    setActiveId(aid);
    fetch(`/api/areas/${area.id}/analyses/${aid}/sources`)
      .then((r) => (r.ok ? (r.json() as Promise<{ hazards?: HazardSources }>) : null))
      .then((d) => setSources(d?.hazards ?? null))
      .catch(() => setSources(null));
  }

  async function downloadReport() {
    if (!activeId || downloading) return;
    setDownloading(true);
    setError(null);
    try {
      const res = await fetch(`/api/areas/${area.id}/analyses/${activeId}/report.pdf`);
      if (!res.ok) {
        const d = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(d?.error ?? `Report download failed (HTTP ${res.status}).`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `climascope-report-area-${area.id}-analysis-${activeId}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Report download failed.");
    } finally {
      setDownloading(false);
    }
  }

  async function runAnalysis() {
    if (!canRun || running) return;
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(`/api/areas/${area.id}/analyses`, { method: "POST" });
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(d.error ?? "Scoring run failed.");
      const rows = await loadList();
      if (rows.length > 0) {
        setLoading("analysis");
        await openAnalysis(rows[0].id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Scoring run failed.");
    } finally {
      setRunning(false);
    }
  }

  // On mount: load the latest saved analysis; run one only if none exists.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setError(null);
      try {
        setLoading("list");
        const rows = await loadList();
        if (cancelled) return;
        if (rows.length > 0) {
          setLoading("analysis");
          await openAnalysis(rows[0].id);
        } else if (canRun) {
          setLoading(null);
          await runAnalysis();
        } else {
          setLoading(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load results.");
      } finally {
        if (!cancelled) setLoading(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [area.id]);

  const sorted = useMemo(() => {
    const dir = sortDir;
    return [...scores].sort((a, b) => {
      const va = a[sortKey];
      const vb = b[sortKey];
      if (typeof va === "number" && typeof vb === "number") return dir * (va - vb);
      const sa = String(va ?? "").toLowerCase();
      const sb = String(vb ?? "").toLowerCase();
      return dir * (sa < sb ? -1 : sa > sb ? 1 : 0);
    });
  }, [scores, sortKey, sortDir]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const pageRows = sorted.slice((page - 1) * PAGE_SIZE, Math.min(page * PAGE_SIZE, sorted.length));
  const points: RiskPoint[] = useMemo(
    () => scores.map((s) => ({ lat: s.lat, lng: s.lng, cat: s.overall_score })),
    [scores],
  );
  const distMax = useMemo(() => {
    let m = 1;
    for (let k = 1; k <= 5; k++) m = Math.max(m, summary?.distribution?.[String(k)] ?? 0);
    return m;
  }, [summary]);

  function sortBy(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === -1 ? 1 : -1));
    else {
      setSortKey(key);
      setSortDir(-1);
    }
  }

  const statusChip = (st?: { scored: number; not_assessed: number; low_confidence: number }) => {
    if (!st) return { tone: "bg-slate-100 text-slate-500 ring-slate-200", label: "n/a" };
    if (st.not_assessed > 0 && st.scored === 0)
      return { tone: "bg-slate-100 text-slate-500 ring-slate-200", label: "Not assessed" };
    if (st.low_confidence > 0)
      return { tone: "bg-amber-50 text-amber-800 ring-amber-200", label: "Low confidence" };
    return { tone: "bg-emerald-50 text-emerald-800 ring-emerald-200", label: "Scored" };
  };

  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <div>
          <h2 className="text-lg font-bold tracking-tight text-slate-900">Risk results</h2>
          <p className="text-xs text-slate-500">
            Model v1 — heuristic estimates from public hazard layers (formula maxmean-v1). Not
            engineering assessments of individual buildings.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canRun && activeId !== null && (
            <button
              type="button"
              onClick={() => void downloadReport()}
              disabled={downloading || loading !== null}
              className="btn-secondary"
            >
              {downloading && <Spinner />}
              {downloading ? "Preparing…" : "Download PDF report"}
            </button>
          )}
          {canRun && (
            <button
              type="button"
              onClick={() => void runAnalysis()}
              disabled={running || loading !== null}
              className="btn-primary"
            >
              {running && <Spinner />}
              {running ? "Running…" : "Re-run analysis"}
            </button>
          )}
        </div>
      </div>

      {list.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-100 px-5 py-2.5">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            Saved analyses
          </span>
          {list.map((a) => {
            const s = a.summary;
            const on = a.id === activeId;
            return (
              <button
                key={a.id}
                type="button"
                disabled={on || loading !== null || running}
                onClick={() => {
                  setLoading("analysis");
                  setError(null);
                  openAnalysis(a.id)
                    .catch((e) => setError(e instanceof Error ? e.message : "Could not load analysis."))
                    .finally(() => setLoading(null));
                }}
                className={`chip rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 ring-inset ${
                  on
                    ? "bg-teal-700 text-white ring-teal-800"
                    : "bg-slate-100 text-slate-600 ring-slate-200 hover:bg-slate-200"
                }`}
              >
                #{a.id} · {s ? fmt(s.area_average) : "no summary"} ·{" "}
                {s?.dominant_hazard_area ? `· ${HID_LABELS[s.dominant_hazard_area] ?? s.dominant_hazard_area}` : ""} ·{" "}
                {a.completed_at ? a.completed_at.slice(0, 10) : "pending"}
              </button>
            );
          })}
        </div>
      )}
      {error && (
        <div className="px-5 py-4">
          <Alert kind="error">{error}</Alert>
        </div>
      )}
      {loading === "list" && (
        <div className="flex items-center gap-2 px-5 py-10 text-sm text-slate-500">
          <Spinner /> Loading saved results…
      </div>
      )}
      {loading === "analysis" && (
        <div className="flex items-center gap-2 px-5 py-10 text-sm text-slate-500">
          <Spinner /> Scoring {area.structures_count.toLocaleString()} structures — a few seconds…
        </div>
      )}
      {!loading && !summary && !error && (
        <div className="px-5 py-6">
          <Alert kind="info">
            No analysis exists for this area yet.{" "}
            {canRun
              ? "Click “Re-run analysis” above to score it."
              : "An admin or analyst needs to run one — viewers cannot run analyses."}
          </Alert>
        </div>
      )}

      {summary && (
        <>
          <div className="grid gap-4 px-5 py-5 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg border border-slate-100 bg-slate-50 p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
                Area risk average
              </p>
              <p className="mt-1 text-2xl font-bold tracking-tight text-slate-900">
                {fmt(summary.area_average)} <span className="text-sm font-medium text-slate-400">/ 5</span>
              </p>
              <div className="mt-2">
                <RiskBadge
                  score={summary.area_average}
                  category={CATEGORIES[Math.max(0, Math.min(4, Math.round(summary.area_average) - 1))]}
                />
              </div>
            </div>
            <div className="rounded-lg border border-slate-100 bg-slate-50 p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
                High + very high
              </p>
              <p className="mt-1 text-2xl font-bold tracking-tight text-slate-900">
                {fmt(summary.pct_high_vhigh, 1)}%
              </p>
              <p className="mt-1 text-xs text-slate-500">of scored structures</p>
            </div>
            <div className="rounded-lg border border-slate-100 bg-slate-50 p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
                Dominant hazard
              </p>
              <p className="mt-1 text-2xl font-bold tracking-tight text-slate-900">
                {HID_LABELS[summary.dominant_hazard_area ?? ""] ?? summary.dominant_hazard_area ?? "—"}
              </p>
              <p className="mt-1 text-xs text-slate-500">most common across structures</p>
            </div>
            <div className="rounded-lg border border-slate-100 bg-slate-50 p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
                Structures scored
              </p>
              <p className="mt-1 text-2xl font-bold tracking-tight text-slate-900">
                {summary.scored.toLocaleString()}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                blend range {fmt(summary.blend.min)}–{fmt(summary.blend.max)}
              </p>
            </div>
          </div>

          <div className="grid gap-4 px-5 pb-5 lg:grid-cols-[minmax(0,1fr)_300px]">
            <AreaMap
              center={{ lat: area.center_lat, lng: area.center_lng }}
              radiusKm={area.radius_km}
              footprints={[]}
              points={points}
              maxPoints={2000}
            />
            <div className="space-y-4">
              <div className="rounded-lg border border-slate-100 p-4">
                <p className="text-xs font-semibold text-slate-900">Risk distribution</p>
                <div className="mt-3 flex items-end gap-2">
                  {[1, 2, 3, 4, 5].map((k) => {
                    const c = summary.distribution?.[String(k)] ?? 0;
                    const h = Math.round((c / distMax) * 80);
                    return (
                      <div key={k} className="flex flex-1 flex-col items-center gap-1">
                        <span className="text-[10px] font-medium text-slate-500">
                          {c.toLocaleString()}
                        </span>
                        <div className="flex h-24 w-full items-end rounded-md bg-slate-100">
                          <div
                            className="w-full rounded-md"
                            style={{ height: `${Math.max(4, h)}%`, backgroundColor: RISK_COLORS[k - 1] }}
                          />
                        </div>
                        <span className="text-[10px] text-slate-400">{k}</span>
                      </div>
                    );
                  })}
                </div>
                <p className="mt-1 text-[10px] text-slate-400">1 = Very Low … 5 = Very High</p>
              </div>
              <div className="rounded-lg border border-slate-100 p-4">
                <p className="text-xs font-semibold text-slate-900">Dimension status</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {Object.entries(summary.statuses).map(([hid, st]) => {
                    const chip = statusChip(st);
                    return (
                      <span
                        key={hid}
                        title={`${HID_LABELS[hid] ?? hid}: scored ${st.scored.toLocaleString()} · not assessed ${st.not_assessed.toLocaleString()} · low confidence ${st.low_confidence.toLocaleString()}${summary.reference_periods?.[hid] ? ` — ${summary.reference_periods[hid]}` : ""}`}
                        className={`chip ring-1 ring-inset ${chip.tone}`}
                      >
                        {HID_LABELS[hid] ?? hid}: {chip.label}
                      </span>
                    );
                  })}
                </div>
                <p className="mt-2 text-[10px] text-slate-400">
                  Low-confidence / not-assessed dimensions use labelled fallbacks or are absent from
                  the per-structure blend — hover a chip for the reference period.
                </p>
              </div>
            </div>
          </div>

          <div className="px-5 pb-5">
            <div className="space-y-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  Structure scores ({scores.length.toLocaleString()})
                </h3>
                <p className="text-xs text-slate-500">
                  Click a column to sort. Per-hazard columns are the area’s climate-type dimensions
                  (1–5 estimates).
                </p>
              </div>
              <div className="overflow-x-auto rounded-lg border border-slate-200">
                <table className="w-full text-left text-xs text-slate-700">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50">
                    {(
                      [
                        { k: "structure_id", l: "Structure" },
                        { k: "overall_score", l: "Risk" },
                        { k: "blend", l: "Blend" },
                        { k: "dominant_hazard", l: "Dominant" },
                      ] as { k: SortKey; l: string }[]
                    ).map((c) => (
                      <th key={c.k} className="px-3 py-2 font-semibold text-slate-600">
                        <button
                          type="button"
                          onClick={() => sortBy(c.k)}
                          className="hover:text-slate-900"
                        >
                          {c.l} {sortKey === c.k ? (sortDir === -1 ? "↓" : "↑") : "↕"}
                        </button>
                      </th>
                    ))}
                    {hazardCols.map((h) => (
                      <th key={h} className="px-3 py-2 text-right font-semibold text-slate-600">
                        {HID_LABELS[h] ?? h}
                      </th>
                    ))}
                  </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {pageRows.map((s) => (
                      <tr key={s.structure_id} className="hover:bg-slate-50">
                        <td className="px-3 py-2 text-slate-500">#{s.structure_id}</td>
                        <td className="px-3 py-2">
                          <RiskBadge score={s.overall_score} category={s.risk_category} />
                        </td>
                        <td className="px-3 py-2 tabular-nums">{fmt(s.blend, 2)}</td>
                        <td className="px-3 py-2">
                          {HID_LABELS[s.dominant_hazard ?? ""] ?? s.dominant_hazard ?? "—"}
                        </td>
                        {hazardCols.map((h) => (
                          <td key={h} className="px-3 py-2 text-right tabular-nums">
                            {s.hazard_scores?.[h] != null ? fmt(s.hazard_scores[h], 1) : "—"}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500">
                <p>
                  Page {page} / {pageCount} · rows {(page - 1) * PAGE_SIZE + 1}–
                  {Math.min(page * PAGE_SIZE, sorted.length)} of {sorted.length.toLocaleString()}
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    className="btn-secondary disabled:opacity-40"
                  >
                    ← Prev
                  </button>
                  <button
                    type="button"
                    disabled={page >= pageCount}
                    onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                    className="btn-secondary disabled:opacity-40"
                  >
                    Next →
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-2 border-t border-slate-100 px-5 py-4">
            {disclaimer && <Alert kind="info">{disclaimer}</Alert>}
            <details className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2">
              <summary className="cursor-pointer text-xs font-semibold text-slate-700">
                Data sources & attribution
              </summary>
              <div className="mt-2 space-y-1.5 text-xs text-slate-600">
                {sources === null && (
                  <p className="text-slate-400">Source metadata unavailable for this analysis.</p>
                )}
                {Object.entries(sources ?? {}).map(([hid, m]) => (
                  <p key={hid}>
                    <span className="font-semibold text-slate-700">{HID_LABELS[hid] ?? hid}:</span>{" "}
                    {m.dataset ?? "unknown dataset"}
                    {m.resolution_km ? ` (${m.resolution_km} km² grid)` : ""} —{" "}
                    {m.attribution ?? "attribution n/a"}
                    {m.note ? ` ${m.note}` : ""}
                  </p>
                ))}
              </div>
            </details>
            <p className="text-[10px] text-slate-400">
              Footprints © OpenStreetMap contributors (source data, not model output). Dimensions
              share dataset metadata across structures within an area.
            </p>
          </div>
        </>
      )}
    </section>
  );
}