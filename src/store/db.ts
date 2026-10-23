import { DatabaseSync } from 'node:sqlite';

/**
 * SQLite infrastructure for the commerce operations store.
 *
 * Design notes (from the Task 06 architecture benchmark):
 * - The `commerce_operations` table persists an event-sourced snapshot of each
 *   CommerceOperation. The snapshot is the authoritative replayed state, stored
 *   as JSON so future `applyOperationEvent` can update it atomically alongside
 *   the appended audit row.
 * - The `commerce_operation_audit` table is the operation-local, append-only
 *   event log. Each row carries the event payload as JSON, its per-operation
 *   sequence number (`event_seq`), and the timestamp the event occurred.
 * - The audit table has an FK to `commerce_operations` WITHOUT ON DELETE
 *   CASCADE: audit rows must never disappear just because an operation row was
 *   deleted. Referential integrity is enforced, deletion is not propagated.
 * - `UNIQUE (operation_id, event_seq)` makes the audit sequence per-operation
 *   and is the concurrency guard a future atomic `applyOperationEvent`
 *   (INSERT audit row + UPDATE snapshot in a single transaction) relies on:
 *   two writers racing for the same event_seq cannot both succeed.
 *
 * Zero npm dependencies: uses Node's built-in `node:sqlite` (DatabaseSync).
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
  /** The underlying node:sqlite database handle. */
  readonly db: DatabaseSync;
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

  const db = new DatabaseSync(path, {
    enableForeignKeyConstraints: true,
  });

  // Enforce referential integrity (per-connection in SQLite).
  db.exec('PRAGMA foreign_keys = ON;');

  // WAL gives concurrent readers during a write transaction for file-backed
  // databases. In-memory databases do not support WAL (it is a no-op there).
  if (isFileBacked) {
    db.exec('PRAGMA journal_mode = WAL;');
  }

  // Wait up to busyTimeoutMs for a conflicting lock instead of failing fast.
  // This applies to both memory and file-backed databases.
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
function initializeSchema(db: DatabaseSync): void {
  db.exec(SCHEMA_SQL);
}

/** Read a PRAGMA value as a number (e.g. foreign_keys, busy_timeout). */
export function getPragmaNumber(db: DatabaseSync, pragma: string): number {
  const row = db.prepare(`PRAGMA ${pragma};`).get() as Record<string, unknown> | undefined;
  if (!row) return 0;
  const value = Object.values(row)[0];
  return typeof value === 'number' ? value : Number(value);
}

/** Read the journal mode of the database. */
export function getJournalMode(db: DatabaseSync): string {
  const row = db.prepare('PRAGMA journal_mode;').get() as Record<string, unknown> | undefined;
  return row ? String(Object.values(row)[0]) : 'unknown';
}

/** List table names in the database (excluding SQLite internals). */
export function listTables(db: DatabaseSync): string[] {
  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name;"
  ).all() as Array<Record<string, unknown>>;
  return rows.map((r) => String(r.name));
}
