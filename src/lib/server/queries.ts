/**
 * Server functions used by SSR loaders to read session/dashboard data.
 * Reads only — all mutations go through the REST layer (src/rest/api.ts) so the
 * UI and curl hit the exact same enforcement path.
 */
import { createServerFn } from "@tanstack/react-start";
import { getCookie } from "@tanstack/react-start/server";
import type { SQLQueryBindings } from "bun:sqlite";

import { SESSION_COOKIE, getSessionUser, type SafeUser } from "~/lib/auth";
import { db, type AnalysisRow } from "~/lib/db";
import type { Role } from "~/lib/rbac";

export type DashboardArea = {
  id: number;
  name: string;
  city: string;
  country: string;
  center_lat: number;
  center_lng: number;
  radius_km: number;
  climate_type: string;
  is_demo: boolean;
  created_at: string;
  latest_analysis: { id: number; status: string; created_at: string } | null;
};

export type DashboardUser = { id: number; name: string; email: string; role: Role };

export type DashboardData = {
  user: DashboardUser | null;
  areas: DashboardArea[];
  admin: null | {
    users: Array<{ id: number; email: string; name: string; role: string; created_at: string }>;
    grants: Array<{ area_id: number; user_id: number; email: string; granted_at: string }>;
  };
};

export const getSessionUserFn = createServerFn().handler((): { user: SafeUser | null } => {
  return { user: getSessionUser(getCookie(SESSION_COOKIE)) };
});

export const getDashboardDataFn = createServerFn().handler((): DashboardData => {
  const user = getSessionUser(getCookie(SESSION_COOKIE));
  if (!user) return { user: null, areas: [], admin: null };

  const areas = db
    .query<import("~/lib/db").AreaRow, [number]>(
      `SELECT DISTINCT a.* FROM areas a
       WHERE a.is_demo = 1
          OR EXISTS (SELECT 1 FROM area_access g WHERE g.area_id = a.id AND g.user_id = ?)
       ORDER BY a.is_demo DESC, a.name COLLATE NOCASE`
    )
    .all(user.id);

  const latest = new Map<number, AnalysisRow>();
  if (areas.length > 0) {
    const placeholders = areas.map(() => "?").join(",");
    const rows = db
      .query<AnalysisRow, SQLQueryBindings[]>(
        `SELECT * FROM analyses
         WHERE id IN (
           SELECT MAX(id) FROM analyses WHERE area_id IN (${placeholders}) GROUP BY area_id
         )`
      )
      .all(...areas.map((a) => a.id));
    for (const r of rows) latest.set(r.area_id, r);
  }

  let admin: DashboardData["admin"] = null;
  if (user.role === "admin") {
    const users = db
      .query<
        { id: number; email: string; name: string; role: string; created_at: string },
        []
      >("SELECT id, email, name, role, created_at FROM users ORDER BY created_at ASC")
      .all();
    const grants = db
      .query<{ area_id: number; user_id: number; email: string; granted_at: string }, []>(
        `SELECT g.area_id, g.user_id, u.email, g.created_at AS granted_at
         FROM area_access g JOIN users u ON u.id = g.user_id
         ORDER BY g.created_at DESC`
      )
      .all();
    admin = { users, grants };
  }

  return {
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
    areas: areas.map((a) => ({
      id: a.id,
      name: a.name,
      city: a.city,
      country: a.country,
      center_lat: a.center_lat,
      center_lng: a.center_lng,
      radius_km: a.radius_km,
      climate_type: a.climate_type,
      is_demo: a.is_demo === 1,
      created_at: a.created_at,
      latest_analysis:
        latest.get(a.id) !== undefined
          ? {
              id: latest.get(a.id)!.id,
              status: latest.get(a.id)!.status,
              created_at: latest.get(a.id)!.created_at,
            }
          : null,
    })),
    admin,
  };
});
