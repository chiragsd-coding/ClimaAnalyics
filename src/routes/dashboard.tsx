import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { Nav } from "~/components/Nav";
import {
  Alert,
  ClimateChip,
  DemoBadge,
  EmptyState,
  RoleBadge,
  Spinner,
  StatusBadge,
} from "~/components/ui";
import { fmtCoord, fmtDate } from "~/lib/format";
import { getDashboardDataFn, type DashboardData, type DashboardArea } from "~/lib/server/queries";

type AdminData = NonNullable<DashboardData["admin"]>;

export const Route = createFileRoute("/dashboard")({
  loader: async () => {
    const data = await getDashboardDataFn();
    if (!data.user) throw redirect({ to: "/login", search: { next: "/dashboard" } });
    return data;
  },
  component: Dashboard,
});

function Dashboard() {
  const data = Route.useLoaderData();
  const user = data.user!;

  return (
    <main className="min-h-dvh bg-slate-50">
      <Nav user={{ name: user.name, role: user.role }} active="dashboard" />
      <div className="mx-auto max-w-6xl px-6 py-10">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">Your areas</h1>
            <p className="mt-1 text-sm text-slate-500">
              {data.areas.length} area{data.areas.length === 1 ? "" : "s"} you can access
              {user.role === "viewer" && " · read-only access"}
            </p>
          </div>
          {(user.role === "admin" || user.role === "analyst") && (
            <p className="text-xs text-slate-400">
              Scoring engine lands in slice 3 — maps and footprints are live now.
            </p>
          )}
        </div>

        {data.areas.length === 0 ? (
          <div className="mt-8">
            <EmptyState
              title="No areas yet"
              body="Areas you create or that are shared with you will appear here. Every account also sees the Downtown Miami demo area once seeded."
            />
          </div>
        ) : (
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {data.areas.map((area) => (
              <AreaCard key={area.id} area={area} />
            ))}
          </div>
        )}

        {(user.role === "admin" || user.role === "analyst") && (
          <section className="mt-12">
            <div className="card flex flex-col items-start justify-between gap-4 p-6 sm:flex-row sm:items-center">
              <div>
                <h2 className="text-lg font-bold tracking-tight text-slate-900">Create an area</h2>
                <p className="mt-1 max-w-xl text-sm text-slate-500">
                  Click the map to drop the centre, set a radius of 0.5–10 km, and pick a climate
                  type. Building footprints are fetched live from OpenStreetMap; you are granted
                  access to the area automatically.
                </p>
              </div>
              <Link to="/areas/new" className="btn-primary shrink-0">
                Open the map picker
              </Link>
            </div>
          </section>
        )}

        {data.admin && <AccessAdmin users={data.admin.users} areas={data.areas} />}
      </div>
    </main>
  );
}

function AreaCard({ area }: { area: DashboardArea }) {
  return (
    <Link
      to="/areas/$areaId"
      params={{ areaId: String(area.id) }}
      className="card flex flex-col p-5 transition-shadow hover:border-brand-300 hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-semibold text-slate-900">{area.name}</h3>
        {area.is_demo && <DemoBadge />}
      </div>
      <p className="mt-0.5 text-sm text-slate-500">
        {[area.city, area.country].filter(Boolean).join(", ") || "No location text"}
      </p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <ClimateChip value={area.climate_type} />
        <span className="chip bg-slate-100 text-slate-700 ring-1 ring-slate-200 ring-inset">
          r = {area.radius_km} km
        </span>
        {area.structures_count > 0 && (
          <span className="chip bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200 ring-inset">
            {area.structures_count.toLocaleString()} footprints
          </span>
        )}
      </div>
      <dl className="mt-4 space-y-1.5 text-sm">
        <div className="flex justify-between gap-2">
          <dt className="text-slate-500">Center</dt>
          <dd className="font-medium text-slate-800">{fmtCoord(area.center_lat, area.center_lng)}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-slate-500">Latest analysis</dt>
          <dd className="flex items-center gap-1.5 font-medium text-slate-800">
            {area.latest_analysis ? (
              <>
                <StatusBadge status={area.latest_analysis.status} />
                <span className="text-slate-500">{fmtDate(area.latest_analysis.created_at)}</span>
              </>
            ) : (
              <span className="text-slate-400">None yet</span>
            )}
          </dd>
        </div>
      </dl>
      <p className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3 text-xs text-slate-400">
        <span>
          {area.structures_count > 0
            ? "Map & footprints ready"
            : area.fetch_status === "failed"
              ? "Footprint fetch failed — retry on the area page"
              : "Footprints not fetched yet"}
        </span>
        <span className="font-medium text-brand-700">View area →</span>
      </p>
    </Link>
  );
}

function AccessAdmin({ users, areas }: { users: AdminData["users"]; areas: DashboardArea[] }) {
  const router = useRouter();
  const loaderData = Route.useLoaderData();
  const [areaId, setAreaId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selected = areas.find((a) => a.id === areaId) ?? null;
  // The loader returns ALL grants (admin-only); filter client-side to the selected area.
  const grants = areaId ? (loaderData.admin?.grants ?? []).filter((g) => g.area_id === areaId) : [];
  const grantedIds = new Set(grants.map((g) => g.user_id));
  const grantable = users.filter((u) => !grantedIds.has(u.id));

  async function call(url: string, method: string, body?: unknown, okMsg?: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(url, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Request failed.");
        return;
      }
      if (okMsg) setNotice(okMsg);
      await router.invalidate();
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-12">
      <div className="flex items-center gap-3">
        <h2 className="text-lg font-bold tracking-tight text-slate-900">Manage access</h2>
        <RoleBadge role="admin" />
      </div>
      <p className="mt-1 text-sm text-slate-500">
        Grant or revoke per-area access. Demo areas are visible to every account and can’t be
        restricted.
      </p>

      <div className="mt-4 max-w-md">
        <label htmlFor="access-area" className="label">
          Area
        </label>
        <select
          id="access-area"
          className="input"
          value={areaId ?? ""}
          onChange={(e) => {
            setAreaId(e.target.value ? Number(e.target.value) : null);
            setError(null);
            setNotice(null);
          }}
        >
          <option value="">Select an area…</option>
          {areas.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
              {a.is_demo ? " (demo)" : ""}
            </option>
          ))}
        </select>
      </div>

      {selected && (
        <div className="card mt-4 p-6">
          {error && (
            <div className="mb-4">
              <Alert kind="error">{error}</Alert>
            </div>
          )}
          {notice && (
            <div className="mb-4">
              <Alert kind="success">{notice}</Alert>
            </div>
          )}

          {selected.is_demo ? (
            <Alert kind="info">
              This is the demo area — visible to every account by design, editable only by admins.
              Access is not managed per user.
            </Alert>
          ) : (
            <>
              <h3 className="text-sm font-semibold text-slate-900">
                Users with access ({grants.length})
              </h3>
              {grants.length === 0 ? (
                <p className="mt-2 text-sm text-slate-400">
                  No explicit grants. Only the creator and admins can reach this area.
                </p>
              ) : (
                <ul className="mt-3 divide-y divide-slate-100 rounded-lg border border-slate-200">
                  {grants.map((g) => (
                    <li key={g.user_id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-slate-900">{g.email}</p>
                        <p className="text-xs text-slate-500">granted {fmtDate(g.granted_at)}</p>
                      </div>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void call(`/api/areas/${selected.id}/access/${g.user_id}`, "DELETE", undefined, "Access revoked.")}
                        className="btn-danger px-3 py-1.5 text-xs"
                      >
                        Revoke
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <h3 className="mt-6 text-sm font-semibold text-slate-900">Grant a user</h3>
              {grantable.length === 0 ? (
                <p className="mt-2 text-sm text-slate-400">Every user already has access.</p>
              ) : (
                <form
                  className="mt-2 flex max-w-md flex-wrap items-end gap-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const fd = new FormData(e.currentTarget);
                    const userId = Number(fd.get("user_id"));
                    if (userId)
                      void call(
                        `/api/areas/${selected.id}/access`,
                        "POST",
                        { user_id: userId },
                        "Access granted."
                      );
                  }}
                >
                  <div className="min-w-56 grow">
                    <label htmlFor="grant-user" className="label">
                      User
                    </label>
                    <select id="grant-user" name="user_id" className="input" required>
                      {grantable.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name} — {u.email} ({u.role})
                        </option>
                      ))}
                    </select>
                  </div>
                  <button type="submit" disabled={busy} className="btn-primary">
                    {busy && <Spinner />}
                    Grant access
                  </button>
                </form>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
