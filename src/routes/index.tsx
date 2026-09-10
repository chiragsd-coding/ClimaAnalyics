import { createFileRoute } from "@tanstack/react-router";
import { Link } from "@tanstack/react-router";
import { Nav } from "~/components/Nav";
import { SiteFooter } from "~/components/ui";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return (
    <main className="flex min-h-dvh flex-col bg-white">
      <Nav user={null} active="home" />

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_50%_0%,rgba(13,148,136,0.12),transparent_70%)]"
        />
        <div className="mx-auto max-w-6xl px-6 pt-20 pb-24 text-center">
          <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-brand-200 bg-brand-50 px-3 py-1 text-xs font-semibold tracking-wide text-brand-800 uppercase">
            Climate risk analytics
          </p>
          <h1 className="mx-auto max-w-3xl text-4xl font-extrabold tracking-tight text-slate-900 sm:text-5xl">
            Every structure in your area,{" "}
            <span className="text-brand-700">scored for climate risk.</span>
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg text-slate-600">
            Draw an area of interest, pick the climate type, and get a 1–5 climate-risk score for
            every rooftop inside it — mapped, measurable, and ready for your team.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link to="/register" className="btn-primary px-6 py-3 text-base">
              Try the live demo area
            </Link>
            <Link to="/login" className="btn-secondary px-6 py-3 text-base">
              Sign in
            </Link>
          </div>
          <p className="mt-4 text-sm text-slate-500">
            Every account can explore the Downtown Miami demo area — no credit card, no setup.
          </p>
        </div>
      </section>

      {/* What it does */}
      <section className="mx-auto w-full max-w-6xl px-6 pb-24">
        <div className="grid gap-6 sm:grid-cols-2">
          <Feature
            icon={<IconTarget />}
            title="Define your area in seconds"
            body="Enter coordinates or click the map, then set a radius from 0.5 to 10 km. Your area of interest is saved and repeatable."
          />
          <Feature
            icon={<IconClimate />}
            title="Hazard models matched to climate"
            body="Eight climate types — tropical, arid, temperate, Mediterranean and more — each activates the hazard models that matter: flood, cyclone wind, extreme heat, wildfire, snow load, storm surge."
          />
          <Feature
            icon={<IconScores />}
            title="1–5 risk scores for every structure"
            body="Real building footprints scored on a color-coded map overlay with per-structure metrics, an area average, and a shareable report."
          />
          <Feature
            icon={<IconLock />}
            title="Area-scoped access control"
            body="Share one area with your whole team without exposing the rest of your city. Access is granted per area, enforced on the server."
          />
        </div>
      </section>

      {/* Provenance + CTA band */}
      <section className="border-y border-slate-200 bg-slate-50">
        <div className="mx-auto max-w-6xl px-6 py-14 text-center">
          <h2 className="text-2xl font-bold tracking-tight text-slate-900">
            Transparent about the data
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-slate-600">
            Scores come from Model v1 — a heuristic model built on OpenStreetMap building footprints
            and published hazard patterns. Every result is labeled as a model estimate, never an
            engineering-grade assessment, so your team always knows what it is looking at.
          </p>
          <div className="mt-8">
            <Link to="/register" className="btn-primary px-6 py-3 text-base">
              Try the live demo area
            </Link>
          </div>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}

function Feature({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="card flex gap-4 p-6">
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700 ring-1 ring-brand-100 ring-inset">
        {icon}
      </div>
      <div>
        <h3 className="font-semibold text-slate-900">{title}</h3>
        <p className="mt-1 text-sm leading-relaxed text-slate-600">{body}</p>
      </div>
    </div>
  );
}

function IconTarget() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="h-5 w-5">
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3" />
      <path strokeLinecap="round" d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    </svg>
  );
}

function IconClimate() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="h-5 w-5">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" />
    </svg>
  );
}

function IconScores() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="h-5 w-5">
      <path strokeLinecap="round" d="M4 20V10m5 10V4m5 16v-7m5 7V8" />
    </svg>
  );
}

function IconLock() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="h-5 w-5">
      <rect x="4" y="10" width="16" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 1 1 8 0v3" />
    </svg>
  );
}
