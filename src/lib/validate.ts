/** Tiny input-validation helpers shared by the REST layer and seed script. */

export class ValidationError extends Error {
  status = 400;
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError("Expected a JSON object body.");
  }
  return value as Record<string, unknown>;
}

export function reqString(body: Record<string, unknown>, field: string, max = 200): string {
  const v = body[field];
  if (typeof v !== "string" || !v.trim()) {
    throw new ValidationError(`Field '${field}' is required.`);
  }
  if (v.length > max) throw new ValidationError(`Field '${field}' is too long.`);
  return v.trim();
}

export function optString(body: Record<string, unknown>, field: string, max = 200): string {
  const v = body[field];
  if (v === undefined || v === null || v === "") return "";
  if (typeof v !== "string") throw new ValidationError(`Field '${field}' must be a string.`);
  if (v.length > max) throw new ValidationError(`Field '${field}' is too long.`);
  return v.trim();
}

export function reqNumber(
  body: Record<string, unknown>,
  field: string,
  min: number,
  max: number
): number {
  const v = body[field];
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new ValidationError(`Field '${field}' must be a number.`);
  }
  if (n < min || n > max) {
    throw new ValidationError(`Field '${field}' must be between ${min} and ${max}.`);
  }
  return n;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function reqEmail(body: Record<string, unknown>): string {
  const v = reqString(body, "email", 254);
  if (!EMAIL_RE.test(v)) throw new ValidationError("Enter a valid email address.");
  return v.toLowerCase();
}

export function reqPassword(body: Record<string, unknown>, min = 10): string {
  const v = reqString(body, "password", 200);
  if (v.length < min) throw new ValidationError(`Password must be at least ${min} characters.`);
  return v;
}

export function reqEnum<T extends string>(
  body: Record<string, unknown>,
  field: string,
  allowed: readonly T[]
): T {
  const v = reqString(body, field, 100);
  if (!allowed.includes(v as T)) {
    throw new ValidationError(`Field '${field}' must be one of: ${allowed.join(", ")}.`);
  }
  return v as T;
}
