/**
 * REST API for ClimaScope (slice 1: auth, areas, RBAC, analyses/structures reads).
 *
 * Runs inside the same Bun process as the SSR site: serve.ts dispatches any
 * /api/* request here before falling through to the TanStack Start handler.
 * Business logic lives in src/lib/* so this layer stays thin.
 *
 * Conventions:
 *  - JSON in / JSON out. Errors are { "error": string } with a proper status.
 *  - Auth: httpOnly session cookie (sessions table). Not signed in -> 401.
 *  - RBAC: area access requires is_demo=1 or an area_access row; otherwise 404
 *    (existence of other users' areas is never leaked). Role violations on an
 *    accessible area are 403.
 */
import {
  SESSION_COOKIE,
  createSession,
  createUser,
  destroySession,
  findUserByEmail,
  findUserById,
  getSessionUser,
  hasAnyUsers,
  serializeClearedCookie,
  serializeSessionCookie,
  toSafeUser,
  verifyPassword,
  type SafeUser,
} from "~/lib/auth";
import { db, parseJsonSafe, type AnalysisRow, type AreaRow } from "~/lib/db";
import type { SQLQueryBindings } from "bun:sqlite";
import { CLIMATE_VALUES } from "~/lib/climates";
import {
  HttpError,
  canEditArea,
  canRunAnalyses,
  requireRole,
  requireAreaAccess,
} from "~/lib/rbac";
import {
  DEFAULT_INGEST_BUDGET_MS,
  MAX_STRUCTURES_PER_AREA,
  ingestStructuresForArea,
  type IngestResult,
} from "~/lib/overpass";
import {
  ValidationError,
  asRecord,
  optString,
  reqEmail,
  reqEnum,
  reqNumber,
  reqPassword,
  reqString,
} from "~/lib/validate";

type Ctx = {
  req: Request;
  params: Record<string, string>;
  user: SafeUser | null;
  body: unknown;
};
type Handler = (ctx: Ctx) => Response | Promise<Response>;

/** Inline budget for footprint ingestion during area creation (ms). */
const INGEST_INLINE_BUDGET_MS = DEFAULT_INGEST_BUDGET_MS;

function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...(headers ?? {}) },
  });
}

function isSecure(req: Request): boolean {
  if ((req.headers.get("x-forwarded-proto") ?? "").includes("https")) return true;
  try {
    return new URL(req.url).protocol === "https:";
  } catch {
    return false;
  }
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return undefined;
}

/** Throws 401 unless a session user is present. */
function requireUser(user: SafeUser | null): SafeUser {
  if (!user) throw new HttpError(401, "Sign in required.");
  return user;
}

// ---------------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------------

type Route = { method: string; pattern: RegExp; paramNames: string[]; handler: Handler };

function route(method: string, path: string, handler: Handler): Route {
  const paramNames: string[] = [];
  const regex = new RegExp(
    "^" +
      path
        .split("/")
        .map((seg) => {
          if (seg.startsWith(":")) {
            paramNames.push(seg.slice(1));
            return "([^/]+)";
          }
          return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        })
        .join("/") +
      "$"
  );
  return { method, pattern: regex, paramNames, handler };
}

function parseId(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(404, "Not found.");
  return n;
}

function publicArea(a: AreaRow, latest: AnalysisRow | null, structuresCount?: number) {
  return {
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
    fetch_status: a.fetch_status,
    fetch_note: a.fetch_note,
    fetched_at: a.fetched_at,
    structures_count: structuresCount ?? countStructures(a.id),
    latest_analysis: latest
      ? { id: latest.id, status: latest.status, created_at: latest.created_at }
      : null,
  };
}

function countStructures(areaId: number): number {
  return db
    .query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM structures WHERE area_id = ?")
    .get(areaId)!.n;
}

function latestAnalysisByArea(areaIds: number[]): Map<number, AnalysisRow> {
  const map = new Map<number, AnalysisRow>();
  if (areaIds.length === 0) return map;
  const placeholders = areaIds.map(() => "?").join(",");
  const rows = db
    .query<AnalysisRow, SQLQueryBindings[]>(
      `SELECT * FROM analyses
       WHERE id IN (
         SELECT MAX(id) FROM analyses WHERE area_id IN (${placeholders}) GROUP BY area_id
       )`
    )
    .all(...areaIds);
  for (const r of rows) map.set(r.area_id, r);
  return map;
}

function listAccessibleAreas(user: SafeUser): AreaRow[] {
  return db
    .query<AreaRow, [number]>(
      `SELECT DISTINCT a.* FROM areas a
       WHERE a.is_demo = 1
          OR EXISTS (SELECT 1 FROM area_access g WHERE g.area_id = a.id AND g.user_id = ?)
       ORDER BY a.is_demo DESC, a.name COLLATE NOCASE`
    )
    .all(user.id);
}

// -- auth -------------------------------------------------------------------

const register = route("POST", "/api/auth/register", async ({ req, body }) => {
  const input = asRecord(body);
  const email = reqEmail(input);
  const name = reqString(input, "name", 120);
  const password = reqPassword(input, 10);

  if (findUserByEmail(email)) {
    throw new HttpError(409, "An account with this email already exists.");
  }
  // Bootstrap convenience: if the DB has no users at all (seed not yet run),
  // the first account becomes admin; afterwards everyone signs up as analyst.
  const role = hasAnyUsers() ? "analyst" : "admin";
  const user = await createUser({ email, name, password, role });

  const { token } = createSession(user.id);
  return json({ user: toSafeUser(user) }, 201, {
    "set-cookie": serializeSessionCookie(token, isSecure(req)),
  });
});

const login = route("POST", "/api/auth/login", async ({ req, body }) => {
  const input = asRecord(body);
  const email = reqEmail(input);
  const password = reqString(input, "password", 200);

  const user = findUserByEmail(email);
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    throw new HttpError(401, "Incorrect email or password.");
  }
  const { token } = createSession(user.id);
  return json({ user: toSafeUser(user) }, 200, {
    "set-cookie": serializeSessionCookie(token, isSecure(req)),
  });
});

const logout = route("POST", "/api/auth/logout", ({ req }) => {
  destroySession(readCookie(req, SESSION_COOKIE));
  return json({ ok: true }, 200, {
    "set-cookie": serializeClearedCookie(isSecure(req)),
  });
});

const me = route("GET", "/api/me", ({ user }) => {
  return json({ user });
});

// -- areas ------------------------------------------------------------------

const listAreas = route("GET", "/api/areas", ({ user }) => {
  const u = requireUser(user);
  const areas = listAccessibleAreas(u);
  const latest = latestAnalysisByArea(areas.map((a) => a.id));
  return json({ areas: areas.map((a) => publicArea(a, latest.get(a.id) ?? null)) });
});

function dbInsertArea(input: Record<string, unknown>, user: SafeUser): AreaRow {
  const name = reqString(input, "name", 120);
  const city = optString(input, "city", 120);
  const country = optString(input, "country", 120);
  const center_lat = reqNumber(input, "center_lat", -90, 90);
  const center_lng = reqNumber(input, "center_lng", -180, 180);
  const radius_km = reqNumber(input, "radius_km", 0.5, 10);
  const climate_type = reqEnum(input, "climate_type", CLIMATE_VALUES);
  const is_demo = input.is_demo === true && user.role === "admin" ? 1 : 0;

  const res = db.run(
    `INSERT INTO areas (name, city, country, center_lat, center_lng, radius_km, climate_type, is_demo, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [name, city, country, center_lat, center_lng, radius_km, climate_type, is_demo, user.id]
  );
  const id = Number(res.lastInsertRowid);
  // Auto-grant the creator (admin or analyst) so access is always explicit.
  db.run("INSERT OR IGNORE INTO area_access (area_id, user_id, granted_by) VALUES (?, ?, ?)", [
    id,
    user.id,
    user.id,
  ]);
  return db.query<AreaRow, [number]>("SELECT * FROM areas WHERE id = ?").get(id)!;
}

const createArea = route("POST", "/api/areas", async ({ user, body }) => {
  const u = requireUser(user);
  requireRole(u, ["admin", "analyst"]);
  const area = dbInsertArea(asRecord(body), u);
  // Ingest footprints inline, but under a hard deadline: Overpass is
  // best-effort and must never leave the create flow hanging. On failure the
  // area still exists and the UI offers an explicit retry.
  const ingest = await ingestStructuresForArea(area, { budgetMs: INGEST_INLINE_BUDGET_MS });
  return json({ area: publicArea(freshArea(area.id), null), structures: ingest }, 201);
});

function freshArea(id: number): AreaRow {
  return db.query<AreaRow, [number]>("SELECT * FROM areas WHERE id = ?").get(id)!;
}

/** Explicit re-fetch action on the area detail page. */
const fetchStructures = route("POST", "/api/areas/:id/structures/fetch", async ({ user, params }) => {
  const u = requireUser(user);
  const area = requireAreaAccess(u, parseId(params.id));
  if (!canEditArea(u, area)) {
    throw new HttpError(403, "Only the area owner or an admin can fetch footprints.");
  }
  const ingest: IngestResult = await ingestStructuresForArea(area);
  const updated = freshArea(area.id);
  return json({
    area: publicArea(updated, null),
    structures: ingest,
    // Where the deterministic per-area cap sits, so the UI can surface it.
    structures_cap: MAX_STRUCTURES_PER_AREA,
  });
});

const getArea = route("GET", "/api/areas/:id", ({ user, params }) => {
  const u = requireUser(user);
  const area = requireAreaAccess(u, parseId(params.id));
  const latest =
    db
      .query<AnalysisRow, [number]>(
        "SELECT * FROM analyses WHERE area_id = ? ORDER BY created_at DESC, id DESC LIMIT 1"
      )
      .get(area.id) ?? null;
  return json({ area: publicArea(area, latest) });
});

const patchArea = route("PATCH", "/api/areas/:id", ({ user, params, body }) => {
  const u = requireUser(user);
  const area = requireAreaAccess(u, parseId(params.id));
  if (!canEditArea(u, area)) throw new HttpError(403, "You cannot edit this area.");
  const input = asRecord(body);

  const next = {
    name: input.name !== undefined ? reqString(input, "name", 120) : area.name,
    city: input.city !== undefined ? optString(input, "city", 120) : area.city,
    country: input.country !== undefined ? optString(input, "country", 120) : area.country,
    center_lat:
      input.center_lat !== undefined ? reqNumber(input, "center_lat", -90, 90) : area.center_lat,
    center_lng:
      input.center_lng !== undefined ? reqNumber(input, "center_lng", -180, 180) : area.center_lng,
    radius_km:
      input.radius_km !== undefined ? reqNumber(input, "radius_km", 0.5, 10) : area.radius_km,
    climate_type:
      input.climate_type !== undefined
        ? reqEnum(input, "climate_type", CLIMATE_VALUES)
        : area.climate_type,
    is_demo: area.is_demo,
  };
  if (input.is_demo !== undefined && u.role === "admin") {
    next.is_demo = input.is_demo === true ? 1 : 0;
  }

  db.run(
    `UPDATE areas SET name=?, city=?, country=?, center_lat=?, center_lng=?, radius_km=?, climate_type=?, is_demo=? WHERE id=?`,
    [
      next.name,
      next.city,
      next.country,
      next.center_lat,
      next.center_lng,
      next.radius_km,
      next.climate_type,
      next.is_demo,
      area.id,
    ]
  );
  const updated = db.query<AreaRow, [number]>("SELECT * FROM areas WHERE id = ?").get(area.id)!;
  return json({ area: publicArea(updated, null) });
});

const deleteArea = route("DELETE", "/api/areas/:id", ({ user, params }) => {
  const u = requireUser(user);
  const area = requireAreaAccess(u, parseId(params.id));
  if (!canEditArea(u, area)) throw new HttpError(403, "You cannot delete this area.");
  db.run("DELETE FROM areas WHERE id = ?", [area.id]);
  return json({ ok: true });
});

// -- access grants (admin only) ----------------------------------------------

const listAccess = route("GET", "/api/areas/:id/access", ({ user, params }) => {
  const u = requireUser(user);
  const area = requireAreaAccess(u, parseId(params.id));
  requireRole(u, ["admin"]);
  const rows = db
    .query<
      {
        user_id: number;
        email: string;
        name: string;
        role: string;
        granted_at: string;
        granted_by: number | null;
      },
      [number]
    >(
      `SELECT g.user_id, u.email, u.name, u.role, g.created_at AS granted_at, g.granted_by
       FROM area_access g JOIN users u ON u.id = g.user_id
       WHERE g.area_id = ? ORDER BY g.created_at DESC`
    )
    .all(area.id);
  return json({ area_id: area.id, access: rows });
});

const grantAccess = route("POST", "/api/areas/:id/access", ({ user, params, body }) => {
  const u = requireUser(user);
  const area = requireAreaAccess(u, parseId(params.id));
  requireRole(u, ["admin"]);
  const target = findUserById(reqNumber(asRecord(body), "user_id", 1, Number.MAX_SAFE_INTEGER));
  if (!target) throw new HttpError(404, "User not found.");
  db.run("INSERT OR IGNORE INTO area_access (area_id, user_id, granted_by) VALUES (?, ?, ?)", [
    area.id,
    target.id,
    u.id,
  ]);
  return json({ ok: true, area_id: area.id, user_id: target.id }, 201);
});

const revokeAccess = route("DELETE", "/api/areas/:id/access/:userId", ({ user, params }) => {
  const u = requireUser(user);
  const area = requireAreaAccess(u, parseId(params.id));
  requireRole(u, ["admin"]);
  db.run("DELETE FROM area_access WHERE area_id = ? AND user_id = ?", [
    area.id,
    parseId(params.userId),
  ]);
  return json({ ok: true });
});

// -- analyses -----------------------------------------------------------------

const listAnalyses = route("GET", "/api/areas/:id/analyses", ({ user, params }) => {
  const u = requireUser(user);
  const area = requireAreaAccess(u, parseId(params.id));
  const rows = db
    .query<AnalysisRow, [number]>(
      "SELECT * FROM analyses WHERE area_id = ? ORDER BY created_at DESC, id DESC LIMIT 50"
    )
    .all(area.id);
  return json({
    analyses: rows.map((a) => ({
      id: a.id,
      area_id: a.area_id,
      climate_type: a.climate_type,
      status: a.status,
      params: parseJsonSafe<Record<string, unknown>>(a.params),
      summary: parseJsonSafe<Record<string, unknown>>(a.summary),
      created_at: a.created_at,
      completed_at: a.completed_at,
    })),
  });
});

const createAnalysis = route("POST", "/api/areas/:id/analyses", ({ user, params, body }) => {
  const u = requireUser(user);
  const area = requireAreaAccess(u, parseId(params.id));
  if (!canRunAnalyses(u)) throw new HttpError(403, "Viewers cannot run analyses.");

  const noteField = (body as Record<string, unknown> | undefined)?.note;
  const note = typeof noteField === "string" ? noteField.slice(0, 500) : undefined;
  const paramsJson = JSON.stringify({ requested_by: u.id, note });

  const res = db.run(
    `INSERT INTO analyses (area_id, climate_type, status, params, created_by) VALUES (?, ?, 'pending', ?, ?)`,
    [area.id, area.climate_type, paramsJson, u.id]
  );
  const created = db
    .query<AnalysisRow, [number]>("SELECT * FROM analyses WHERE id = ?")
    .get(Number(res.lastInsertRowid))!;
  return json(
    {
      analysis: {
        id: created.id,
        area_id: created.area_id,
        climate_type: created.climate_type,
        status: created.status,
        created_at: created.created_at,
      },
      note: "Scoring engine lands in slice 3 — the analysis stays 'pending' until then.",
    },
    201
  );
});

// -- structures ---------------------------------------------------------------

const listStructures = route("GET", "/api/areas/:id/structures", ({ user, params, req }) => {
  const u = requireUser(user);
  const area = requireAreaAccess(u, parseId(params.id));
  // Optional ?limit= (1–5000, default 5000) lets the map overlay pull a modest
  // sample without weakening the endpoint's ceiling.
  let limit = 5000;
  const rawLimit = new URL(req.url).searchParams.get("limit");
  if (rawLimit !== null) {
    const n = Number(rawLimit);
    if (Number.isInteger(n) && n >= 1 && n <= 5000) limit = n;
  }
  const rows = db
    .query<
      {
        id: number;
        osm_id: string | null;
        centroid_lat: number;
        centroid_lon: number;
        footprint: string | null;
        props: string | null;
      },
      [number, number]
    >("SELECT * FROM structures WHERE area_id = ? LIMIT ?")
    .all(area.id, limit);
  return json({
    structures: rows.map((s) => ({
      id: s.id,
      osm_id: s.osm_id,
      centroid_lat: s.centroid_lat,
      centroid_lon: s.centroid_lon,
      footprint: parseJsonSafe(s.footprint),
      props: parseJsonSafe<Record<string, unknown>>(s.props),
    })),
  });
});

// -- users (admin) -------------------------------------------------------------

const listUsers = route("GET", "/api/users", ({ user }) => {
  const u = requireUser(user);
  requireRole(u, ["admin"]);
  const rows = db
    .query<{ id: number; email: string; name: string; role: string; created_at: string }, []>(
      "SELECT id, email, name, role, created_at FROM users ORDER BY created_at ASC"
    )
    .all();
  return json({ users: rows });
});

// -- dispatch -------------------------------------------------------------------

const ROUTES: Route[] = [
  register,
  login,
  logout,
  me,
  listAreas,
  createArea,
  fetchStructures,
  getArea,
  patchArea,
  deleteArea,
  listAccess,
  grantAccess,
  revokeAccess,
  listAnalyses,
  createAnalysis,
  listStructures,
  listUsers,
];

export async function handleApiRequest(req: Request): Promise<Response> {
  const pathname = new URL(req.url).pathname;
  try {
    for (const r of ROUTES) {
      if (r.method !== req.method) continue;
      const m = r.pattern.exec(pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.paramNames.forEach((name, i) => (params[name] = decodeURIComponent(m[i + 1])));
      const user = getSessionUser(readCookie(req, SESSION_COOKIE));
      let body: unknown = undefined;
      if (req.method === "POST" || req.method === "PATCH") {
        const text = await req.text();
        if (text) {
          try {
            body = JSON.parse(text);
          } catch {
            throw new ValidationError("Request body must be valid JSON.");
          }
        }
      }
      return await r.handler({ req, params, user, body });
    }
    return json({ error: "Not found." }, 404);
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    if (err instanceof ValidationError) return json({ error: err.message }, 400);
    console.error("[api] unhandled error", pathname, err);
    return json({ error: "Internal server error." }, 500);
  }
}
