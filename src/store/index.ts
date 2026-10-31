import type { SqliteDb, SqliteStatement } from './db';
import { CommerceOperationSchema, type CommerceOperation } from '../domain/schemas';
import {
  CommerceOperationEventSchema,
  type CommerceOperationEvent,
} from '../domain/events';
import { createInitialOperation, transitionOperation } from '../domain/stateMachine';

/**
 * Durable SQLite store for CommerceOperation snapshots and their append-only
 * audit trails (Checkpoint 2 of Task 06).
 *
 * Design:
 * - `commerce_operations.snapshot` (JSON) is the authoritative CURRENT state.
 *   Reads never replay audit events.
 * - `commerce_operation_audit` is append-only history of ACCEPTED transitions,
 *   written only inside the same transaction that persists the new snapshot.
 * - The only mutation path is `applyOperationEvent`, which wraps
 *   `BEGIN IMMEDIATE → load → revive+validate → transitionOperation → persist
 *   snapshot → append audit row → COMMIT`, rolling back on any failure.
 * - `transitionOperation` remains the single source of truth for lifecycle
 *   rules; illegal transitions throw before any write happens.
 *
 * Serialization: dates persist as ISO-8601 strings; reads JSON.parse → revive
 * Date fields → `CommerceOperationSchema.parse` (fails loudly on corruption).
 * Uses Node's built-in `node:sqlite` — no new npm dependencies.
 */

/** Error thrown when persisted data is corrupted or fails schema validation. */
export class StoreCorruptionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'StoreCorruptionError';
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/** ISO-8601 string → Date, failing loudly on anything that isn't valid. */
function reviveIsoDate(value: unknown, field: string, context: string): Date {
  if (typeof value !== 'string') {
    throw new StoreCorruptionError(
      `${context}: field "${field}" must be an ISO-8601 string, got ${typeof value}`
    );
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new StoreCorruptionError(
      `${context}: field "${field}" is not a valid ISO-8601 timestamp: ${JSON.stringify(value)}`
    );
  }
  return date;
}

const DATE_FIELDS = ['createdAt', 'updatedAt'] as const;

/** Revive persisted ISO-8601 date strings into Date instances. */
function reviveOperationDates(parsed: unknown, context: string): Record<string, unknown> {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new StoreCorruptionError(`${context}: expected a JSON object`);
  }
  const record = parsed as Record<string, unknown>;
  for (const field of DATE_FIELDS) {
    if (field in record) {
      record[field] = reviveIsoDate(record[field], field, context);
    }
  }
  return record;
}

/** Parse + validate a persisted CommerceOperation snapshot (JSON string). */
function parsePersistedOperation(snapshotJson: string, operationId: string): CommerceOperation {
  const context = `Corrupted persisted operation ${operationId}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshotJson);
  } catch (err) {
    throw new StoreCorruptionError(`${context}: snapshot is not valid JSON`, { cause: err });
  }
  const revived = reviveOperationDates(parsed, context);
  const result = CommerceOperationSchema.safeParse(revived);
  if (!result.success) {
    throw new StoreCorruptionError(
      `${context}: failed CommerceOperationSchema validation: ${result.error.message}`,
      { cause: result.error }
    );
  }
  return result.data;
}

/** Parse + validate a persisted audit event payload against the event schemas. */
function parsePersistedEvent(
  eventJson: string,
  eventType: string,
  operationId: string,
  eventSeq: number
): CommerceOperationEvent {
  const context = `Corrupted audit event (seq ${eventSeq}) for operation ${operationId}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(eventJson);
  } catch (err) {
    throw new StoreCorruptionError(`${context}: event_json is not valid JSON`, { cause: err });
  }
  const result = CommerceOperationEventSchema.safeParse(parsed);
  if (!result.success) {
    throw new StoreCorruptionError(
      `${context}: failed event schema validation: ${result.error.message}`,
      { cause: result.error }
    );
  }
  if (result.data.type !== eventType) {
    throw new StoreCorruptionError(
      `${context}: event payload type "${result.data.type}" does not match stored event_type "${eventType}"`
    );
  }
  return result.data;
}

/** JSON.stringify replacer: Date → ISO-8601 string (defense in depth). */
function dateToIsoReplacer(_key: string, value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

/** Serialize a CommerceOperation for persistence (dates → ISO-8601 strings). */
function serializeOperation(operation: CommerceOperation): string {
  return JSON.stringify(
    {
      ...operation,
      createdAt: operation.createdAt.toISOString(),
      updatedAt: operation.updatedAt.toISOString(),
    },
    dateToIsoReplacer
  );
}

/** Serialize an event payload for persistence. */
function serializeEvent(event: CommerceOperationEvent): string {
  return JSON.stringify(event, dateToIsoReplacer);
}

/** An accepted transition recorded in the audit trail. */
export interface OperationAuditEntry {
  /** Per-operation sequence number (1-based, deterministic read order). */
  readonly eventSeq: number;
  /** The validated event payload. */
  readonly event: CommerceOperationEvent;
  /** When the event occurred (timestamp passed to applyOperationEvent). */
  readonly occurredAt: Date;
  /** Row insertion order (monotonic across all operations). */
  readonly rowId: number;
}

/** Result of an accepted transition via applyOperationEvent. */
export interface AppliedOperationEvent {
  readonly operationId: string;
  readonly eventSeq: number;
  readonly previousStatus: CommerceOperation['status'];
  readonly newStatus: CommerceOperation['status'];
  readonly operation: CommerceOperation;
}

export interface CommerceOperationStoreOptions {
  /** The sqlite database handle (from `openStoreDb(path).db`). */
  readonly db: SqliteDb;
}

function assertValidTimestamp(timestamp: Date, context: string): void {
  if (!(timestamp instanceof Date) || Number.isNaN(timestamp.getTime())) {
    throw new TypeError(`${context} requires a valid Date timestamp`);
  }
}

/** Validate an event payload against the union of event Zod schemas. */
function validateEvent(
  event: CommerceOperationEvent,
  operationId: string
): CommerceOperationEvent {
  const result = CommerceOperationEventSchema.safeParse(event);
  if (!result.success) {
    throw new TypeError(`Invalid event for operation ${operationId}: ${result.error.message}`);
  }
  return result.data;
}

/**
 * Durable store for commerce operations. Production callers receive only the
 * typed API below — no raw database access, no arbitrary mutation or delete.
 * Tests may construct their own database handle (e.g. ':memory:') and inject it
 * via `new CommerceOperationStore({ db })` together with `openStoreDb(...)`.
 */
export class CommerceOperationStore {
  #db: SqliteDb;
  #insertOperationStmt: SqliteStatement;
  #updateOperationStmt: SqliteStatement;
  #maxEventSeqStmt: SqliteStatement;
  #insertAuditStmt: SqliteStatement;
  #getOperationStmt: SqliteStatement;
  #listOperationsStmt: SqliteStatement;
  #listAuditStmt: SqliteStatement;

  constructor(options: CommerceOperationStoreOptions) {
    this.#db = options.db;

    this.#insertOperationStmt = this.#db.prepare(
      `INSERT INTO commerce_operations (id, opportunity_id, status, snapshot, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?);`
    );
    this.#updateOperationStmt = this.#db.prepare(
      `UPDATE commerce_operations
       SET status = ?, snapshot = ?, updated_at = ?
       WHERE id = ?;`
    );
    this.#maxEventSeqStmt = this.#db.prepare(
      `SELECT COALESCE(MAX(event_seq), 0) AS max_seq
       FROM commerce_operation_audit WHERE operation_id = ?;`
    );
    this.#insertAuditStmt = this.#db.prepare(
      `INSERT INTO commerce_operation_audit (operation_id, event_seq, event_type, event_json, occurred_at)
       VALUES (?, ?, ?, ?, ?);`
    );
    this.#getOperationStmt = this.#db.prepare(
      `SELECT snapshot FROM commerce_operations WHERE id = ?;`
    );
    this.#listOperationsStmt = this.#db.prepare(
      `SELECT id, snapshot FROM commerce_operations ORDER BY created_at ASC, id ASC;`
    );
    this.#listAuditStmt = this.#db.prepare(
      `SELECT id, event_seq, event_type, event_json, occurred_at
       FROM commerce_operation_audit
       WHERE operation_id = ?
       ORDER BY event_seq ASC;`
    );
  }

  /**
   * Create a new operation in OPPORTUNITY status and persist its initial
   * snapshot. Rejects duplicate operation IDs.
   */
  createOperation(
    operationId: string,
    opportunityId: string,
    timestamp: Date
  ): CommerceOperation {
    assertValidTimestamp(timestamp, 'createOperation');
    const existing = this.#getOperationStmt.get(operationId);
    if (existing) {
      throw new Error(`Operation with ID ${operationId} already exists`);
    }
    const operation = createInitialOperation({ id: opportunityId }, operationId, timestamp);
    this.#insertOperationStmt.run(
      operation.id,
      operation.opportunityId,
      operation.status,
      serializeOperation(operation),
      operation.createdAt.toISOString(),
      operation.updatedAt.toISOString()
    );
    return operation;
  }

  /** Get the current persisted snapshot of an operation, or undefined. */
  getOperation(operationId: string): CommerceOperation | undefined {
    const row = this.#getOperationStmt.get(operationId) as { snapshot: string } | undefined;
    if (!row) return undefined;
    return parsePersistedOperation(row.snapshot, operationId);
  }

  /** List all operations (current snapshots), ordered by created_at then id. */
  listOperations(): CommerceOperation[] {
    const rows = this.#listOperationsStmt.all() as Array<{ id: string; snapshot: string }>;
    return rows.map((row) => parsePersistedOperation(row.snapshot, row.id));
  }

  /**
   * Read an operation's audit trail in deterministic order (event_seq).
   * Every persisted payload is validated; corruption fails loudly.
   */
  getAuditTrail(operationId: string): OperationAuditEntry[] {
    const rows = this.#listAuditStmt.all(operationId) as Array<{
      id: number;
      event_seq: number;
      event_type: string;
      event_json: string;
      occurred_at: string;
    }>;
    return rows.map((row) => ({
      rowId: row.id,
      eventSeq: row.event_seq,
      event: parsePersistedEvent(row.event_json, row.event_type, operationId, row.event_seq),
      occurredAt: reviveIsoDate(
        row.occurred_at,
        'occurred_at',
        `Corrupted audit event (seq ${row.event_seq}) for operation ${operationId}`
      ),
    }));
  }

  /**
   * The normal mutation path. Sequence:
   *   validate event → BEGIN IMMEDIATE → load persisted CommerceOperation
   *   → parse/revive/validate with Zod → transitionOperation
   *   → persist resulting snapshot → append validated event to audit → COMMIT.
   * Any failure after BEGIN → ROLLBACK → rethrow.
   */
  applyOperationEvent(
    operationId: string,
    event: CommerceOperationEvent,
    timestamp: Date
  ): AppliedOperationEvent {
    // 1. Validate the event (before opening the transaction).
    const validatedEvent = validateEvent(event, operationId);
    assertValidTimestamp(timestamp, 'applyOperationEvent');

    // 2. BEGIN IMMEDIATE serializes writers; all steps below are atomic.
    this.#db.exec('BEGIN IMMEDIATE;');
    try {
      // 3. Load + parse + revive + validate the persisted snapshot.
      const row = this.#getOperationStmt.get(operationId) as { snapshot: string } | undefined;
      if (!row) {
        throw new Error(`Operation with ID ${operationId} not found`);
      }
      const existing = parsePersistedOperation(row.snapshot, operationId);

      // 4. Single source of truth for lifecycle transitions.
      const next = transitionOperation(existing, validatedEvent, timestamp);

      // 5. Persist the resulting snapshot (authoritative current state).
      this.#updateOperationStmt.run(
        next.status,
        serializeOperation(next),
        next.updatedAt.toISOString(),
        next.id
      );

      // 6. Append exactly one validated audit row (per-operation sequence).
      const { max_seq } = this.#maxEventSeqStmt.get(operationId) as { max_seq: number };
      const eventSeq = Number(max_seq) + 1;
      this.#insertAuditStmt.run(
        operationId,
        eventSeq,
        validatedEvent.type,
        serializeEvent(validatedEvent),
        timestamp.toISOString()
      );

      // 7. Commit.
      this.#db.exec('COMMIT;');
      return {
        operationId,
        eventSeq,
        previousStatus: existing.status,
        newStatus: next.status,
        operation: next,
      };
    } catch (err) {
      // ANY failure after BEGIN rolls the whole transaction back and rethrows.
      this.#db.exec('ROLLBACK;');
      throw err;
    }
  }
}
