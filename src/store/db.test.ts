import { describe, test, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openStoreDb,
  getJournalMode,
  getPragmaNumber,
  listTables,
  type StoreDb,
} from './db';

const REQUIRED_TABLES = ['commerce_operation_audit', 'commerce_operations'].sort();

const createdStores: StoreDb[] = [];

function openMemoryDb(): StoreDb {
  const store = openStoreDb(':memory:');
  createdStores.push(store);
  return store;
}

function openFileDb(): { store: StoreDb; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'commercepilot-db-test-'));
  const store = openStoreDb(join(dir, 'store.sqlite3'));
  createdStores.push(store);
  return { store, dir };
}

afterEach(() => {
  for (const store of createdStores.splice(0)) {
    try {
      store.close();
    } catch {
      // already closed
    }
  }
});

describe('store SQLite infrastructure (node:sqlite)', () => {
  test('opens a database successfully (memory-backed)', () => {
    const { store } = { store: openMemoryDb() };
    expect(store.db).toBeDefined();
    expect(store.isFileBacked).toBe(false);
    // Sanity: the handle works.
    const row = store.db.prepare('SELECT 1 AS one;').get() as { one: number };
    expect(row.one).toBe(1);
  });

  test('initializes the schema on open', () => {
    const store = openMemoryDb();
    const tables = listTables(store.db);
    expect([...tables].sort()).toEqual(REQUIRED_TABLES);
  });

  test('foreign_keys pragma is enabled', () => {
    const store = openMemoryDb();
    expect(getPragmaNumber(store.db, 'foreign_keys')).toBe(1);
  });

  test('file-backed databases use WAL journal mode; :memory: stays memory', () => {
    const { store: fileStore } = openFileDb();
    expect(getJournalMode(fileStore.db)).toBe('wal');

    const memStore = openMemoryDb();
    expect(getJournalMode(memStore.db)).toBe('memory');
  });

  test('required tables exist with the benchmarked columns', () => {
    const store = openMemoryDb();
    const db = store.db;

    const opColumns = (
      db.prepare("PRAGMA table_info(commerce_operations);").all() as Array<Record<string, unknown>>
    ).map((c) => String(c.name));
    expect(opColumns).toEqual(
      expect.arrayContaining([
        'id',
        'opportunity_id',
        'status',
        'snapshot',
        'created_at',
        'updated_at',
      ])
    );

    const auditColumns = (
      db.prepare("PRAGMA table_info(commerce_operation_audit);").all() as Array<Record<string, unknown>>
    ).map((c) => String(c.name));
    expect(auditColumns).toEqual(
      expect.arrayContaining([
        'id',
        'operation_id',
        'event_seq',
        'event_type',
        'event_json',
        'occurred_at',
      ])
    );
  });

  test(':memory: databases are isolated from each other', () => {
    const a = openMemoryDb();
    const b = openMemoryDb();

    a.db.prepare(
      "INSERT INTO commerce_operations (id, opportunity_id, status, snapshot, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?);"
    ).run('op-A', 'opp-1', 'OPPORTUNITY', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

    const countA = (a.db.prepare('SELECT COUNT(*) AS n FROM commerce_operations;').get() as { n: number }).n;
    const countB = (b.db.prepare('SELECT COUNT(*) AS n FROM commerce_operations;').get() as { n: number }).n;

    expect(countA).toBe(1);
    expect(countB).toBe(0); // isolated: no leakage between :memory: databases
  });

  test('FK enforcement actually works (audit rows require their operation)', () => {
    const store = openMemoryDb();
    const db = store.db;

    // Inserting an audit row for a non-existent operation must fail.
    expect(() =>
      db.prepare(
        "INSERT INTO commerce_operation_audit (operation_id, event_seq, event_type, event_json, occurred_at) VALUES (?, ?, ?, ?, ?);"
      ).run('op-missing', 1, 'DECISION_PROPOSED', '{}', '2026-01-01T00:00:00.000Z')
    ).toThrow();

    // With the operation present, the same insert succeeds.
    db.prepare(
      "INSERT INTO commerce_operations (id, opportunity_id, status, snapshot, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?);"
    ).run('op-1', 'opp-1', 'OPPORTUNITY', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

    db.prepare(
      "INSERT INTO commerce_operation_audit (operation_id, event_seq, event_type, event_json, occurred_at) VALUES (?, ?, ?, ?, ?);"
    ).run('op-1', 1, 'DECISION_PROPOSED', '{}', '2026-01-01T00:00:00.000Z');

    const count = (db.prepare('SELECT COUNT(*) AS n FROM commerce_operation_audit;').get() as { n: number }).n;
    expect(count).toBe(1);

    // No ON DELETE CASCADE: deleting the operation while audit rows exist must fail,
    // and the audit rows must survive.
    expect(() => db.prepare('DELETE FROM commerce_operations WHERE id = ?;').run('op-1')).toThrow();
    const auditAfterFailedDelete = (
      db.prepare('SELECT COUNT(*) AS n FROM commerce_operation_audit;').get() as { n: number }
    ).n;
    expect(auditAfterFailedDelete).toBe(1);
  });

  test('uniqueness of (operation_id, event_seq) actually works', () => {
    const store = openMemoryDb();
    const db = store.db;

    db.prepare(
      "INSERT INTO commerce_operations (id, opportunity_id, status, snapshot, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?);"
    ).run('op-1', 'opp-1', 'OPPORTUNITY', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

    const insertAudit = db.prepare(
      "INSERT INTO commerce_operation_audit (operation_id, event_seq, event_type, event_json, occurred_at) VALUES (?, ?, ?, ?, ?);"
    );

    insertAudit.run('op-1', 1, 'DECISION_PROPOSED', '{}', '2026-01-01T00:00:00.000Z');

    // Same (operation_id, event_seq) must be rejected.
    expect(() =>
      insertAudit.run('op-1', 1, 'EXECUTION_STARTED', '{}', '2026-01-01T00:01:00.000Z')
    ).toThrow();

    // Same event_seq on a DIFFERENT operation is allowed (sequence is per-operation).
    db.prepare(
      "INSERT INTO commerce_operations (id, opportunity_id, status, snapshot, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?);"
    ).run('op-2', 'opp-2', 'OPPORTUNITY', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    expect(() => insertAudit.run('op-2', 1, 'DECISION_PROPOSED', '{}', '2026-01-01T00:00:00.000Z')).not.toThrow();

    // Next event_seq for the same operation is allowed.
    expect(() => insertAudit.run('op-1', 2, 'EXECUTION_STARTED', '{}', '2026-01-01T00:01:00.000Z')).not.toThrow();
  });

  test('schema initialization is idempotent and file-backed databases persist to disk', () => {
    const { store, dir } = openFileDb();
    // Re-running schema creation must not throw.
    expect(() => store.db.exec('CREATE TABLE IF NOT EXISTS commerce_operations (id TEXT PRIMARY KEY);')).not.toThrow();
    expect(listTables(store.db).sort()).toEqual(REQUIRED_TABLES);
    expect(existsSync(join(dir, 'store.sqlite3'))).toBe(true);

    // WAL sidecar files may exist while open; ensure they are ignorable artifacts.
    store.close();
    expect(existsSync(join(dir, 'store.sqlite3'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
