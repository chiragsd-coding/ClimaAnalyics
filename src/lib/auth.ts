/**
 * Auth core: argon2id password hashing + DB-backed session cookies.
 * Server-only. Used by both the REST layer (src/rest) and SSR server functions.
 */
import { db, type UserRow } from "./db";

export const SESSION_COOKIE = "climascope_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export type SafeUser = Pick<UserRow, "id" | "email" | "name" | "role" | "tier" | "created_at">;

export function toSafeUser(u: UserRow): SafeUser {
  return { id: u.id, email: u.email, name: u.name, role: u.role, tier: u.tier, created_at: u.created_at };
}

export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "argon2id" });
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(password, hash);
  } catch {
    return false;
  }
}

function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes); // 256 bits of CSPRNG entropy
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function createSession(userId: number): { token: string; expiresAt: Date } {
  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  db.run("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)", [
    token,
    userId,
    expiresAt.toISOString(),
  ]);
  return { token, expiresAt };
}

/** Returns the session user, or null. Also lazily drops expired sessions. */
export function getSessionUser(token: string | undefined | null): SafeUser | null {
  if (!token) return null;
  const row = db
    .query<UserRow & { expires_at: string }, [string]>(
      `SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`
    )
    .get(token);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.run("DELETE FROM sessions WHERE token = ?", [token]);
    return null;
  }
  return toSafeUser(row);
}

export function destroySession(token: string | undefined | null): void {
  if (!token) return;
  db.run("DELETE FROM sessions WHERE token = ?", [token]);
}

export function findUserByEmail(email: string): UserRow | null {
  return db.query<UserRow, [string]>("SELECT * FROM users WHERE email = ? COLLATE NOCASE").get(
    email.trim()
  );
}

export function findUserById(id: number): UserRow | null {
  return db.query<UserRow, [number]>("SELECT * FROM users WHERE id = ?").get(id);
}

export async function createUser(input: {
  email: string;
  name: string;
  password: string;
  role: UserRow["role"];
  /** Slice 6: subscription tier; new accounts default to free. */
  tier?: UserRow["tier"];
}): Promise<UserRow> {
  const password_hash = await hashPassword(input.password);
  const tier = input.tier ?? "free";
  const res = db.run(
    "INSERT INTO users (email, name, password_hash, role, tier) VALUES (?, ?, ?, ?, ?)",
    [input.email.trim(), input.name.trim(), password_hash, input.role, tier]
  );
  return findUserById(Number(res.lastInsertRowid))!;
}

/** True if this is the very first account ever created (used for bootstrap). */
export function hasAnyUsers(): boolean {
  return !!db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM users").get()!.n;
}

// ---------------------------------------------------------------------------
// Cookie helpers. In REST handlers we own the Response; in server functions the
// framework provides getCookie(). Both share the same cookie attributes below.
// ---------------------------------------------------------------------------

export function sessionCookieAttributes(secure: boolean) {
  return {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  } as const;
}

export function serializeSessionCookie(token: string, secure: boolean): string {
  const attrs = sessionCookieAttributes(secure);
  return [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    attrs.secure ? "Secure" : "",
    `Max-Age=${attrs.maxAge}`,
  ]
    .filter(Boolean)
    .join("; ");
}

export function serializeClearedCookie(secure: boolean): string {
  return [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : "",
    "Max-Age=0",
  ]
    .filter(Boolean)
    .join("; ");
}
