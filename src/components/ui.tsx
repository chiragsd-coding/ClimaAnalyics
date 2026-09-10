/** Small shared UI primitives (client-safe, no server imports). */
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { climateByValue, riskCategoryLabel } from "~/lib/climates";

export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <svg viewBox="0 0 24 24" fill="none" className="h-7 w-7" aria-hidden>
        <circle cx="12" cy="12" r="10" className="fill-brand-700" />
        <path
          d="M6 13.5c1.8 1.2 3.6-.8 5.4.2s3.4-.4 5.1.6"
          className="stroke-brand-100"
          strokeWidth="1.6"
          strokeLinecap="round"
          fill="none"
        />
        <path
          d="M7 16.8c1.5.9 3-.4 4.5.3s3-.3 4.4.5"
          className="stroke-brand-200/80"
          strokeWidth="1.3"
          strokeLinecap="round"
          fill="none"
        />
        <path
          d="M5.5 9.5c2-1.4 4 .9 6-.3 1.9-1.1 4 .8 6.2-.4"
          className="stroke-brand-200"
          strokeWidth="1.6"
          strokeLinecap="round"
          fill="none"
        />
        <path
          d="M12 2a14.5 14.5 0 0 0 0 20M2 12h20"
          className="stroke-brand-300/50"
          strokeWidth="1"
          fill="none"
        />
      </svg>
      <span className="text-lg font-bold tracking-tight">
        Clima<span className="text-brand-700">Scope</span>
      </span>
    </span>
  );
}

export function ClimateChip({ value }: { value: string }) {
  const def = climateByValue(value);
  return (
    <span className="chip bg-brand-50 text-brand-800 ring-1 ring-brand-200 ring-inset">
      <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" aria-hidden>
        <circle cx="12" cy="12" r="9" className="stroke-brand-600" strokeWidth="2" />
        <path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" className="stroke-brand-600" strokeWidth="2" fill="none" />
      </svg>
      {def ? def.label : value}
    </span>
  );
}

export function DemoBadge() {
  return (
    <span className="chip bg-amber-100 text-amber-900 ring-1 ring-amber-300 ring-inset">
      ★ Demo
    </span>
  );
}

export function RoleBadge({ role }: { role: string }) {
  const styles: Record<string, string> = {
    admin: "bg-indigo-100 text-indigo-800 ring-indigo-200",
    analyst: "bg-brand-50 text-brand-800 ring-brand-200",
    viewer: "bg-slate-100 text-slate-700 ring-slate-200",
  };
  return (
    <span className={`chip ring-1 ring-inset ${styles[role] ?? styles.viewer}`}>{role}</span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    pending: "bg-amber-100 text-amber-900 ring-amber-200",
    running: "bg-sky-100 text-sky-800 ring-sky-200",
    complete: "bg-emerald-100 text-emerald-800 ring-emerald-200",
    failed: "bg-red-100 text-red-800 ring-red-200",
  };
  return (
    <span className={`chip ring-1 ring-inset ${styles[status] ?? styles.pending}`}>{status}</span>
  );
}

export function RiskBadge({ score, category }: { score: number; category: string }) {
  const safe = Math.min(5, Math.max(1, Math.round(score)));
  return (
    <span
      className="chip text-white"
      style={{ backgroundColor: `var(--color-risk-${safe})` }}
      title={`Overall risk score ${safe} of 5 (${riskCategoryLabel(category)}) — Model v1 estimate`}
    >
      {riskCategoryLabel(category)} ({safe}/5)
    </span>
  );
}

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon?: ReactNode;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="card flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      <div className="text-slate-300">{icon ?? <NoAreasIcon />}</div>
      <h3 className="text-base font-semibold text-slate-900">{title}</h3>
      <p className="max-w-md text-sm text-slate-500">{body}</p>
      {action}
    </div>
  );
}

function NoAreasIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-10 w-10">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 21c-4.418 0-8-3.582-8-8 0-4.418 3.582-8 8-8 4.418 0 8 3.582 8 8 0 4.418-3.582 8-8 8Zm0-16c1.667 2.667 1.667 13.333 0 16m-8-8c2.667-1.667 13.333-1.667 16 0"
      />
    </svg>
  );
}

export function Alert({ kind, children }: { kind: "error" | "success" | "info"; children: ReactNode }) {
  const styles = {
    error: "border-red-200 bg-red-50 text-red-800",
    success: "border-emerald-200 bg-emerald-50 text-emerald-800",
    info: "border-sky-200 bg-sky-50 text-sky-900",
  }[kind];
  return (
    <div className={`rounded-lg border px-3 py-2 text-sm ${styles}`} role={kind === "error" ? "alert" : undefined}>
      {children}
    </div>
  );
}

export function Spinner() {
  return (
    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="10" className="opacity-25" stroke="currentColor" strokeWidth="4" />
      <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
    </svg>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-slate-200 bg-white">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 py-8 text-sm text-slate-500 sm:flex-row">
        <div className="flex items-center gap-3">
          <Logo />
        </div>
        <nav className="flex items-center gap-5">
          <Link to="/" className="hover:text-slate-900">
            Home
          </Link>
          <Link to="/register" className="hover:text-slate-900">
            Create account
          </Link>
          <Link to="/login" className="hover:text-slate-900">
            Sign in
          </Link>
        </nav>
      </div>
      <div className="border-t border-slate-100 py-4 text-center text-xs text-slate-400">
        Risk scores are Model v1 — heuristic estimates derived from OpenStreetMap building
        footprints. Not engineering-grade assessments.
      </div>
    </footer>
  );
}
