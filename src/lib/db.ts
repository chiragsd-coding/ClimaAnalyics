/**
 * Server-only SQLite handle (bun:sqlite) for ClimaScope.
 *
 * Single file DB at .data/climascope.db relative to the site root. WAL mode so
 * the REST layer (serve.ts) and the SSR bundle (dist/server) can each hold a
 * connection safely. Never import from client code.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = process.env.CLIMASCOPE_DATA_DIR ?? join(process.cwd(), ".data");
const DB_PATH = join(DATA_DIR, "climascope.db");

function openDb(): Database {
  mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

function migrate(db: Database) {
  // user_version guards future migrations; v1 is the initial slice-1 schema.
  const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;

  if (version < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name          TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role          TEXT NOT NULL DEFAULT 'viewer'
                      CHECK (role IN ('admin','analyst','viewer')),
        created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token      TEXT PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

      CREATE TABLE IF NOT EXISTS areas (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        name         TEXT NOT NULL,
        city         TEXT NOT NULL DEFAULT '',
        country      TEXT NOT NULL DEFAULT '',
        center_lat   REAL NOT NULL CHECK (center_lat BETWEEN -90 AND 90),
        center_lng   REAL NOT NULL CHECK (center_lng BETWEEN -180 AND 180),
        radius_km    REAL NOT NULL CHECK (radius_km >= 0.5 AND radius_km <= 10),
        climate_type TEXT NOT NULL,
        is_demo      INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0,1)),
        created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
      );

      -- Multiple users CAN share one area; no implicit/city-wide visibility.
      CREATE TABLE IF NOT EXISTS area_access (
        area_id    INTEGER NOT NULL REFERENCES areas(id) ON DELETE CASCADE,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        PRIMARY KEY (area_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS analyses (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        area_id      INTEGER NOT NULL REFERENCES areas(id) ON DELETE CASCADE,
        climate_type TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','running','complete','failed')),
        params       TEXT,             -- JSON blob (scoring params)
        summary      TEXT,             -- JSON blob (area-level summary, slice 3)
        created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_analyses_area ON analyses(area_id, created_at);

      -- Building footprints fetched from OpenStreetMap (slice 2).
      CREATE TABLE IF NOT EXISTS structures (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        area_id      INTEGER NOT NULL REFERENCES areas(id) ON DELETE CASCADE,
        osm_id       TEXT,
        centroid_lat REAL NOT NULL,
        centroid_lon REAL NOT NULL,
        footprint    TEXT,             -- JSON polygon ring(s)
        props        TEXT              -- JSON: area_m2, levels, building type, ...
      );
      CREATE INDEX IF NOT EXISTS idx_structures_area ON structures(area_id);

      -- One row per structure per analysis: hazard breakdown + overall score.
      CREATE TABLE IF NOT EXISTS structure_scores (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        analysis_id   INTEGER NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
        structure_id  INTEGER NOT NULL REFERENCES structures(id) ON DELETE CASCADE,
        hazard_scores TEXT,             -- JSON: { flood: 3, cyclone_wind: 2, ... }
        overall_score INTEGER NOT NULL CHECK (overall_score BETWEEN 1 AND 5),
        risk_category TEXT NOT NULL
                      CHECK (risk_category IN ('very_low','low','medium','high','very_high')),
        computed_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_scores_analysis ON structure_scores(analysis_id, overall_score);
    `);
    db.exec(`PRAGMA user_version = 1;`);
  }
}

export type UserRow = {
  id: number;
  email: string;
  name: string;
  password_hash: string;
  role: "admin" | "analyst" | "viewer";
  created_at: string;
};

export type AreaRow = {
  id: number;
  name: string;
  city: string;
  country: string;
  center_lat: number;
  center_lng: number;
  radius_km: number;
  climate_type: string;
  is_demo: 0 | 1;
  created_by: number | null;
  created_at: string;
};

export type AnalysisRow = {
  id: number;
  area_id: number;
  climate_type: string;
  status: "pending" | "running" | "complete" | "failed";
  params: string | null;
  summary: string | null;
  created_by: number | null;
  created_at: string;
  completed_at: string | null;
};

export const db = openDb();

export function parseJsonSafe<T>(text: string | null | undefined): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
