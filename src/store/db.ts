import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * SQLite infrastructure for the commerce operations store.
 *
 * Uses `better-sqlite3` native synchronous bindings for robust file/memory SQLite.
 */

/** Default busy timeout in milliseconds. Allows writers to wait on locks. */
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS commerce_operations (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL,
  status TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS commerce_operation_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL,
  event_seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  event_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  FOREIGN KEY (operation_id) REFERENCES commerce_operations (id)
    ON DELETE RESTRICT,
  UNIQUE (operation_id, event_seq)
);

CREATE INDEX IF NOT EXISTS idx_commerce_operation_audit_operation_id
  ON commerce_operation_audit (operation_id, event_seq);
`;

export interface SqliteStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

export interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export interface StoreDbOptions {
  /**
   * Path to the database file, or ':memory:' for an isolated in-memory
   * database (used by tests).
   */
  path: string;
  /** Busy timeout in milliseconds. Default: 5000. */
  busyTimeoutMs?: number;
}

export interface StoreDb {
  /** The underlying database handle. */
  readonly db: SqliteDb;
  /** True when the database is file-backed (not ':memory:'). */
  readonly isFileBacked: boolean;
  /** Close the database handle. */
  close(): void;
}

/**
 * Open (and create if needed) the store database, enabling foreign keys,
 * WAL journaling for file-backed databases, and a busy timeout, then
 * initialize the schema.
 *
 * @param path Filesystem path for the database file, or ':memory:' for tests.
 */
export function openStoreDb(options: StoreDbOptions | string): StoreDb {
  const opts: StoreDbOptions = typeof options === 'string' ? { path: options } : options;
  const { path, busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS } = opts;

  const isFileBacked = path !== ':memory:';

  if (isFileBacked) {
    const parentDir = dirname(resolve(path));
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }
  }

  const db = new Database(path, {
    timeout: Math.max(0, Math.floor(busyTimeoutMs)),
  });

  // Enforce referential integrity (per-connection in SQLite).
  db.exec('PRAGMA foreign_keys = ON;');

  // WAL gives concurrent readers during a write transaction for file-backed
  // databases. In-memory databases do not support WAL (it is a no-op there).
  if (isFileBacked) {
    db.exec('PRAGMA journal_mode = WAL;');
  }

  // Wait up to busyTimeoutMs for a conflicting lock instead of failing fast.
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))};`);

  initializeSchema(db);

  return {
    db,
    isFileBacked,
    close(): void {
      db.close();
    },
  };
}

/** Initialize the two conceptual tables (idempotent). */
function initializeSchema(db: SqliteDb): void {
  db.exec(SCHEMA_SQL);
}

/** Read a PRAGMA value as a number (e.g. foreign_keys, busy_timeout). */
export function getPragmaNumber(db: SqliteDb, pragma: string): number {
  const row = db.prepare(`PRAGMA ${pragma};`).get() as Record<string, unknown> | undefined;
  if (!row) return 0;
  const value = Object.values(row)[0];
  return typeof value === 'number' ? value : Number(value);
}

/** Read the journal mode of the database. */
export function getJournalMode(db: SqliteDb): string {
  const row = db.prepare('PRAGMA journal_mode;').get() as Record<string, unknown> | undefined;
  return row ? String(Object.values(row)[0]) : 'unknown';
}

/** List table names in the database (excluding SQLite internals). */
export function listTables(db: SqliteDb): string[] {
  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name;"
  ).all() as Array<Record<string, unknown>>;
  return rows.map((r) => String(r.name));
}
