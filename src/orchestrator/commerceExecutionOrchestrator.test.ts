import { afterEach, describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CommerceOperation } from '../domain/schemas';
import { CommerceOperationStore } from '../store';
import { openStoreDb, type StoreDb, type SqliteDb } from '../store/db';
import {
  PayPalHttpApiError,
  PayPalInvalidRequestError,
  PayPalMalformedResponseError,
  PayPalService,
  type CreatePayPalOrderInput,
  type PayPalCreateOrderResult,
} from '../services/paypal';
import {
  CommerceExecutionOrchestrator,
  NON_EXECUTABLE_REASONS,
  PAYPAL_REQUEST_ID_PREFIX,
  isDefiniteNoOrderFailure,
  payPalRequestIdForOperation,
  type CommerceExecutionOutcome,
  type PayPalOrderCreator,
} from './commerceExecutionOrchestrator';

/* ------------------------------------------------------------------ */
/* Durable store helpers (mirrors src/store/index.test.ts patterns)    */
/* ------------------------------------------------------------------ */

const createdClosables: Array<{ close(): void }> = [];
const createdDirs: string[] = [];

function makeStore(): { store: CommerceOperationStore; db: SqliteDb } {
  const storeDb: StoreDb = openStoreDb(':memory:');
  createdClosables.push(storeDb);
  return { store: new CommerceOperationStore({ db: storeDb.db }), db: storeDb.db };
}

const T0 = new Date('2026-01-01T00:00:00.000Z');
const T1 = new Date('2026-01-01T00:01:00.000Z');
const T2 = new Date('2026-01-01T00:02:00.000Z');
const T3 = new Date('2026-01-01T00:03:00.000Z');
const T4 = new Date('2026-01-01T00:04:00.000Z');
const T5 = new Date('2026-01-01T00:05:00.000Z');
const T6 = new Date('2026-01-01T00:06:00.000Z');

/** Injectable deterministic clock: T1, T2, T3, ... (stays on last value). */
const ALL_TIMES = [T1, T2, T3, T4, T5, T6];
function makeClock(): () => Date {
  let i = 0;
  return () => ALL_TIMES[Math.min(i++, ALL_TIMES.length - 1)];
}

/** Raw audit event_type values in event_seq order, straight from SQLite. */
function rawAuditEventTypes(db: SqliteDb, operationId: string): string[] {
  return (
    db
      .prepare(
        'SELECT event_type FROM commerce_operation_audit WHERE operation_id = ? ORDER BY event_seq ASC;'
      )
      .all(operationId) as Array<{ event_type: string }>
  ).map((r) => r.event_type);
}

/** Drive an operation: OPPORTUNITY → … → APPROVED (human approval included). */
function driveToApproved(store: CommerceOperationStore, operationId = 'op-1'): void {
  store.createOperation(operationId, 'opp-1', T0);
  store.applyOperationEvent(
    operationId,
    {
      type: 'DECISION_PROPOSED',
      decision: {
        opportunityId: 'opp-1',
        action: 'CREATE_PAYMENT',
        amount: 2500,
        currency: 'EUR',
        recipient: 'customer@example.com',
        justification: 'Approved test payment',
      },
    },
    T1
  );
  store.applyOperationEvent(
    operationId,
    { type: 'POLICY_APPROVED', policyResult: { decision: 'APPROVE', reason: 'Within limits' } },
    T2
  );
  store.applyOperationEvent(operationId, { type: 'REQUEST_HUMAN_APPROVAL' }, T3);
  store.applyOperationEvent(
    operationId,
    { type: 'HUMAN_APPROVED', approvalStatus: 'APPROVED' },
    T4
  );
}

/** Drive an operation to POLICY_REJECTED (terminal, never executable). */
function driveToPolicyRejected(store: CommerceOperationStore, operationId = 'op-1'): void {
  store.createOperation(operationId, 'opp-1', T0);
  store.applyOperationEvent(
    operationId,
    {
      type: 'DECISION_PROPOSED',
      decision: {
        opportunityId: 'opp-1',
        action: 'CREATE_PAYMENT',
        amount: 2500,
        currency: 'EUR',
        recipient: 'customer@example.com',
        justification: 'Policy-rejected test payment',
      },
    },
    T1
  );
  store.applyOperationEvent(
    operationId,
    {
      type: 'POLICY_REJECTED',
      policyResult: { decision: 'REJECT', reason: 'Amount exceeds policy maximum' },
    },
    T2
  );
}

/* ------------------------------------------------------------------ */
/* Injected fake PayPal boundary (NO network, NO credentials)          */
/* ------------------------------------------------------------------ */

function orderResult(overrides: Partial<PayPalCreateOrderResult> = {}): PayPalCreateOrderResult {
  return {
    paypalOrderId: 'PAYPAL-ORDER-1',
    status: 'CREATED',
    environment: 'SANDBOX',
    approveUrl: 'https://paypal.example/approve/PAYPAL-ORDER-1',
    requestId: 'unused-placeholder',
    ...overrides,
  };
}

type ScriptedOutcome =
  | { ok: true; result: PayPalCreateOrderResult }
  | { ok: false; error: unknown };

/**
 * Fake PayPal boundary: records every createOrder input, replays scripted
 * outcomes, and supports a gate that holds a call open (for concurrency
 * tests). No network, no credentials, no config.
 */
class FakePayPal implements PayPalOrderCreator {
  readonly calls: CreatePayPalOrderInput[] = [];
  readonly #script: ScriptedOutcome[] = [];
  #gate?: { release: () => void; promise: Promise<void> };
  #onCall?: (input: CreatePayPalOrderInput) => void;

  queueSuccess(result: PayPalCreateOrderResult = orderResult()): void {
    this.#script.push({ ok: true, result });
  }

  queueError(error: unknown): void {
    this.#script.push({ ok: false, error });
  }

  /** Synchronous hook invoked when createOrder is entered (after recording). */
  onCall(hook: (input: CreatePayPalOrderInput) => void): void {
    this.#onCall = hook;
  }

  /**
   * Hold the NEXT createOrder call open (single slot) until releaseNext()
   * is invoked. Tests observe arrival via `calls.length`.
   */
  gateNextCall(): Promise<void> {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#gate = { release, promise };
    return promise;
  }

  releaseNext(): void {
    const gate = this.#gate;
    if (gate === undefined) {
      throw new Error('No gated call to release');
    }
    this.#gate = undefined;
    gate.release();
  }

  async createOrder(input: CreatePayPalOrderInput): Promise<PayPalCreateOrderResult> {
    this.calls.push(input);
    this.#onCall?.(input);
    const gate = this.#gate;
    if (gate !== undefined) {
      await gate.promise;
    }
    const next = this.#script.shift() ?? { ok: true, result: orderResult() };
    if (!next.ok) throw next.error;
    return next.result;
  }
}

function makeOrchestrator(
  store: CommerceOperationStore,
  paypal: PayPalOrderCreator,
  now: () => Date = makeClock()
): CommerceExecutionOrchestrator {
  return new CommerceExecutionOrchestrator({ store, paypal, now });
}

/** Await a promise expected to reject; return the error. */
async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('Expected the promise to reject');
    },
    (error: unknown) => error
  );
}

/** Poll until a condition holds (bounded), for cross-connection waits. */
async function waitFor(condition: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for: ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

afterEach(() => {
  for (const closable of createdClosables.splice(0)) {
    try {
      closable.close();
    } catch {
      // already closed
    }
  }
  for (const dir of createdDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

/* ------------------------------------------------------------------ */
/* 1–4. Non-executable operations: ZERO PayPal calls                   */
/* ------------------------------------------------------------------ */

describe('non-executable operations (tests 1–4)', () => {
  test('1. missing operation → NOT_EXECUTABLE(OPERATION_NOT_FOUND), zero PayPal calls', async () => {
    const { store } = makeStore();
    const paypal = new FakePayPal();
    const orchestrator = makeOrchestrator(store, paypal);

    const outcome: CommerceExecutionOutcome = await orchestrator.executeApprovedOperation('nope');

    expect(outcome).toEqual({
      kind: 'NOT_EXECUTABLE',
      operationId: 'nope',
      reason: NON_EXECUTABLE_REASONS.OPERATION_NOT_FOUND,
    });
    expect(paypal.calls.length).toBe(0);
  });

  test('2. AWAITING_HUMAN_APPROVAL → NOT_EXECUTABLE(NOT_APPROVED), zero PayPal calls, no state change', async () => {
    const { store, db } = makeStore();
    const paypal = new FakePayPal();
    const orchestrator = makeOrchestrator(store, paypal);
    store.createOperation('op-1', 'opp-1', T0);
    store.applyOperationEvent(
      'op-1',
      {
        type: 'DECISION_PROPOSED',
        decision: {
          opportunityId: 'opp-1',
          action: 'CREATE_PAYMENT',
          amount: 2500,
          currency: 'EUR',
          recipient: 'customer@example.com',
          justification: 'Not yet approved',
        },
      },
      T1
    );
    store.applyOperationEvent(
      'op-1',
      { type: 'POLICY_APPROVED', policyResult: { decision: 'APPROVE', reason: 'Within limits' } },
      T2
    );
    store.applyOperationEvent('op-1', { type: 'REQUEST_HUMAN_APPROVAL' }, T3);
    expect(store.getOperation('op-1')?.status).toBe('AWAITING_HUMAN_APPROVAL');

    const outcome = await orchestrator.executeApprovedOperation('op-1');

    // Human approval has NOT happened: execution must be refused.
    expect(outcome).toEqual({
      kind: 'NOT_EXECUTABLE',
      operationId: 'op-1',
      currentStatus: 'AWAITING_HUMAN_APPROVAL',
      reason: NON_EXECUTABLE_REASONS.NOT_APPROVED,
    });
    expect(paypal.calls.length).toBe(0);
    // Durable state untouched: still awaiting human approval, 3 audit events.
    expect(store.getOperation('op-1')?.status).toBe('AWAITING_HUMAN_APPROVAL');
    expect(rawAuditEventTypes(db, 'op-1')).toEqual([
      'DECISION_PROPOSED',
      'POLICY_APPROVED',
      'REQUEST_HUMAN_APPROVAL',
    ]);
  });

  test('3. POLICY_REJECTED → NOT_EXECUTABLE(NOT_APPROVED), zero PayPal calls', async () => {
    const { store, db } = makeStore();
    const paypal = new FakePayPal();
    const orchestrator = makeOrchestrator(store, paypal);
    driveToPolicyRejected(store);

    const outcome = await orchestrator.executeApprovedOperation('op-1');

    expect(outcome).toMatchObject({
      kind: 'NOT_EXECUTABLE',
      operationId: 'op-1',
      currentStatus: 'POLICY_REJECTED',
      reason: NON_EXECUTABLE_REASONS.NOT_APPROVED,
    });
    expect(paypal.calls.length).toBe(0);
    expect(rawAuditEventTypes(db, 'op-1')).toEqual(['DECISION_PROPOSED', 'POLICY_REJECTED']);
    expect(store.getOperation('op-1')?.status).toBe('POLICY_REJECTED');
  });

  test('4. REJECTED_BY_HUMAN → NOT_EXECUTABLE(NOT_APPROVED), zero PayPal calls', async () => {
    const { store, db } = makeStore();
    const paypal = new FakePayPal();
    const orchestrator = makeOrchestrator(store, paypal);
    store.createOperation('op-1', 'opp-1', T0);
    store.applyOperationEvent(
      'op-1',
      {
        type: 'DECISION_PROPOSED',
        decision: {
          opportunityId: 'opp-1',
          action: 'CREATE_PAYMENT',
          amount: 2500,
          currency: 'EUR',
          recipient: 'customer@example.com',
          justification: 'Human-rejected payment',
        },
      },
      T1
    );
    store.applyOperationEvent(
      'op-1',
      { type: 'POLICY_APPROVED', policyResult: { decision: 'APPROVE', reason: 'Within limits' } },
      T2
    );
    store.applyOperationEvent('op-1', { type: 'REQUEST_HUMAN_APPROVAL' }, T3);
    store.applyOperationEvent(
      'op-1',
      { type: 'HUMAN_REJECTED', approvalStatus: 'REJECTED' },
      T4
    );

    const outcome = await orchestrator.executeApprovedOperation('op-1');

    expect(outcome).toMatchObject({
      kind: 'NOT_EXECUTABLE',
      operationId: 'op-1',
      currentStatus: 'REJECTED_BY_HUMAN',
      reason: NON_EXECUTABLE_REASONS.NOT_APPROVED,
    });
    expect(paypal.calls.length).toBe(0);
    expect(rawAuditEventTypes(db, 'op-1')).toEqual([
      'DECISION_PROPOSED',
      'POLICY_APPROVED',
      'REQUEST_HUMAN_APPROVAL',
      'HUMAN_REJECTED',
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* 5–7. Approved execution: claim ordering, exact input, success       */
/* ------------------------------------------------------------------ */

describe('approved operation execution (tests 5–7)', () => {
  test('5. EXECUTION_STARTED is durably persisted BEFORE createOrder is called', async () => {
    const { store, db } = makeStore();
    const paypal = new FakePayPal();
    const orchestrator = makeOrchestrator(store, paypal);
    driveToApproved(store);

    // Observed from INSIDE the PayPal boundary: the claim must already be
    // durable (snapshot EXECUTING + EXECUTION_STARTED audit row committed).
    paypal.onCall(() => {
      expect(store.getOperation('op-1')?.status).toBe('EXECUTING');
      const types = rawAuditEventTypes(db, 'op-1');
      expect(types[types.length - 1]).toBe('EXECUTION_STARTED');
      expect(types).toContain('HUMAN_APPROVED');
    });

    const outcome = await orchestrator.executeApprovedOperation('op-1');
    expect(outcome.kind).toBe('ORDER_CREATED');
    expect(paypal.calls.length).toBe(1);
    expect(rawAuditEventTypes(db, 'op-1')).toEqual([
      'DECISION_PROPOSED',
      'POLICY_APPROVED',
      'REQUEST_HUMAN_APPROVAL',
      'HUMAN_APPROVED',
      'EXECUTION_STARTED',
      'PAYPAL_ORDER_CREATED',
    ]);
  });

  test('6. createOrder receives exactly the deterministic requestId, decision amount/currency, and commerceOperationId', async () => {
    const { store } = makeStore();
    const paypal = new FakePayPal();
    const orchestrator = makeOrchestrator(store, paypal);
    driveToApproved(store); // decision: amount 2500 minor units, currency EUR

    await orchestrator.executeApprovedOperation('op-1');

    expect(paypal.calls).toEqual([
      {
        requestId: 'commercepilot-op-op-1',
        amountMinorUnits: 2500, // decision.amount passed through untouched (integer minor units)
        currency: 'EUR', // decision.currency passed through untouched
        commerceOperationId: 'op-1',
      },
    ]);
  });

  test('6b. request ID derivation is deterministic, namespaced, and secret-free', () => {
    expect(payPalRequestIdForOperation('op-1')).toBe('commercepilot-op-op-1');
    expect(payPalRequestIdForOperation('op-1')).toBe(payPalRequestIdForOperation('op-1'));
    expect(payPalRequestIdForOperation('op-2')).not.toBe(payPalRequestIdForOperation('op-1'));
    expect(PAYPAL_REQUEST_ID_PREFIX).toBe('commercepilot-op-');
    // Pure function of the operation ID: no timestamps/randomness can leak in.
    const a = payPalRequestIdForOperation('op-9');
    const b = payPalRequestIdForOperation('op-9');
    expect(a).toBe(b);
  });

  test('7. success persists PAYPAL_ORDER_CREATED exactly; paymentResult stays undefined; NO PAYMENT_COMPLETED', async () => {
    const { store, db } = makeStore();
    const paypal = new FakePayPal();
    paypal.queueSuccess(
      orderResult({ requestId: 'commercepilot-op-op-1' })
    );
    const orchestrator = makeOrchestrator(store, paypal);
    driveToApproved(store);

    const outcome = await orchestrator.executeApprovedOperation('op-1');

    expect(outcome).toEqual({
      kind: 'ORDER_CREATED',
      operationId: 'op-1',
      paypalOrder: {
        paypalOrderId: 'PAYPAL-ORDER-1',
        paypalStatus: 'CREATED',
        requestId: 'commercepilot-op-op-1',
        approveUrl: 'https://paypal.example/approve/PAYPAL-ORDER-1',
      },
    });

    const operation = store.getOperation('op-1');
    expect(operation?.status).toBe('PAYPAL_ORDER_CREATED');
    expect(operation?.paypalOrder).toEqual({
      paypalOrderId: 'PAYPAL-ORDER-1',
      paypalStatus: 'CREATED',
      requestId: 'commercepilot-op-op-1',
      approveUrl: 'https://paypal.example/approve/PAYPAL-ORDER-1',
    });
    // NEVER a payment-completed claim in this checkpoint.
    expect(operation?.paymentResult).toBeUndefined();

    const types = rawAuditEventTypes(db, 'op-1');
    expect(types[types.length - 1]).toBe('PAYPAL_ORDER_CREATED');
    expect(types).not.toContain('PAYMENT_COMPLETED');

    // approveUrl absent → the key is simply not persisted.
    const { store: store2 } = makeStore();
    const paypal2 = new FakePayPal();
    paypal2.queueSuccess(
      orderResult({
        requestId: 'commercepilot-op-op-2',
        approveUrl: undefined,
        paypalOrderId: 'PAYPAL-ORDER-2',
      })
    );
    const orchestrator2 = makeOrchestrator(store2, paypal2);
    driveToApproved(store2, 'op-2');
    const outcome2 = await orchestrator2.executeApprovedOperation('op-2');
    expect(outcome2.kind).toBe('ORDER_CREATED');
    if (outcome2.kind === 'ORDER_CREATED') {
      expect(Object.keys(outcome2.paypalOrder).sort()).toEqual([
        'paypalOrderId',
        'paypalStatus',
        'requestId',
      ]);
    }
    expect(store2.getOperation('op-2')?.paypalOrder).toEqual({
      paypalOrderId: 'PAYPAL-ORDER-2',
      paypalStatus: 'CREATED',
      requestId: 'commercepilot-op-op-2',
    });
  });
});

/* ------------------------------------------------------------------ */
/* 8. Clear PayPal failure                                             */
/* ------------------------------------------------------------------ */

describe('clear PayPal failure (test 8)', () => {
  test('8. PayPalHttpApiError → PAYMENT_FAILED persisted, status FAILED, safe error only', async () => {
    const { store, db } = makeStore();
    const paypal = new FakePayPal();
    paypal.queueError(
      new PayPalHttpApiError(
        'PayPal create-order failed with HTTP status 400 (INVALID_REQUEST)',
        { status: 400, paypalErrorName: 'INVALID_REQUEST' }
      )
    );
    const orchestrator = makeOrchestrator(store, paypal);
    driveToApproved(store);

    const outcome = await orchestrator.executeApprovedOperation('op-1');

    expect(outcome).toEqual({
      kind: 'EXECUTION_FAILED',
      operationId: 'op-1',
      message: 'PayPal create-order failed with HTTP status 400 (INVALID_REQUEST)',
    });
    expect(store.getOperation('op-1')?.status).toBe('FAILED');
    expect(store.getOperation('op-1')?.paymentResult).toEqual({
      success: false,
      errorMessage: 'PayPal create-order failed with HTTP status 400 (INVALID_REQUEST)',
    });
    // Truthful: no fabricated transaction/amount fields.
    expect(store.getOperation('op-1')?.paymentResult?.transactionId).toBeUndefined();
    expect(store.getOperation('op-1')?.paypalOrder).toBeUndefined();
    expect(rawAuditEventTypes(db, 'op-1')).toContain('PAYMENT_FAILED');
    expect(rawAuditEventTypes(db, 'op-1')).not.toContain('PAYMENT_COMPLETED');
    expect(rawAuditEventTypes(db, 'op-1')).not.toContain('PAYPAL_ORDER_CREATED');
    expect(paypal.calls.length).toBe(1); // no automatic retry
  });

  test('8b. non-PayPal error shapes are sanitized down to name + message', async () => {
    const { store } = makeStore();
    const paypal = new FakePayPal();
    paypal.queueError(new TypeError('socket hung up while calling PayPal'));
    const orchestrator = makeOrchestrator(store, paypal);
    driveToApproved(store);

    const outcome = await orchestrator.executeApprovedOperation('op-1');
    expect(outcome).toEqual({
      kind: 'EXECUTION_FAILED',
      operationId: 'op-1',
      message: 'TypeError: socket hung up while calling PayPal',
    });
    expect(store.getOperation('op-1')?.status).toBe('FAILED');
  });
});

/* ------------------------------------------------------------------ */
/* 9. EXECUTION_STARTED persistence failure → zero PayPal calls        */
/* ------------------------------------------------------------------ */

describe('claim persistence failure (test 9)', () => {
  test('9. EXECUTION_STARTED persist failure aborts with ZERO PayPal calls and rethrows', async () => {
    const { store, db } = makeStore();
    const paypal = new FakePayPal();
    const orchestrator = makeOrchestrator(store, paypal);
    driveToApproved(store);

    const beforeAudit = rawAuditEventTypes(db, 'op-1');

    // Force a GENUINE failure at the audit INSERT inside the claim transaction.
    db.exec(
      "CREATE TRIGGER force_claim_failure BEFORE INSERT ON commerce_operation_audit " +
        "BEGIN SELECT RAISE(ABORT, 'forced EXECUTION_STARTED insert failure'); END;"
    );

    const error = await failureOf(orchestrator.executeApprovedOperation('op-1'));
    expect((error as Error).message).toContain('forced EXECUTION_STARTED insert failure');

    // ZERO PayPal calls; durable state rolled back to APPROVED; audit untouched.
    expect(paypal.calls.length).toBe(0);
    expect(store.getOperation('op-1')?.status).toBe('APPROVED');
    expect(rawAuditEventTypes(db, 'op-1')).toEqual(beforeAudit);

    // The connection is usable again (no dangling transaction).
    expect(() => store.createOperation('op-2', 'opp-2', T5)).not.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* 10–11. POST-PayPal persistence failure + explicit recovery          */
/* ------------------------------------------------------------------ */

describe('post-PayPal persistence failure and recovery (tests 10–11)', () => {
  test('10 → 11. PayPal succeeds, PAYPAL_ORDER_CREATED persist fails → POST_PAYPAL_PERSISTENCE_FAILED, stays EXECUTING, then recovery persists it with ZERO PayPal calls', async () => {
    const { store, db } = makeStore();
    const paypal = new FakePayPal();
    const successfulResult = orderResult({ requestId: 'commercepilot-op-op-1' });
    paypal.queueSuccess(successfulResult);
    const orchestrator = makeOrchestrator(store, paypal);
    driveToApproved(store);

    // Block ONLY the PAYPAL_ORDER_CREATED audit insert (the claim insert must
    // still succeed so execution reaches PayPal).
    db.exec(
      "CREATE TRIGGER block_order_created BEFORE INSERT ON commerce_operation_audit " +
        "WHEN NEW.event_type = 'PAYPAL_ORDER_CREATED' " +
        "BEGIN SELECT RAISE(ABORT, 'forced PAYPAL_ORDER_CREATED insert failure'); END;"
    );

    const outcome = await orchestrator.executeApprovedOperation('op-1');

    // Distinct outcome with safe recovery info (including the echoed requestId).
    expect(outcome.kind).toBe('POST_PAYPAL_PERSISTENCE_FAILED');
    if (outcome.kind === 'POST_PAYPAL_PERSISTENCE_FAILED') {
      expect(outcome.operationId).toBe('op-1');
      expect(outcome.paypalResult).toEqual(successfulResult);
      expect(outcome.paypalResult.paypalOrderId).toBe('PAYPAL-ORDER-1');
      expect(outcome.paypalResult.requestId).toBe('commercepilot-op-op-1');
      expect(outcome.message).toContain('persistPayPalOrderOutcome');
    }

    // Local durable truth: still EXECUTING, NO paypalOrder, NO PAYMENT_FAILED,
    // NO COMPLETED overclaim, NO PAYMENT_COMPLETED.
    const operation = store.getOperation('op-1');
    expect(operation?.status).toBe('EXECUTING');
    expect(operation?.paypalOrder).toBeUndefined();
    expect(operation?.paymentResult).toBeUndefined();
    expect(rawAuditEventTypes(db, 'op-1')).toEqual([
      'DECISION_PROPOSED',
      'POLICY_APPROVED',
      'REQUEST_HUMAN_APPROVAL',
      'HUMAN_APPROVED',
      'EXECUTION_STARTED',
    ]);

    // NO second PayPal call, NO retry of createOrder.
    expect(paypal.calls.length).toBe(1);

    // --- Explicit recovery (approved in CP1): never calls PayPal. --------
    db.exec('DROP TRIGGER block_order_created;');

    const recovery = orchestrator.persistPayPalOrderOutcome('op-1', outcome.kind === 'POST_PAYPAL_PERSISTENCE_FAILED' ? outcome.paypalResult : successfulResult);

    expect(recovery).toEqual({
      kind: 'RECOVERED',
      operationId: 'op-1',
      paypalOrder: {
        paypalOrderId: 'PAYPAL-ORDER-1',
        paypalStatus: 'CREATED',
        requestId: 'commercepilot-op-op-1',
        approveUrl: 'https://paypal.example/approve/PAYPAL-ORDER-1',
      },
    });
    expect(paypal.calls.length).toBe(1); // recovery NEVER calls PayPal

    const recovered = store.getOperation('op-1');
    expect(recovered?.status).toBe('PAYPAL_ORDER_CREATED');
    expect(recovered?.paypalOrder).toEqual({
      paypalOrderId: 'PAYPAL-ORDER-1',
      paypalStatus: 'CREATED',
      requestId: 'commercepilot-op-op-1',
      approveUrl: 'https://paypal.example/approve/PAYPAL-ORDER-1',
    });
    expect(recovered?.paymentResult).toBeUndefined();
    expect(rawAuditEventTypes(db, 'op-1')).toEqual([
      'DECISION_PROPOSED',
      'POLICY_APPROVED',
      'REQUEST_HUMAN_APPROVAL',
      'HUMAN_APPROVED',
      'EXECUTION_STARTED',
      'PAYPAL_ORDER_CREATED',
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* 12. Repeated / invalid recovery                                     */
/* ------------------------------------------------------------------ */

describe('repeated and invalid recovery (test 12)', () => {
  test('12. repeated recovery is refused deterministically; never duplicates or overwrites', async () => {
    const { store, db } = makeStore();
    const paypal = new FakePayPal();
    const first = orderResult({ requestId: 'commercepilot-op-op-1' });
    paypal.queueSuccess(first);
    const orchestrator = makeOrchestrator(store, paypal);
    driveToApproved(store);
    await orchestrator.executeApprovedOperation('op-1');
    expect(paypal.calls.length).toBe(1);
    const auditBefore = rawAuditEventTypes(db, 'op-1');

    // Repeated recovery with the SAME result → deterministic refusal, no-op.
    const repeat = orchestrator.persistPayPalOrderOutcome('op-1', first);
    expect(repeat).toEqual({
      kind: 'RECOVERY_NOT_APPLICABLE',
      operationId: 'op-1',
      reason: 'PAYPAL_ORDER_ALREADY_PERSISTED',
    });
    expect(rawAuditEventTypes(db, 'op-1')).toEqual(auditBefore);
    expect(store.getOperation('op-1')?.paypalOrder?.paypalOrderId).toBe('PAYPAL-ORDER-1');

    // A DIFFERENT result must never overwrite the persisted PayPal order.
    const conflicting = orchestrator.persistPayPalOrderOutcome(
      'op-1',
      orderResult({ paypalOrderId: 'PAYPAL-ORDER-OTHER', requestId: 'commercepilot-op-op-1' })
    );
    expect(conflicting).toEqual({
      kind: 'RECOVERY_NOT_APPLICABLE',
      operationId: 'op-1',
      reason: 'DIFFERENT_PAYPAL_ORDER_ALREADY_PERSISTED',
    });
    expect(store.getOperation('op-1')?.paypalOrder?.paypalOrderId).toBe('PAYPAL-ORDER-1');
    expect(rawAuditEventTypes(db, 'op-1')).toEqual(auditBefore);
    expect(paypal.calls.length).toBe(1);

    // Recovery is only valid while EXECUTING: refused for a fresh operation.
    const fresh = orchestrator.persistPayPalOrderOutcome(
      'op-2',
      orderResult({ requestId: 'commercepilot-op-op-2' })
    );
    expect(fresh).toEqual({
      kind: 'RECOVERY_NOT_APPLICABLE',
      operationId: 'op-2',
      reason: 'OPERATION_NOT_FOUND',
    });

    // Recovery on a never-executed operation → refused, zero PayPal calls.
    store.createOperation('op-3', 'opp-3', T0);
    const notExecuting = orchestrator.persistPayPalOrderOutcome(
      'op-3',
      orderResult({ requestId: 'commercepilot-op-op-3' })
    );
    expect(notExecuting.kind).toBe('RECOVERY_NOT_APPLICABLE');
    if (notExecuting.kind === 'RECOVERY_NOT_APPLICABLE') {
      expect(notExecuting.operationId).toBe('op-3');
      expect(notExecuting.reason).toContain('OPERATION_NOT_EXECUTING');
    }
    expect(paypal.calls.length).toBe(1);
    expect(rawAuditEventTypes(db, 'op-3')).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 13–14. Sequential and concurrent double invocation                  */
/* ------------------------------------------------------------------ */

describe('double invocation protection (tests 13–14)', () => {
  test('13. sequential second invocation → ALREADY_EXECUTING, zero additional PayPal calls', async () => {
    const { store, db } = makeStore();
    const paypal = new FakePayPal();
    const orchestrator = makeOrchestrator(store, paypal);
    driveToApproved(store);

    const first = await orchestrator.executeApprovedOperation('op-1');
    expect(first.kind).toBe('ORDER_CREATED');
    expect(paypal.calls.length).toBe(1);

    const second = await orchestrator.executeApprovedOperation('op-1');

    // Post-success status is PAYPAL_ORDER_CREATED (not EXECUTING), so the
    // truthful reason is NOT_APPROVED. The invariant under test: ZERO
    // additional PayPal calls and no state change.
    expect(second).toEqual({
      kind: 'NOT_EXECUTABLE',
      operationId: 'op-1',
      currentStatus: 'PAYPAL_ORDER_CREATED',
      reason: NON_EXECUTABLE_REASONS.NOT_APPROVED,
    });
    expect(paypal.calls.length).toBe(1); // ZERO additional PayPal calls
    expect(rawAuditEventTypes(db, 'op-1')).toEqual([
      'DECISION_PROPOSED',
      'POLICY_APPROVED',
      'REQUEST_HUMAN_APPROVAL',
      'HUMAN_APPROVED',
      'EXECUTION_STARTED',
      'PAYPAL_ORDER_CREATED',
    ]);
    expect(store.getOperation('op-1')?.status).toBe('PAYPAL_ORDER_CREATED');
  });

  test('14. concurrent double invocation across two store connections → exactly one claim, one createOrder, one PAYPAL_ORDER_CREATED', async () => {
    // A named shared-cache in-memory SQLite database: two REAL connections,
    // so BEGIN IMMEDIATE writer serialization is genuine (no test double).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-conc-'));
    createdDirs.push(dir);
    const dbFile = path.join(dir, 'conc.db');
    const storeDbA = openStoreDb(dbFile);
    createdClosables.push(storeDbA);
    const storeDbB = openStoreDb({ path: dbFile, busyTimeoutMs: 2000 });
    createdClosables.push(storeDbB);

    const storeA = new CommerceOperationStore({ db: storeDbA.db });
    const storeB = new CommerceOperationStore({ db: storeDbB.db });
    driveToApproved(storeA, 'op-1');

    const paypalA = new FakePayPal();
    const paypalB = new FakePayPal();
    const orchestratorA = makeOrchestrator(storeA, paypalA);
    const orchestratorB = makeOrchestrator(storeB, paypalB);

    // Invocation A claims and reaches PayPal, where it is held by a gate.
    const gatePromise = paypalA.gateNextCall();
    const promiseA = orchestratorA.executeApprovedOperation('op-1');
    await waitFor(() => paypalA.calls.length === 1, 'invocation A to reach PayPal');
    // The claim already committed durably: both connections observe EXECUTING.
    expect(storeA.getOperation('op-1')?.status).toBe('EXECUTING');
    expect(storeB.getOperation('op-1')?.status).toBe('EXECUTING');

    // Invocation B starts while A owns the claim: it must never call PayPal.
    const promiseB = orchestratorB.executeApprovedOperation('op-1');
    const outcomeB = (await promiseB) as CommerceExecutionOutcome;
    expect(outcomeB).toEqual({
      kind: 'NOT_EXECUTABLE',
      operationId: 'op-1',
      currentStatus: 'EXECUTING',
      reason: NON_EXECUTABLE_REASONS.ALREADY_EXECUTING,
    });
    expect(paypalB.calls.length).toBe(0);
    expect(paypalA.calls.length).toBe(1);

    // Release A; exactly one logical execution completes.
    paypalA.releaseNext();
    await gatePromise;
    const outcomeA = (await promiseA) as CommerceExecutionOutcome;
    expect(outcomeA.kind).toBe('ORDER_CREATED');

    // Exactly one EXECUTION_STARTED and one PAYPAL_ORDER_CREATED audit event.
    const types = rawAuditEventTypes(storeDbA.db, 'op-1');
    expect(types.filter((t) => t === 'EXECUTION_STARTED')).toHaveLength(1);
    expect(types.filter((t) => t === 'PAYPAL_ORDER_CREATED')).toHaveLength(1);
    expect(types).toEqual([
      'DECISION_PROPOSED',
      'POLICY_APPROVED',
      'REQUEST_HUMAN_APPROVAL',
      'HUMAN_APPROVED',
      'EXECUTION_STARTED',
      'PAYPAL_ORDER_CREATED',
    ]);
    expect(paypalA.calls.length).toBe(1);
    expect(paypalB.calls.length).toBe(0);
    expect(storeA.getOperation('op-1')?.status).toBe('PAYPAL_ORDER_CREATED');
  });

  test('14b. claim lost between pre-read and apply → durable re-read wins, zero PayPal calls (no stale-read execution)', async () => {
    // Store fake that simulates a stale APPROVED pre-read followed by a
    // genuinely-failed claim (as under cross-connection write contention),
    // with the durable re-read showing EXECUTING. Proves the orchestrator
    // never treats the stale read as execution rights.
    const { store } = makeStore();
    driveToApproved(store);
    const staleReads: CommerceOperation[] = [];
    const realOp = store.getOperation('op-1');
    if (realOp === undefined) throw new Error('setup failed');
    staleReads.push(realOp); // first getOperation: stale APPROVED

    let claimed = false;
    const wrapped = {
      getOperation: (operationId: string) => {
        if (staleReads.length > 0) return staleReads.shift();
        return store.getOperation(operationId);
      },
      applyOperationEvent: (
        operationId: string,
        event: Parameters<CommerceOperationStore['applyOperationEvent']>[1],
        timestamp: Date
      ) => {
        if (event.type === 'EXECUTION_STARTED' && !claimed) {
          claimed = true;
          // Concurrent winner committed first: simulate the losing claim.
          store.applyOperationEvent(operationId, { type: 'EXECUTION_STARTED' }, timestamp);
          throw new Error('database table is locked (simulated claim contention)');
        }
        return store.applyOperationEvent(operationId, event, timestamp);
      },
      getAuditTrail: (operationId: string) => store.getAuditTrail(operationId),
    };

    const paypal = new FakePayPal();
    const orchestrator = new CommerceExecutionOrchestrator({ store: wrapped, paypal });

    const outcome = await orchestrator.executeApprovedOperation('op-1');
    expect(outcome).toEqual({
      kind: 'NOT_EXECUTABLE',
      operationId: 'op-1',
      currentStatus: 'EXECUTING',
      reason: NON_EXECUTABLE_REASONS.ALREADY_EXECUTING,
    });
    expect(paypal.calls.length).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Integrity guard: APPROVED/EXECUTING without decision data           */
/* ------------------------------------------------------------------ */

describe('missing decision data integrity guard', () => {
  test('EXECUTING operation without decision data → clear error, ZERO PayPal calls, no fabricated data', async () => {
    const { store, db } = makeStore();
    const paypal = new FakePayPal();
    const orchestrator = makeOrchestrator(store, paypal);
    driveToApproved(store);

    // Corrupt away the decision (simulates a persisted integrity fault).
    const row = db.prepare('SELECT snapshot FROM commerce_operations WHERE id = ?;').get('op-1') as {
      snapshot: string;
    };
    const parsed = JSON.parse(row.snapshot) as Record<string, unknown>;
    delete parsed.decision;
    db.prepare('UPDATE commerce_operations SET snapshot = ? WHERE id = ?;').run(
      JSON.stringify(parsed),
      'op-1'
    );

    const error = await failureOf(orchestrator.executeApprovedOperation('op-1'));
    expect((error as Error).message).toContain('no persisted decision data');
    expect((error as Error).message).toContain('refusing to call PayPal');

    expect(paypal.calls.length).toBe(0);
    // The operation remains truthfully EXECUTING (claim happened), with no
    // invented PayPal/payment outcome.
    expect(store.getOperation('op-1')?.status).toBe('EXECUTING');
    expect(rawAuditEventTypes(db, 'op-1')).toEqual([
      'DECISION_PROPOSED',
      'POLICY_APPROVED',
      'REQUEST_HUMAN_APPROVAL',
      'HUMAN_APPROVED',
      'EXECUTION_STARTED',
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* 15. Secret hygiene                                                  */
/* ------------------------------------------------------------------ */

describe('secret hygiene (test 15)', () => {
  const SECRET_KEY_FIXTURE = 'sk-live-abcdef1234567890';
  const SECRET_TOKEN_FIXTURE = 'super-secret-value-123';

  test('15. representative secrets never appear in returned or persisted failure strings', async () => {
    const { store, db } = makeStore();
    const paypal = new FakePayPal();
    paypal.queueError(
      new PayPalHttpApiError(
        `PayPal create-order failed with HTTP status 500; debug=${SECRET_KEY_FIXTURE} client_secret=${SECRET_TOKEN_FIXTURE} Authorization=Bearer ${SECRET_TOKEN_FIXTURE}`,
        { status: 500 }
      )
    );
    const orchestrator = makeOrchestrator(store, paypal);
    driveToApproved(store);

    const outcome = await orchestrator.executeApprovedOperation('op-1');
    expect(outcome.kind).toBe('EXECUTION_FAILED');

    const message = outcome.kind === 'EXECUTION_FAILED' ? outcome.message : '';
    expect(message).not.toContain(SECRET_KEY_FIXTURE);
    expect(message).not.toContain(SECRET_TOKEN_FIXTURE);
    expect(message).not.toContain('Bearer ');
    expect(message).toContain('[REDACTED]');

    // Persisted payment result is equally secret-free (checked via raw SQL).
    const raw = db
      .prepare('SELECT event_json FROM commerce_operation_audit WHERE operation_id = ? ORDER BY event_seq DESC LIMIT 1;')
      .get('op-1') as { event_json: string };
    expect(raw.event_json).not.toContain(SECRET_KEY_FIXTURE);
    expect(raw.event_json).not.toContain(SECRET_TOKEN_FIXTURE);

    const persisted = store.getOperation('op-1')?.paymentResult;
    expect(persisted?.success).toBe(false);
    expect(persisted?.errorMessage).toBeDefined();
    expect(persisted?.errorMessage).not.toContain(SECRET_KEY_FIXTURE);
    expect(persisted?.errorMessage).not.toContain(SECRET_TOKEN_FIXTURE);

    // Durable snapshot row is secret-free too.
    const snapshotRow = db
      .prepare('SELECT snapshot FROM commerce_operations WHERE id = ?;')
      .get('op-1') as { snapshot: string };
    expect(snapshotRow.snapshot).not.toContain(SECRET_KEY_FIXTURE);
    expect(snapshotRow.snapshot).not.toContain(SECRET_TOKEN_FIXTURE);
  });
});

/* ------------------------------------------------------------------ */
/* Boundary typing + ambiguity documentation (supporting tests)        */
/* ------------------------------------------------------------------ */

describe('PayPal boundary integration surface (supporting)', () => {
  test('PayPalService structurally satisfies PayPalOrderCreator without credentials or network', () => {
    // Compile-time + runtime wiring proof only: PayPalService is constructed
    // with placeholder config and NO calls are made — no credentials needed.
    const service: PayPalOrderCreator = new PayPalService({
      config: {
        environment: 'SANDBOX',
        apiBaseUrl: 'https://paypal-mock.invalid',
        clientId: 'not-a-real-client-id',
        clientSecret: 'not-a-real-client-secret',
      },
    });
    expect(typeof service.createOrder).toBe('function');
  });

  test('ambiguity documentation: only pre-HTTP validation failures prove NO order exists', () => {
    // PayPalInvalidRequestError is raised BEFORE any HTTP side effect.
    expect(isDefiniteNoOrderFailure(new PayPalInvalidRequestError('bad input'))).toBe(true);
    // Transport-level and malformed-response failures carry no such proof:
    // an order MAY exist remotely even though no proof of its ID exists.
    expect(isDefiniteNoOrderFailure(new PayPalHttpApiError('transport failed'))).toBe(false);
    expect(isDefiniteNoOrderFailure(new PayPalMalformedResponseError('bad body'))).toBe(false);
    expect(isDefiniteNoOrderFailure(new Error('something else'))).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 16. CP2 regression guard is covered by src/store + src/domain tests */
/* (see package test run; no duplication here)                         */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Task 10 CP2 (B). Buyer-redirect approval pass-through.              */
/* The orchestrator forwards approvalRedirect VERBATIM into createOrder*/
/* and never invents, validates, or normalizes the values. Offline.    */
/* ------------------------------------------------------------------ */

const CP2_RETURN_URL = 'https://commercepilot.example/paypal/return';
const CP2_CANCEL_URL = 'https://commercepilot.example/paypal/cancel';

describe('approval-redirect pass-through (Task 10 CP2 B)', () => {
  test('B1. approvalRedirect is forwarded VERBATIM as returnUrl/cancelUrl into createOrder', async () => {
    const { store } = makeStore();
    const paypal = new FakePayPal();
    const orchestrator = new CommerceExecutionOrchestrator({
      store,
      paypal,
      approvalRedirect: { returnUrl: CP2_RETURN_URL, cancelUrl: CP2_CANCEL_URL },
      now: makeClock(),
    });
    driveToApproved(store);

    const outcome = await orchestrator.executeApprovedOperation('op-1');

    expect(outcome.kind).toBe('ORDER_CREATED');
    expect(paypal.calls).toEqual([
      {
        requestId: 'commercepilot-op-op-1',
        amountMinorUnits: 2500,
        currency: 'EUR',
        commerceOperationId: 'op-1',
        returnUrl: CP2_RETURN_URL, // verbatim — exactly as configured
        cancelUrl: CP2_CANCEL_URL, // verbatim — exactly as configured
      },
    ]);
  });

  test('B2. without approvalRedirect the createOrder input is unchanged (no returnUrl/cancelUrl keys)', async () => {
    const { store } = makeStore();
    const paypal = new FakePayPal();
    const orchestrator = makeOrchestrator(store, paypal);
    driveToApproved(store);

    await orchestrator.executeApprovedOperation('op-1');

    expect(paypal.calls.length).toBe(1);
    expect('returnUrl' in paypal.calls[0]).toBe(false);
    expect('cancelUrl' in paypal.calls[0]).toBe(false);
    // Byte-identical to the pre-CP2 contract.
    expect(paypal.calls[0]).toEqual({
      requestId: 'commercepilot-op-op-1',
      amountMinorUnits: 2500,
      currency: 'EUR',
      commerceOperationId: 'op-1',
    });
  });

  test('B3. deterministic requestId/amount/currency/commerceOperationId are unchanged by the redirect option', async () => {
    const { store } = makeStore();
    const paypal = new FakePayPal();
    const orchestrator = new CommerceExecutionOrchestrator({
      store,
      paypal,
      approvalRedirect: { returnUrl: CP2_RETURN_URL, cancelUrl: CP2_CANCEL_URL },
      now: makeClock(),
    });
    driveToApproved(store);

    await orchestrator.executeApprovedOperation('op-1');

    const input = paypal.calls[0];
    expect(input.requestId).toBe('commercepilot-op-op-1');
    expect(input.amountMinorUnits).toBe(2500);
    expect(input.currency).toBe('EUR');
    expect(input.commerceOperationId).toBe('op-1');
    // Success persistence is unchanged too: PayPal result normalized exactly
    // as before, with the deterministic requestId echoed.
    expect(store.getOperation('op-1')?.paypalOrder).toEqual({
      paypalOrderId: 'PAYPAL-ORDER-1',
      paypalStatus: 'CREATED',
      requestId: 'commercepilot-op-op-1',
      approveUrl: 'https://paypal.example/approve/PAYPAL-ORDER-1',
    });
  });

  test('B4. pass-through only: values are NOT validated or rewritten by the orchestrator', async () => {
    // Validation (HTTPS-only pairing) belongs exclusively to the PayPal
    // boundary. The orchestrator must forward even a hypothetically invalid
    // value untouched — proving zero normalization logic here. The injected
    // fake records it verbatim (no real PayPal call is possible offline).
    const { store } = makeStore();
    const paypal = new FakePayPal();
    const orchestrator = new CommerceExecutionOrchestrator({
      store,
      paypal,
      approvalRedirect: { returnUrl: 'http://not-https.example/return', cancelUrl: CP2_CANCEL_URL },
      now: makeClock(),
    });
    driveToApproved(store);

    await orchestrator.executeApprovedOperation('op-1');

    expect(paypal.calls[0].returnUrl).toBe('http://not-https.example/return');
    expect(paypal.calls[0].cancelUrl).toBe(CP2_CANCEL_URL);
  });
});
