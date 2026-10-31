import { describe, test, expect, afterEach } from 'vitest';
import {
  CommerceOperationStore,
  StoreCorruptionError,
  type CommerceOperationStoreOptions,
} from './index';
import { openStoreDb, type StoreDb, type SqliteDb } from './db';
import type { CommerceOperationEvent } from '../domain/events';
import {
  CommerceOperationEventSchema,
  DecisionProposedEventSchema,
  PolicyApprovedEventSchema,
} from '../domain/events';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const createdStores: StoreDb[] = [];

function makeDb(): SqliteDb {
  const store = openStoreDb(':memory:');
  createdStores.push(store);
  return store.db;
}

function makeStore(): { store: CommerceOperationStore; db: SqliteDb } {
  const db = makeDb();
  return { store: new CommerceOperationStore({ db }), db };
}

const T0 = new Date('2026-01-01T00:00:00.000Z');
const T1 = new Date('2026-01-01T00:01:00.000Z');
const T2 = new Date('2026-01-01T00:02:00.000Z');
const T3 = new Date('2026-01-01T00:03:00.000Z');
const T4 = new Date('2026-01-01T00:04:00.000Z');

function decisionProposedEvent(): CommerceOperationEvent {
  return DecisionProposedEventSchema.parse({
    type: 'DECISION_PROPOSED',
    decision: {
      opportunityId: 'opp-1',
      action: 'CREATE_PAYMENT',
      amount: 1000,
      currency: 'USD',
      recipient: 'customer@example.com',
      justification: 'Test payment',
    },
  });
}

function policyApprovedEvent(): CommerceOperationEvent {
  return PolicyApprovedEventSchema.parse({
    type: 'POLICY_APPROVED',
    policyResult: { decision: 'APPROVE', reason: 'Within limits' },
  });
}

/** Drive an operation up to AWAITING_HUMAN_APPROVAL. */
function driveToAwaitingApproval(
  store: CommerceOperationStore,
  operationId = 'op-1'
): void {
  store.createOperation(operationId, 'opp-1', T0);
  store.applyOperationEvent(operationId, decisionProposedEvent(), T1);
  store.applyOperationEvent(operationId, policyApprovedEvent(), T2);
  store.applyOperationEvent(operationId, { type: 'REQUEST_HUMAN_APPROVAL' }, T3);
}

/** Raw row counts straight from SQLite (bypasses the store API for assertions). */
function rawCounts(db: SqliteDb): { operations: number; audit: number } {
  const operations = (
    db.prepare('SELECT COUNT(*) AS n FROM commerce_operations;').get() as { n: number }
  ).n;
  const audit = (
    db.prepare('SELECT COUNT(*) AS n FROM commerce_operation_audit;').get() as { n: number }
  ).n;
  return { operations, audit };
}

/** Raw event_type values in event_seq order, read straight from SQLite. */
function rawAuditEventTypes(db: SqliteDb, operationId: string): string[] {
  return (
    db
      .prepare(
        'SELECT event_type FROM commerce_operation_audit WHERE operation_id = ? ORDER BY event_seq ASC;'
      )
      .all(operationId) as Array<{ event_type: string }>
  ).map((r) => r.event_type);
}

/** Overwrite the persisted snapshot JSON for an operation (corruption helper). */
function corruptSnapshot(db: SqliteDb, operationId: string, snapshotJson: string): void {
  db.prepare('UPDATE commerce_operations SET snapshot = ? WHERE id = ?;').run(
    snapshotJson,
    operationId
  );
}

/** Overwrite the raw audit JSON of an operation's n-th event (1-based). */
function corruptAuditJson(
  db: SqliteDb,
  operationId: string,
  eventSeq: number,
  eventJson: string
): void {
  db.prepare(
    'UPDATE commerce_operation_audit SET event_json = ? WHERE operation_id = ? AND event_seq = ?;'
  ).run(eventJson, operationId, eventSeq);
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

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe('CommerceOperationStore (durable SQLite, Checkpoint 2)', () => {
  test('A. create + read operation round-trips the persisted snapshot', () => {
    const { store } = makeStore();

    const created = store.createOperation('op-1', 'opp-1', T0);
    expect(created).toMatchObject({
      id: 'op-1',
      opportunityId: 'opp-1',
      status: 'OPPORTUNITY',
    });

    const read = store.getOperation('op-1');
    expect(read).toBeDefined();
    expect(read?.id).toBe('op-1');
    expect(read?.opportunityId).toBe('opp-1');
    expect(read?.status).toBe('OPPORTUNITY');
    expect(read?.createdAt).toEqual(T0);
    expect(read?.updatedAt).toEqual(T0);
    expect(read?.createdAt).toBeInstanceOf(Date);
  });

  test('B. listOperations returns current snapshots in deterministic order', () => {
    const { store } = makeStore();
    store.createOperation('op-1', 'opp-1', T0);
    store.createOperation('op-2', 'opp-2', T1);

    const listed = store.listOperations();
    expect(listed.map((o) => o.id)).toEqual(['op-1', 'op-2']);
    expect(listed.every((o) => o.createdAt instanceof Date)).toBe(true);

    // The list reflects the CURRENT persisted snapshot, not creation state.
    store.applyOperationEvent('op-1', decisionProposedEvent(), T2);
    expect(store.listOperations().find((o) => o.id === 'op-1')?.status).toBe(
      'DECISION_PROPOSED'
    );
  });

  test('C. accepted transition persists the new snapshot', () => {
    const { store } = makeStore();
    store.createOperation('op-1', 'opp-1', T0);

    const event = decisionProposedEvent();
    store.applyOperationEvent('op-1', event, T1);

    const op = store.getOperation('op-1');
    expect(op?.status).toBe('DECISION_PROPOSED');
    // Union narrowing: only DECISION_PROPOSED carries a `decision` payload.
    const decision = event.type === 'DECISION_PROPOSED' ? event.decision : undefined;
    expect(op?.decision).toEqual(decision);
    expect(op?.updatedAt).toEqual(T1);
    expect(op?.createdAt).toEqual(T0); // creation timestamp is immutable
  });

  test('D. accepted transition appends exactly one audit record', () => {
    const { store, db } = makeStore();
    store.createOperation('op-1', 'opp-1', T0);

    expect(store.getAuditTrail('op-1')).toEqual([]);

    store.applyOperationEvent('op-1', decisionProposedEvent(), T1);

    const trail = store.getAuditTrail('op-1');
    expect(trail).toHaveLength(1);
    expect(rawCounts(db).audit).toBe(1);
    expect(trail[0].eventSeq).toBe(1);
    expect(trail[0].event).toEqual(decisionProposedEvent());
    expect(trail[0].occurredAt).toEqual(T1);
  });

  test('E. multiple transitions preserve deterministic audit order', () => {
    const { store } = makeStore();
    driveToAwaitingApproval(store);
    store.applyOperationEvent('op-1', { type: 'HUMAN_APPROVED', approvalStatus: 'APPROVED' }, T4);

    const trail = store.getAuditTrail('op-1');
    expect(trail.map((e) => e.event.type)).toEqual([
      'DECISION_PROPOSED',
      'POLICY_APPROVED',
      'REQUEST_HUMAN_APPROVAL',
      'HUMAN_APPROVED',
    ]);
    expect(trail.map((e) => e.eventSeq)).toEqual([1, 2, 3, 4]);
    expect(trail.map((e) => e.occurredAt)).toEqual([T1, T2, T3, T4]);
    expect(store.getOperation('op-1')?.status).toBe('APPROVED');
  });

  test('F. illegal transition changes neither snapshot nor audit', () => {
    const { store, db } = makeStore();
    driveToAwaitingApproval(store);

    const beforeSnapshot = store.getOperation('op-1');
    const beforeCounts = rawCounts(db);

    // EXECUTION_STARTED is illegal from AWAITING_HUMAN_APPROVAL.
    expect(() =>
      store.applyOperationEvent('op-1', { type: 'EXECUTION_STARTED' }, T4)
    ).toThrow();

    const afterSnapshot = store.getOperation('op-1');
    const afterCounts = rawCounts(db);

    expect(afterSnapshot).toEqual(beforeSnapshot); // snapshot unchanged
    expect(afterCounts.audit).toBe(beforeCounts.audit); // NO audit row appended
    expect(afterCounts.operations).toBe(beforeCounts.operations);
  });

  test('G. audit INSERT failure after the snapshot UPDATE rolls back the snapshot', () => {
    const { store, db } = makeStore();
    driveToAwaitingApproval(store);

    const before = store.getOperation('op-1');
    const beforeCounts = rawCounts(db);

    // Force a GENUINE failure at the audit INSERT stage, AFTER the snapshot
    // UPDATE has already executed: a BEFORE INSERT trigger that raises ABORT.
    // The trigger leaves the audit table intact so post-conditions can be
    // asserted without reconstructing anything.
    db.exec(
      "CREATE TRIGGER force_audit_insert_failure BEFORE INSERT ON commerce_operation_audit " +
        "BEGIN SELECT RAISE(ABORT, 'forced audit INSERT failure'); END;"
    );

    expect(() =>
      store.applyOperationEvent('op-1', { type: 'HUMAN_APPROVED', approvalStatus: 'APPROVED' }, T4)
    ).toThrow(/forced audit INSERT failure/);

    // The snapshot UPDATE must have been rolled back: status is still
    // AWAITING_HUMAN_APPROVAL, and the operation row is intact.
    const after = store.getOperation('op-1');
    expect(after?.status).toBe('AWAITING_HUMAN_APPROVAL');
    expect(after?.approvalStatus).toBeUndefined();
    expect(after).toEqual(before);
    expect(after?.updatedAt).toEqual(T3);

    // No partial audit row and no extra operation rows.
    expect(rawCounts(db).operations).toBe(beforeCounts.operations);
    expect(rawAuditEventTypes(db, 'op-1')).toEqual([
      'DECISION_PROPOSED',
      'POLICY_APPROVED',
      'REQUEST_HUMAN_APPROVAL',
    ]);

    // The connection is usable again (no dangling open transaction).
    expect(() => store.createOperation('op-2', 'opp-2', T4)).not.toThrow();
    expect(store.getOperation('op-2')?.status).toBe('OPPORTUNITY');
  });

  test('H. corrupted persisted operation JSON fails loudly', () => {
    const { store, db } = makeStore();
    store.createOperation('op-1', 'opp-1', T0);
    corruptSnapshot(db, 'op-1', '{not valid json');

    expect(() => store.getOperation('op-1')).toThrow(StoreCorruptionError);
    expect(() => store.listOperations()).toThrow(StoreCorruptionError);
    expect(() =>
      store.applyOperationEvent('op-1', decisionProposedEvent(), T1)
    ).toThrow(StoreCorruptionError);
  });

  test('I. structurally invalid persisted operation fails Zod validation', () => {
    const { store, db } = makeStore();
    store.createOperation('op-1', 'opp-1', T0);

    // Valid JSON, but status is not in the status enum.
    corruptSnapshot(
      db,
      'op-1',
      JSON.stringify({
        id: 'op-1',
        opportunityId: 'opp-1',
        status: 'TOTALLY BOGUS STATUS',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      })
    );

    let caught: unknown;
    try {
      store.getOperation('op-1');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StoreCorruptionError);
    expect((caught as StoreCorruptionError).message).toContain('CommerceOperationSchema');
  });

  test('I2. non-Date persisted timestamps fail loudly', () => {
    const { store, db } = makeStore();
    store.createOperation('op-1', 'opp-1', T0);
    corruptSnapshot(
      db,
      'op-1',
      JSON.stringify({
        id: 'op-1',
        opportunityId: 'opp-1',
        status: 'OPPORTUNITY',
        createdAt: 12345, // not an ISO-8601 string
        updatedAt: '2026-01-01T00:00:00.000Z',
      })
    );
    expect(() => store.getOperation('op-1')).toThrow(StoreCorruptionError);
    expect(() => store.getOperation('op-1')).toThrow(/createdAt/);
  });

  test('J. corrupted audit event JSON fails loudly', () => {
    const { store, db } = makeStore();
    driveToAwaitingApproval(store);
    corruptAuditJson(db, 'op-1', 1, '{definitely not json');

    expect(() => store.getAuditTrail('op-1')).toThrow(StoreCorruptionError);
  });

  test('K. audit event payload/type mismatch fails loudly', () => {
    const { store, db } = makeStore();
    driveToAwaitingApproval(store);

    // Payload is a perfectly valid DECISION_PROPOSED event, but the row's
    // event_type column says POLICY_APPROVED — the mismatch must be detected.
    corruptAuditJson(db, 'op-1', 2, JSON.stringify(decisionProposedEvent()));

    let caught: unknown;
    try {
      store.getAuditTrail('op-1');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StoreCorruptionError);
    expect((caught as StoreCorruptionError).message).toContain('does not match stored event_type');
  });

  test('K2. structurally invalid audit payload fails event schema validation', () => {
    const { store, db } = makeStore();
    driveToAwaitingApproval(store);
    corruptAuditJson(
      db,
      'op-1',
      2,
      JSON.stringify({ type: 'POLICY_APPROVED' }) // missing policyResult
    );
    expect(() => store.getAuditTrail('op-1')).toThrow(StoreCorruptionError);
  });

  test('L. two operations remain isolated', () => {
    const { store } = makeStore();
    store.createOperation('op-1', 'opp-1', T0);
    store.createOperation('op-2', 'opp-2', T0);

    store.applyOperationEvent('op-1', decisionProposedEvent(), T1);

    expect(store.getOperation('op-1')?.status).toBe('DECISION_PROPOSED');
    expect(store.getOperation('op-2')?.status).toBe('OPPORTUNITY');
    expect(store.getAuditTrail('op-1')).toHaveLength(1);
    expect(store.getAuditTrail('op-2')).toHaveLength(0);
  });

  test('M. duplicate operation IDs are rejected', () => {
    const { store, db } = makeStore();
    store.createOperation('op-1', 'opp-1', T0);
    expect(() => store.createOperation('op-1', 'opp-1', T1)).toThrow(/already exists/);
    expect(rawCounts(db).operations).toBe(1);
  });

  test('M2. applyOperationEvent for a non-existent operation fails with rollback', () => {
    const { store, db } = makeStore();
    expect(() =>
      store.applyOperationEvent('missing', decisionProposedEvent(), T1)
    ).toThrow(/not found/);
    expect(rawCounts(db).operations).toBe(0);
    expect(rawCounts(db).audit).toBe(0);
  });

  test('M3. invalid event payloads are rejected before any write', () => {
    const { store, db } = makeStore();
    store.createOperation('op-1', 'opp-1', T0);

    expect(() =>
      store.applyOperationEvent(
        'op-1',
        { type: 'DECISION_PROPOSED', decision: { bogus: true } } as unknown as CommerceOperationEvent,
        T1
      )
    ).toThrow(TypeError);

    expect(rawCounts(db).audit).toBe(0);
    expect(store.getOperation('op-1')?.status).toBe('OPPORTUNITY');
  });

  test('N. public API exposes no arbitrary mutation or delete path', () => {
    const { store } = makeStore();

    const proto = Object.getPrototypeOf(store) as Record<string, unknown>;
    const methods = Object.getOwnPropertyNames(proto).filter(
      (name) => name !== 'constructor'
    );
    expect(methods.sort()).toEqual(
      [
        'applyOperationEvent',
        'createOperation',
        'getAuditTrail',
        'getOperation',
        'listOperations',
      ].sort()
    );

    for (const forbidden of [
      'setStatus',
      'saveOperation',
      'updateOperation',
      'save',
      'update',
      'recordEvent',
      'deleteOperation',
      'removeOperation',
      'delete',
      'clear',
      'clearAll',
      'rawDb',
      'db',
      'exec',
    ]) {
      expect(methods).not.toContain(forbidden);
      expect(forbidden in store).toBe(false);
      expect((store as unknown as Record<string, unknown>)[forbidden]).toBeUndefined();
    }

    // The private db handle is not exposed as an own/enumerable property
    // (true #private class fields keep it completely inaccessible).
    expect(Object.keys(store)).toEqual([]);
  });

  test('O. Date serialization round-trip preserves valid CommerceOperation values', () => {
    const { store } = makeStore();
    driveToAwaitingApproval(store);
    store.applyOperationEvent('op-1', { type: 'HUMAN_APPROVED', approvalStatus: 'APPROVED' }, T4);
    store.applyOperationEvent(
      'op-1',
      { type: 'EXECUTION_STARTED' },
      new Date('2026-01-01T00:05:00.000Z')
    );

    const current = store.getOperation('op-1');
    const trail = store.getAuditTrail('op-1');

    // Every timestamp is a real Date instance (not a string).
    expect(current?.createdAt).toBeInstanceOf(Date);
    expect(current?.updatedAt).toBeInstanceOf(Date);
    for (const entry of trail) {
      expect(entry.occurredAt).toBeInstanceOf(Date);
    }

    // Millisecond precision is preserved exactly.
    const precise = new Date('2026-03-04T05:06:07.891Z');
    store.createOperation('op-2', 'opp-2', precise);
    expect(store.getOperation('op-2')?.createdAt).toEqual(precise);
  });

  test('P. integrates with openStoreDb(":memory:") and returns transition details', () => {
    const db = makeDb();
    const store = new CommerceOperationStore({ db } satisfies CommerceOperationStoreOptions);
    store.createOperation('op-1', 'opp-1', T0);
    const result = store.applyOperationEvent('op-1', decisionProposedEvent(), T1);
    expect(result.previousStatus).toBe('OPPORTUNITY');
    expect(result.newStatus).toBe('DECISION_PROPOSED');
    expect(result.eventSeq).toBe(1);
    expect(result.operation.status).toBe('DECISION_PROPOSED');
    expect(store.getOperation('op-1')).toEqual(result.operation);
  });

  test('Q. transitionOperation remains the single source of truth for lifecycle', () => {
    const { store, db } = makeStore();
    store.createOperation('op-1', 'opp-1', T0);

    // POLICY_APPROVED directly from OPPORTUNITY is illegal per the state machine.
    expect(() => store.applyOperationEvent('op-1', policyApprovedEvent(), T1)).toThrow(
      /Only DECISION_PROPOSED event is allowed/
    );

    // OPPORTUNITY → DECISION_PROPOSED → POLICY_APPROVED (legal path).
    store.applyOperationEvent('op-1', decisionProposedEvent(), T1);
    store.applyOperationEvent('op-1', policyApprovedEvent(), T2);
    expect(store.getOperation('op-1')?.status).toBe('POLICY_APPROVED');

    // Audit contains only the two accepted transitions.
    expect(rawAuditEventTypes(db, 'op-1')).toEqual([
      'DECISION_PROPOSED',
      'POLICY_APPROVED',
    ]);
  });

  test('R. event Zod schemas are the exact persistence validation source', () => {
    // Sanity: the union schema used by the store parses what it must accept.
    const event = decisionProposedEvent();
    expect(CommerceOperationEventSchema.safeParse(event).success).toBe(true);
    expect(CommerceOperationEventSchema.safeParse({ type: 'NO_SUCH_EVENT' }).success).toBe(
      false
    );
    // And rejects malformed payloads of known types.
    expect(
      CommerceOperationEventSchema.safeParse({ type: 'POLICY_APPROVED' }).success
    ).toBe(false);
  });

  test('S. capture flow round-trips durably: PAYPAL_ORDER_CREATED → CAPTURE_EXECUTING → COMPLETED (Task 09 CP2)', () => {
    const { store, db } = makeStore();
    const T5 = new Date('2026-01-01T00:05:00.000Z');
    const T6 = new Date('2026-01-01T00:06:00.000Z');
    const T7 = new Date('2026-01-01T00:07:00.000Z');

    // Drive to APPROVED → EXECUTING using the existing helpers.
    driveToAwaitingApproval(store);
    store.applyOperationEvent('op-1', { type: 'HUMAN_APPROVED', approvalStatus: 'APPROVED' }, T4);
    store.applyOperationEvent('op-1', { type: 'EXECUTION_STARTED' }, T5);

    // Durable PayPal order, then the capture claim.
    const paypalOrder = {
      paypalOrderId: 'pp-order-789',
      paypalStatus: 'CREATED',
      requestId: 'commercepilot-op-op-1',
    };
    store.applyOperationEvent(
      'op-1',
      { type: 'PAYPAL_ORDER_CREATED', paypalOrder },
      new Date('2026-01-01T00:05:30.000Z')
    );

    const claim = store.applyOperationEvent('op-1', { type: 'CAPTURE_STARTED' }, T6);
    expect(claim.previousStatus).toBe('PAYPAL_ORDER_CREATED');
    expect(claim.newStatus).toBe('CAPTURE_EXECUTING');

    const afterClaim = store.getOperation('op-1');
    expect(afterClaim?.status).toBe('CAPTURE_EXECUTING');
    expect(afterClaim?.paypalOrder).toEqual(paypalOrder);
    expect(afterClaim?.paymentResult).toBeUndefined();

    // Capture outcome with full truthful evidence → COMPLETED.
    const paymentResult = {
      success: true,
      transactionId: 'cap-123',
      captureId: 'cap-123',
      paypalOrderId: 'pp-order-789',
      amount: 1000,
      currency: 'USD' as const,
    };
    const outcome = store.applyOperationEvent(
      'op-1',
      { type: 'PAYMENT_COMPLETED', paymentResult },
      T7
    );
    expect(outcome.previousStatus).toBe('CAPTURE_EXECUTING');
    expect(outcome.newStatus).toBe('COMPLETED');

    const completed = store.getOperation('op-1');
    expect(completed?.status).toBe('COMPLETED');
    expect(completed?.paymentResult).toEqual(paymentResult);
    // Evidence survives the snapshot round-trip exactly.
    expect(completed?.paymentResult?.captureId).toBe('cap-123');
    expect(completed?.paymentResult?.paypalOrderId).toBe('pp-order-789');
    expect(completed?.paypalOrder).toEqual(paypalOrder);

    // Full durable audit trail, in order, with the new event persisted.
    expect(rawAuditEventTypes(db, 'op-1')).toEqual([
      'DECISION_PROPOSED',
      'POLICY_APPROVED',
      'REQUEST_HUMAN_APPROVAL',
      'HUMAN_APPROVED',
      'EXECUTION_STARTED',
      'PAYPAL_ORDER_CREATED',
      'CAPTURE_STARTED',
      'PAYMENT_COMPLETED',
    ]);

    // The claimed capture is single-flight at the store boundary: a second
    // CAPTURE_STARTED after COMPLETED is an illegal transition → rollback.
    const before = rawCounts(db);
    expect(() => store.applyOperationEvent('op-1', { type: 'CAPTURE_STARTED' }, T7)).toThrow();
    expect(rawCounts(db)).toEqual(before);
  });

  test('S2. capture claim without a persisted order and foreign-order evidence are both rejected', () => {
    const { store, db } = makeStore();
    const T5 = new Date('2026-01-01T00:05:00.000Z');
    const T6 = new Date('2026-01-01T00:06:00.000Z');
    const T7 = new Date('2026-01-01T00:07:00.000Z');

    // Part 1: a CAPTURE_STARTED on a PAYPAL_ORDER_CREATED snapshot that has
    // NO paypalOrder field (schema-valid, but integrity-broken) must be
    // rejected — there is no durable order to capture.
    driveToAwaitingApproval(store);
    store.applyOperationEvent('op-1', { type: 'HUMAN_APPROVED', approvalStatus: 'APPROVED' }, T4);
    store.applyOperationEvent('op-1', { type: 'EXECUTION_STARTED' }, T5);
    db.prepare('UPDATE commerce_operations SET status = ?, snapshot = ?, updated_at = ? WHERE id = ?;').run(
      'PAYPAL_ORDER_CREATED',
      JSON.stringify({
        id: 'op-1',
        opportunityId: 'opp-1',
        status: 'PAYPAL_ORDER_CREATED',
        decision: {
          opportunityId: 'opp-1',
          action: 'CREATE_PAYMENT',
          amount: 1000,
          currency: 'USD',
          recipient: 'customer@example.com',
          justification: 'Test payment',
        },
        policyResult: { decision: 'APPROVE', reason: 'Within limits' },
        approvalStatus: 'APPROVED',
        createdAt: T0.toISOString(),
        updatedAt: T5.toISOString(),
        // NOTE: no paypalOrder field — the integrity fault under test.
      }),
      T5.toISOString(),
      'op-1'
    );
    expect(() => store.applyOperationEvent('op-1', { type: 'CAPTURE_STARTED' }, T6)).toThrow(
      /requires a persisted paypalOrder/
    );

    // Part 2: with a real persisted order, a capture outcome tied to a
    // DIFFERENT order must be rejected as foreign evidence.
    driveToAwaitingApproval(store, 'op-2');
    store.applyOperationEvent('op-2', { type: 'HUMAN_APPROVED', approvalStatus: 'APPROVED' }, T4);
    store.applyOperationEvent('op-2', { type: 'EXECUTION_STARTED' }, T5);
    store.applyOperationEvent(
      'op-2',
      {
        type: 'PAYPAL_ORDER_CREATED',
        paypalOrder: {
          paypalOrderId: 'pp-order-789',
          paypalStatus: 'CREATED',
          requestId: 'commercepilot-op-op-2',
        },
      },
      T5
    );
    store.applyOperationEvent('op-2', { type: 'CAPTURE_STARTED' }, T6);

    expect(() =>
      store.applyOperationEvent(
        'op-2',
        {
          type: 'PAYMENT_COMPLETED',
          paymentResult: {
            success: true,
            transactionId: 'cap-foreign',
            captureId: 'cap-foreign',
            paypalOrderId: 'pp-FOREIGN-order',
            amount: 1000,
            currency: 'USD',
          },
        },
        T7
      )
    ).toThrow(/does not match the operation's persisted order/);

    // The violating event changed nothing (rolled back before any write).
    expect(store.getOperation('op-2')?.status).toBe('CAPTURE_EXECUTING');
    expect(store.getOperation('op-2')?.paymentResult).toBeUndefined();
  });
});
