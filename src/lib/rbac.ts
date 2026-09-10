/**
 * Area-scoped RBAC — the security core of ClimaScope.
 *
 * Rule (no exceptions, no implicit visibility):
 *   A user may access an area iff area.is_demo = 1 OR a row in area_access
 *   ties that user to the area. When access is missing we return 404 — never
 *   403 — so the existence of someone else's area is not leaked.
 */
import type { AreaRow } from "./db";
import { db } from "./db";

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type Role = "admin" | "analyst" | "viewer";

export type AreaLike = {
  is_demo: 0 | 1;
  created_by: number | null;
};

export function requireRole(user: { role: Role } | null, allowed: Role[]): void {
  if (!user) throw new HttpError(401, "Sign in required.");
  if (!allowed.includes(user.role)) {
    throw new HttpError(403, `Requires one of: ${allowed.join(", ")}.`);
  }
}

/**
 * Resolve an area to which `user` has access, or throw 404.
 * 404 (not 403) so a missing area and an inaccessible area are indistinguishable.
 */
export function requireAreaAccess(user: { id: number } | null, areaId: number): AreaRow {
  if (!user) throw new HttpError(401, "Sign in required.");

  const area = db.query<AreaRow, [number]>("SELECT * FROM areas WHERE id = ?").get(areaId);
  if (!area) throw new HttpError(404, "Area not found.");

  if (area.is_demo === 1) return area;

  const granted = db
    .query<{ n: number }, [number, number]>(
      "SELECT COUNT(*) AS n FROM area_access WHERE area_id = ? AND user_id = ?"
    )
    .get(areaId, user.id)!;
  if (granted.n === 0) throw new HttpError(404, "Area not found.");

  return area;
}

export function hasAreaAccess(user: { id: number } | null, area: { id: number; is_demo: 0 | 1 }): boolean {
  if (!user) return false;
  if (area.is_demo === 1) return true;
  return !!db
    .query<{ n: number }, [number, number]>(
      "SELECT COUNT(*) AS n FROM area_access WHERE area_id = ? AND user_id = ?"
    )
    .get(area.id, user.id)!.n;
}

/** Can this user create areas? */
export function canCreateAreas(user: { role: Role } | null): boolean {
  return !!user && (user.role === "admin" || user.role === "analyst");
}

/** Can this user run analyses on an area they can access? */
export function canRunAnalyses(user: { role: Role } | null): boolean {
  return canCreateAreas(user);
}

/** Demo areas are viewable by everyone but editable only by admins. */
export function canEditArea(user: { role: Role; id: number } | null, area: AreaLike): boolean {
  if (!user) return false;
  if (area.is_demo === 1) return user.role === "admin";
  if (user.role === "admin") return true;
  return user.role === "analyst" && area.created_by === user.id;
}
