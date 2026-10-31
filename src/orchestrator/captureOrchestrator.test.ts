import { afterEach, describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CommerceOperation } from '../domain/schemas';
import type { CommerceOperationEvent } from '../domain/events';
import { CommerceOperationStore, type AppliedOperationEvent } from '../store';
import { openStoreDb, type StoreDb, type SqliteDb } from '../store/db';
import {
  PayPalAuthenticationError,
  PayPalConfigurationError,
  PayPalHttpApiError,
  PayPalInvalidRequestError,
  PayPalMalformedResponseError,
  PayPalService,
  type CapturePayPalOrderInput,
  type PayPalCaptureOrderResult,
  type PayPalGetOrderResult,
} from '../services/paypal';
import {
  CaptureOrchestrator,
  NOT_CAPTURABLE_REASONS,
  NOT_RECONCILABLE_REASONS,
  PAYPAL_CAPTURE_REQUEST_ID_PREFIX,
  RECOVERY_NOT_APPLICABLE_REASONS,
  payPalCaptureRequestIdForOperation,
  type CaptureOutcome,
  type PayPalCaptureExecutor,
  type ReconcileOutcome,
} from './captureOrchestrator';

/* ------------------------------------------------------------------ */
/* Durable store helpers (mirrors src/store/index.test.ts patterns)    */
/* ------------------------------------------------------------------ */

const createdClosables: Array<{ close(): void }> = [];
const tempDirs: string[] = [];

function makeStore(): { store: CommerceOperationStore; db: SqliteDb } {
  const storeDb = openStoreDb(':memory:');
  createdClosables.push(storeDb);
  return { store: new CommerceOperationStore({ db: storeDb.db }), db: storeDb.db };
}

/**
 * TWO independent store connections over ONE file-backed SQLite database —
 * the closest offline simulation of two concurrent worker processes.
 */
function makeFileBackedStorePair(): { a: CommerceOperationStore; b: CommerceOperationStore } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp4-capture-'));
  tempDirs.push(dir);
  const dbPath = path.join(dir, 'store.db');
  const storeDbA = openStoreDb(dbPath);
  const storeDbB = openStoreDb(dbPath);
  createdClosables.push(storeDbA, storeDbB);
  return {
    a: new CommerceOperationStore({ db: storeDbA.db }),
    b: new CommerceOperationStore({ db: storeDbB.db }),
  };
}

function makeFileBackedStore(): {
  store: CommerceOperationStore;
  dbPath: string;
  storeDb: StoreDb;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp4-capture-'));
  tempDirs.push(dir);
  const dbPath = path.join(dir, 'store.db');
  const storeDb = openStoreDb(dbPath);
  createdClosables.push(storeDb);
  return {
    store: new CommerceOperationStore({ db: storeDb.db }),
    dbPath,
    storeDb,
  };
}

const T0 = new Date('2026-01-01T00:00:00.000Z');
const T1 = new Date('2026-01-01T00:01:00.000Z');
const T2 = new Date('2026-01-01T00:02:00.000Z');
const T3 = new Date('2026-01-01T00:03:00.000Z');
const T4 = new Date('2026-01-01T00:04:00.000Z');
const T5 = new Date('2026-01-01T00:05:00.000Z');
const T55 = new Date('2026-01-01T00:05:30.000Z');
const T6 = new Date('2026-01-01T00:06:00.000Z');
const T7 = new Date('2026-01-01T00:07:00.000Z');
const T8 = new Date('2026-01-01T00:08:00.000Z');

/** Injectable deterministic clock: walks `times`, then stays on the last. */
function makeClock(times: Date[] = [T6, T7]): () => Date {
  let i = 0;
  return () => times[Math.min(i++, times.length - 1)];
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

const OPERATION_ID = 'op-1';
const PAYPAL_ORDER_ID = 'PAYPAL-ORDER-1';
const APPROVED_AMOUNT = 2500;
const APPROVED_CURRENCY = 'EUR' as const;

/** Drive an operation: OPPORTUNITY → … → APPROVED (human/owner approval). */
function driveToApproved(store: CommerceOperationStore, operationId = OPERATION_ID): void {
  store.createOperation(operationId, 'opp-1', T0);
  store.applyOperationEvent(
    operationId,
    {
      type: 'DECISION_PROPOSED',
      decision: {
        opportunityId: 'opp-1',
        action: 'CREATE_PAYMENT',
        amount: APPROVED_AMOUNT,
        currency: APPROVED_CURRENCY,
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

/** APPROVED → EXECUTING → PAYPAL_ORDER_CREATED (durable PayPal order). */
function driveToPayPalOrderCreated(store: CommerceOperationStore, operationId = OPERATION_ID): void {
  driveToApproved(store, operationId);
  store.applyOperationEvent(operationId, { type: 'EXECUTION_STARTED' }, T5);
  store.applyOperationEvent(
    operationId,
    {
      type: 'PAYPAL_ORDER_CREATED',
      paypalOrder: {
        paypalOrderId: PAYPAL_ORDER_ID,
        paypalStatus: 'CREATED',
        requestId: `commercepilot-op-${operationId}`,
      },
    },
    T55
  );
}

/** …plus the durable capture claim → CAPTURE_EXECUTING. */
function driveToCaptureExecuting(store: CommerceOperationStore, operationId = OPERATION_ID): void {
  driveToPayPalOrderCreated(store, operationId);
  store.applyOperationEvent(operationId, { type: 'CAPTURE_STARTED' }, T6);
}

/**
 * Inject a schema-valid raw snapshot with an arbitrary durable status (used
 * for statuses that are awkward to drive through real transitions). Same
 * raw-UPDATE technique as src/store/index.test.ts S2.
 */
function injectRawStatus(
  store: CommerceOperationStore,
  db: SqliteDb,
  status: string,
  snapshotExtras: Record<string, unknown> = {}
): void {
  store.createOperation(OPERATION_ID, 'opp-1', T0);
  db.prepare(
    'UPDATE commerce_operations SET status = ?, snapshot = ?, updated_at = ? WHERE id = ?;'
  ).run(
    status,
    JSON.stringify({
      id: OPERATION_ID,
      opportunityId: 'opp-1',
      status,
      decision: {
        opportunityId: 'opp-1',
        action: 'CREATE_PAYMENT',
        amount: APPROVED_AMOUNT,
        currency: APPROVED_CURRENCY,
        recipient: 'customer@example.com',
        justification: 'Raw-snapshot test payment',
      },
      createdAt: T0.toISOString(),
      updatedAt: T0.toISOString(),
      ...snapshotExtras,
    }),
    T0.toISOString(),
    OPERATION_ID
  );
}

/* ------------------------------------------------------------------ */
/* Offline PayPal boundary fake (NO network, NO credentials)           */
/* ------------------------------------------------------------------ */

/** Buyer-approved PayPal read state (what getOrder truthfully reports). */
function approvedOrderRead(
  overrides: Partial<PayPalGetOrderResult> = {}
): PayPalGetOrderResult {
  return {
    paypalOrderId: PAYPAL_ORDER_ID,
    orderStatus: 'APPROVED',
    captures: [],
    ...overrides,
  };
}

function completedCapture(
  overrides: Partial<PayPalGetOrderResult['captures'][number]> = {}
): PayPalGetOrderResult['captures'][number] {
  return {
    captureId: 'CAP-READ-1',
    status: 'COMPLETED',
    amountMinorUnits: APPROVED_AMOUNT,
    currency: APPROVED_CURRENCY,
    ...overrides,
  };
}

function declinedCapture(
  overrides: Partial<PayPalGetOrderResult['captures'][number]> = {}
): PayPalGetOrderResult['captures'][number] {
  return {
    captureId: 'CAP-DECLINED-READ',
    status: 'DECLINED',
    amountMinorUnits: APPROVED_AMOUNT,
    currency: APPROVED_CURRENCY,
    ...overrides,
  };
}

function captureSuccess(
  overrides: Partial<PayPalCaptureOrderResult> = {}
): PayPalCaptureOrderResult {
  return {
    paypalOrderId: PAYPAL_ORDER_ID,
    orderStatus: 'COMPLETED',
    capture: {
      captureId: 'CAP-TEST-1',
      status: 'COMPLETED',
      amountMinorUnits: APPROVED_AMOUNT,
      currency: APPROVED_CURRENCY,
    },
    requestId: payPalCaptureRequestIdForOperation(OPERATION_ID),
    environment: 'SANDBOX',
    ...overrides,
  };
}

type ScriptedGetOrder =
  | { ok: true; result: PayPalGetOrderResult }
  | { ok: false; error: unknown };
type ScriptedCapture =
  | { ok: true; result: PayPalCaptureOrderResult }
  | { ok: false; error: unknown };

/**
 * Fake PayPal capture executor: records every input, replays scripted
 * outcomes per call, supports a gate that holds a capture call open (for
 * single-flight tests). Defaults to truthful fixtures when the script is
 * empty. No network, no credentials, no config.
 */
class FakePayPalCaptureExecutor implements PayPalCaptureExecutor {
  readonly getOrderInputs: Array<{ readonly paypalOrderId: string }> = [];
  readonly captureInputs: CapturePayPalOrderInput[] = [];
  readonly #getOrderScript: ScriptedGetOrder[] = [];
  readonly #captureScript: ScriptedCapture[] = [];
  #captureGate?: { promise: Promise<void>; release: () => void };

  queueGetOrderSuccess(result: PayPalGetOrderResult = approvedOrderRead()): void {
    this.#getOrderScript.push({ ok: true, result });
  }

  queueGetOrderError(error: unknown): void {
    this.#getOrderScript.push({ ok: false, error });
  }

  queueCaptureSuccess(result: PayPalCaptureOrderResult = captureSuccess()): void {
    this.#captureScript.push({ ok: true, result });
  }

  queueCaptureError(error: unknown): void {
    this.#captureScript.push({ ok: false, error });
  }

  /** Hold the NEXT captureOrder call open until releaseNextCapture(). */
  gateNextCapture(): Promise<void> {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#captureGate = { release, promise };
    return promise;
  }

  releaseNextCapture(): void {
    const gate = this.#captureGate;
    if (gate === undefined) {
      throw new Error('No gated capture call to release');
    }
    this.#captureGate = undefined;
    gate.release();
  }

  async getOrder(input: { readonly paypalOrderId: string }): Promise<PayPalGetOrderResult> {
    this.getOrderInputs.push({ paypalOrderId: input.paypalOrderId });
    const next = this.#getOrderScript.shift();
    if (next === undefined) return approvedOrderRead();
    if (!next.ok) throw next.error;
    return next.result;
  }

  async captureOrder(input: CapturePayPalOrderInput): Promise<PayPalCaptureOrderResult> {
    this.captureInputs.push(input);
    const gate = this.#captureGate;
    if (gate !== undefined) {
      await gate.promise;
    }
    const next = this.#captureScript.shift();
    if (next === undefined) return captureSuccess();
    if (!next.ok) throw next.error;
    return next.result;
  }
}

function makeCaptureOrchestrator(
  store: Pick<CommerceOperationStore, 'getOperation' | 'applyOperationEvent'>,
  paypal: PayPalCaptureExecutor,
  now: () => Date = makeClock()
): CaptureOrchestrator {
  return new CaptureOrchestrator({ store, paypal, now });
}

/* ------------------------------------------------------------------ */
/* Store wrappers for fault injection (structural store substitutes)   */
/* ------------------------------------------------------------------ */

/** Fails applyOperationEvent for the configured event types (local fault). */
class FailOnEventStore {
  readonly #inner: CommerceOperationStore;
  readonly #failOnEventTypes: readonly string[];

  constructor(inner: CommerceOperationStore, failOnEventTypes: readonly string[]) {
    this.#inner = inner;
    this.#failOnEventTypes = failOnEventTypes;
  }

  getOperation(operationId: string): CommerceOperation | undefined {
    return this.#inner.getOperation(operationId);
  }

  applyOperationEvent(
    operationId: string,
    event: CommerceOperationEvent,
    timestamp: Date
  ): AppliedOperationEvent {
    if (this.#failOnEventTypes.includes(event.type)) {
      throw new Error('simulated local persistence failure');
    }
    return this.#inner.applyOperationEvent(operationId, event, timestamp);
  }
}

/**
 * Simulates losing a claim race against a competitor that ALREADY completed
 * the capture durably: the first CAPTURE_STARTED attempt is intercepted, the
 * competitor's completion runs synchronously, and then the intercepted claim
 * proceeds into the (now doomed) real store call.
 */
class CompetingCaptureStore {
  readonly #inner: CommerceOperationStore;
  readonly #competitor: () => void;
  #intercepted = false;

  constructor(inner: CommerceOperationStore, competitor: () => void) {
    this.#inner = inner;
    this.#competitor = competitor;
  }

  getOperation(operationId: string): CommerceOperation | undefined {
    return this.#inner.getOperation(operationId);
  }

  applyOperationEvent(
    operationId: string,
    event: CommerceOperationEvent,
    timestamp: Date
  ): AppliedOperationEvent {
    if (event.type === 'CAPTURE_STARTED' && !this.#intercepted) {
      this.#intercepted = true;
      this.#competitor();
    }
    return this.#inner.applyOperationEvent(operationId, event, timestamp);
  }
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

/** Poll until a condition holds (bounded), for cross-invocation waits. */
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
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

function completedOutcomeOf(outcome: CaptureOutcome): Extract<CaptureOutcome, { kind: 'CAPTURE_COMPLETED' }> {
  if (outcome.kind !== 'CAPTURE_COMPLETED') {
    throw new Error(`Expected CAPTURE_COMPLETED, got ${outcome.kind}`);
  }
  return outcome;
}

/* ------------------------------------------------------------------ */
/* 1. Deterministic capture request ID                                 */
/* ------------------------------------------------------------------ */

describe('CP4. Deterministic capture request ID', () => {
  test('is exactly commercepilot-capture-{operationId}, deterministic, and capture-specific', () => {
    expect(PAYPAL_CAPTURE_REQUEST_ID_PREFIX).toBe('commercepilot-capture-');
    expect(payPalCaptureRequestIdForOperation('op-1')).toBe('commercepilot-capture-op-1');
    // Deterministic: repeated derivation is identical (no randomness).
    expect(payPalCaptureRequestIdForOperation('op-1')).toBe(
      payPalCaptureRequestIdForOperation('op-1')
    );
    // Operation-specific: different operations never share an ID.
    expect(payPalCaptureRequestIdForOperation('op-2')).toBe('commercepilot-capture-op-2');
    // Capture-specific: distinct from the create-order prefix.
    expect(payPalCaptureRequestIdForOperation('op-1')).not.toBe(`commercepilot-op-op-1`);
  });

  test('the capture call carries the deterministic request ID verbatim', async () => {
    const { store } = makeStore();
    driveToPayPalOrderCreated(store);
    const fake = new FakePayPalCaptureExecutor();
    await makeCaptureOrchestrator(store, fake).captureApprovedOrder(OPERATION_ID);

    expect(fake.captureInputs).toHaveLength(1);
    expect(fake.captureInputs[0].requestId).toBe('commercepilot-capture-op-1');
    // The capture target is the PERSISTED PayPal order ID.
    expect(fake.captureInputs[0].paypalOrderId).toBe(PAYPAL_ORDER_ID);
  });
});

/* ------------------------------------------------------------------ */
/* 2. Happy path                                                       */
/* ------------------------------------------------------------------ */

describe('CP4. Happy path — verified buyer approval → single capture → durable COMPLETED', () => {
  test('verifies approval, claims durably, captures once, persists exact evidence', async () => {
    const { store, db } = makeStore();
    driveToPayPalOrderCreated(store);
    const fake = new FakePayPalCaptureExecutor();
    fake.queueGetOrderSuccess(); // buyer-approval verification (APPROVED)
    fake.queueCaptureSuccess();

    const outcome = await makeCaptureOrchestrator(store, fake).captureApprovedOrder(OPERATION_ID);

    // Exact typed outcome with the exact truthful evidence mapping.
    expect(outcome).toEqual({
      kind: 'CAPTURE_COMPLETED',
      operationId: OPERATION_ID,
      paymentResult: {
        success: true,
        transactionId: 'CAP-TEST-1',
        captureId: 'CAP-TEST-1',
        paypalOrderId: PAYPAL_ORDER_ID,
        amount: APPROVED_AMOUNT,
        currency: APPROVED_CURRENCY,
      },
    });

    // Exactly one getOrder (verification) + one capture (claim winner).
    expect(fake.getOrderInputs).toHaveLength(1);
    expect(fake.getOrderInputs[0].paypalOrderId).toBe(PAYPAL_ORDER_ID);
    expect(fake.captureInputs).toHaveLength(1);

    // Durable state: COMPLETED with the same evidence.
    const completed = store.getOperation(OPERATION_ID);
    expect(completed?.status).toBe('COMPLETED');
    expect(completed?.paymentResult).toEqual(
      completedOutcomeOf(outcome).paymentResult
    );

    // Full durable audit trail in order, claim BEFORE outcome.
    expect(rawAuditEventTypes(db, OPERATION_ID)).toEqual([
      'DECISION_PROPOSED',
      'POLICY_APPROVED',
      'REQUEST_HUMAN_APPROVAL',
      'HUMAN_APPROVED',
      'EXECUTION_STARTED',
      'PAYPAL_ORDER_CREATED',
      'CAPTURE_STARTED',
      'PAYMENT_COMPLETED',
    ]);
  });

  test('a completed operation is never captured twice (ALREADY_RESOLVED, zero calls)', async () => {
    const { store } = makeStore();
    driveToPayPalOrderCreated(store);
    const fake = new FakePayPalCaptureExecutor();
    await makeCaptureOrchestrator(store, fake).captureApprovedOrder(OPERATION_ID);
    expect(fake.captureInputs).toHaveLength(1);

    const second = await makeCaptureOrchestrator(store, fake, makeClock([T8])).captureApprovedOrder(
      OPERATION_ID
    );
    expect(second).toEqual({
      kind: 'NOT_CAPTURABLE',
      operationId: OPERATION_ID,
      reason: NOT_CAPTURABLE_REASONS.ALREADY_RESOLVED,
      currentStatus: 'COMPLETED',
    });
    expect(fake.captureInputs).toHaveLength(1); // no second capture
    expect(fake.getOrderInputs).toHaveLength(1); // no second verification read
  });
});

/* ------------------------------------------------------------------ */
/* 3. Buyer-approval gate (provider evidence ONLY)                     */
/* ------------------------------------------------------------------ */

describe('CP4. Buyer-approval gate — provider evidence only, zero capture calls on doubt', () => {
  test('PayPal order status CREATED (not APPROVED) → BUYER_NOT_APPROVED, no claim, zero capture calls', async () => {
    const { store, db } = makeStore();
    driveToPayPalOrderCreated(store);
    const fake = new FakePayPalCaptureExecutor();
    fake.queueGetOrderSuccess(approvedOrderRead({ orderStatus: 'CREATED' }));

    const outcome = await makeCaptureOrchestrator(store, fake).captureApprovedOrder(OPERATION_ID);

    expect(outcome).toEqual({
      kind: 'NOT_CAPTURABLE',
      operationId: OPERATION_ID,
      reason: NOT_CAPTURABLE_REASONS.BUYER_NOT_APPROVED,
      currentStatus: 'PAYPAL_ORDER_CREATED',
      message: expect.stringContaining('CREATED'),
    });
    expect(fake.captureInputs).toHaveLength(0);
    // No durable claim: the operation stays PAYPAL_ORDER_CREATED.
    expect(store.getOperation(OPERATION_ID)?.status).toBe('PAYPAL_ORDER_CREATED');
    expect(rawAuditEventTypes(db, OPERATION_ID)).not.toContain('CAPTURE_STARTED');
  });

  test('getOrder transport failure before the claim → APPROVAL_UNVERIFIED, zero capture calls', async () => {
    const { store } = makeStore();
    driveToPayPalOrderCreated(store);
    const fake = new FakePayPalCaptureExecutor();
    fake.queueGetOrderError(new PayPalHttpApiError('PayPal get-order request failed at the transport level'));

    const outcome = await makeCaptureOrchestrator(store, fake).captureApprovedOrder(OPERATION_ID);

    expect(outcome).toMatchObject({
      kind: 'NOT_CAPTURABLE',
      reason: NOT_CAPTURABLE_REASONS.APPROVAL_UNVERIFIED,
      currentStatus: 'PAYPAL_ORDER_CREATED',
    });
    expect(fake.captureInputs).toHaveLength(0);
    expect(store.getOperation(OPERATION_ID)?.status).toBe('PAYPAL_ORDER_CREATED');
  });

  test('getOrder definite HTTP failure (404) before the claim → APPROVAL_UNVERIFIED, zero capture calls', async () => {
    const { store } = makeStore();
    driveToPayPalOrderCreated(store);
    const fake = new FakePayPalCaptureExecutor();
    fake.queueGetOrderError(
      new PayPalHttpApiError('PayPal get-order failed with HTTP status 404 (INVALID_RESOURCE_ID)', {
        status: 404,
        paypalErrorName: 'INVALID_RESOURCE_ID',
      })
    );

    const outcome = await makeCaptureOrchestrator(store, fake).captureApprovedOrder(OPERATION_ID);

    expect(outcome).toMatchObject({
      kind: 'NOT_CAPTURABLE',
      reason: NOT_CAPTURABLE_REASONS.APPROVAL_UNVERIFIED,
    });
    expect(fake.captureInputs).toHaveLength(0);
  });

  test('get-order echoing a different PayPal order ID → APPROVAL_UNVERIFIED (verification impossible)', async () => {
    const { store } = makeStore();
    driveToPayPalOrderCreated(store);
    const fake = new FakePayPalCaptureExecutor();
    fake.queueGetOrderSuccess(approvedOrderRead({ paypalOrderId: 'PAYPAL-ORDER-OTHER' }));

    const outcome = await makeCaptureOrchestrator(store, fake).captureApprovedOrder(OPERATION_ID);

    expect(outcome).toMatchObject({
      kind: 'NOT_CAPTURABLE',
      reason: NOT_CAPTURABLE_REASONS.APPROVAL_UNVERIFIED,
    });
    expect(fake.captureInputs).toHaveLength(0);
    expect(store.getOperation(OPERATION_ID)?.status).toBe('PAYPAL_ORDER_CREATED');
  });

  test('PayPal reports COMPLETED before capture → ALREADY_CAPTURED_REMOTELY, never captureOrder', async () => {
    const { store } = makeStore();
    driveToPayPalOrderCreated(store);
    const fake = new FakePayPalCaptureExecutor();
    fake.queueGetOrderSuccess(
      approvedOrderRead({ orderStatus: 'COMPLETED', captures: [completedCapture()] })
    );

    const outcome = await makeCaptureOrchestrator(store, fake).captureApprovedOrder(OPERATION_ID);

    expect(outcome).toMatchObject({
      kind: 'NOT_CAPTURABLE',
      reason: NOT_CAPTURABLE_REASONS.ALREADY_CAPTURED_REMOTELY,
      currentStatus: 'PAYPAL_ORDER_CREATED',
    });
    expect(fake.captureInputs).toHaveLength(0);
    expect(store.getOperation(OPERATION_ID)?.status).toBe('PAYPAL_ORDER_CREATED');
  });

  test('owner approval is never treated as buyer approval: APPROVED operation without PayPal APPROVED state is not captured', async () => {
    const { store } = makeStore();
    // Owner-approved + PayPal order created, but PayPal still says CREATED.
    driveToPayPalOrderCreated(store);
    const fake = new FakePayPalCaptureExecutor();
    fake.queueGetOrderSuccess(approvedOrderRead({ orderStatus: 'CREATED' }));

    const outcome = await makeCaptureOrchestrator(store, fake).captureApprovedOrder(OPERATION_ID);

    // The domain's approvalStatus APPROVED must NOT authorize capture.
    expect(outcome).toMatchObject({
      kind: 'NOT_CAPTURABLE',
      reason: NOT_CAPTURABLE_REASONS.BUYER_NOT_APPROVED,
    });
    expect(fake.captureInputs).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* 4. Non-eligible durable statuses → zero PayPal calls                */
/* ------------------------------------------------------------------ */

describe('CP4. Non-eligible durable statuses → zero PayPal calls', () => {
  test('missing operation → OPERATION_NOT_FOUND', async () => {
    const { store } = makeStore();
    const fake = new FakePayPalCaptureExecutor();
    const outcome = await makeCaptureOrchestrator(store, fake).captureApprovedOrder('missing-op');
    expect(outcome).toEqual({
      kind: 'NOT_CAPTURABLE',
      operationId: 'missing-op',
      reason: NOT_CAPTURABLE_REASONS.OPERATION_NOT_FOUND,
    });
    expect(fake.getOrderInputs).toHaveLength(0);
    expect(fake.captureInputs).toHaveLength(0);
  });

  test('every non-eligible durable status short-circuits with the right reason and zero PayPal calls', async () => {
    const cases: Array<[string, string]> = [
      ['OPPORTUNITY', NOT_CAPTURABLE_REASONS.NOT_IN_ORDER_CREATED_STATE],
      ['DECISION_PROPOSED', NOT_CAPTURABLE_REASONS.NOT_IN_ORDER_CREATED_STATE],
      ['POLICY_APPROVED', NOT_CAPTURABLE_REASONS.NOT_IN_ORDER_CREATED_STATE],
      ['POLICY_REJECTED', NOT_CAPTURABLE_REASONS.NOT_IN_ORDER_CREATED_STATE],
      ['POLICY_ESCALATED', NOT_CAPTURABLE_REASONS.NOT_IN_ORDER_CREATED_STATE],
      ['AWAITING_HUMAN_APPROVAL', NOT_CAPTURABLE_REASONS.NOT_IN_ORDER_CREATED_STATE],
      ['APPROVED', NOT_CAPTURABLE_REASONS.NOT_IN_ORDER_CREATED_STATE],
      ['REJECTED_BY_HUMAN', NOT_CAPTURABLE_REASONS.NOT_IN_ORDER_CREATED_STATE],
      ['EXECUTING', NOT_CAPTURABLE_REASONS.NOT_IN_ORDER_CREATED_STATE],
      ['PAYPAL_PENDING', NOT_CAPTURABLE_REASONS.NOT_IN_ORDER_CREATED_STATE],
      // Schema-valid but integrity-broken: PAYPAL_ORDER_CREATED without a
      // persisted paypalOrder (same technique as src/store/index.test.ts S2).
      ['PAYPAL_ORDER_CREATED', NOT_CAPTURABLE_REASONS.MISSING_PERSISTED_PAYPAL_ORDER],
      ['CAPTURE_EXECUTING', NOT_CAPTURABLE_REASONS.ALREADY_CAPTURING],
      ['COMPLETED', NOT_CAPTURABLE_REASONS.ALREADY_RESOLVED],
      ['FAILED', NOT_CAPTURABLE_REASONS.ALREADY_RESOLVED],
      ['OUTCOME_RECORDED', NOT_CAPTURABLE_REASONS.ALREADY_RESOLVED],
    ];
    for (const [status, expectedReason] of cases) {
      const { store, db } = makeStore();
      injectRawStatus(store, db, status);
      const fake = new FakePayPalCaptureExecutor();

      const outcome = await makeCaptureOrchestrator(store, fake).captureApprovedOrder(OPERATION_ID);

      expect(outcome, `status ${status}`).toMatchObject({
        kind: 'NOT_CAPTURABLE',
        operationId: OPERATION_ID,
        reason: expectedReason,
      });
      expect(fake.getOrderInputs, `status ${status}`).toHaveLength(0);
      expect(fake.captureInputs, `status ${status}`).toHaveLength(0);
      // No durable mutation happened.
      expect(store.getOperation(OPERATION_ID)?.status, `status ${status}`).toBe(status);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 5. Single-flight and concurrency                                    */
/* ------------------------------------------------------------------ */

describe('CP4. Single-flight and concurrency', () => {
  test('mid-flight claim: a second invocation sees CAPTURE_EXECUTING and makes ZERO capture calls', async () => {
    const { store } = makeStore();
    driveToPayPalOrderCreated(store);
    const fake = new FakePayPalCaptureExecutor();
    const gate = fake.gateNextCapture();

    const orchestrator = makeCaptureOrchestrator(store, fake);
    const firstPromise = orchestrator.captureApprovedOrder(OPERATION_ID);
    await waitFor(() => fake.captureInputs.length === 1, 'first capture call to arrive');

    // A second invocation (same or different worker) observes the durable claim.
    const second = await makeCaptureOrchestrator(store, fake, makeClock([T8])).captureApprovedOrder(
      OPERATION_ID
    );
    expect(second).toEqual({
      kind: 'NOT_CAPTURABLE',
      operationId: OPERATION_ID,
      reason: NOT_CAPTURABLE_REASONS.ALREADY_CAPTURING,
      currentStatus: 'CAPTURE_EXECUTING',
    });
    expect(fake.captureInputs).toHaveLength(1); // still exactly one attempt

    fake.releaseNextCapture();
    await gate;
    const first = await firstPromise;
    expect(first.kind).toBe('CAPTURE_COMPLETED');
    expect(fake.captureInputs).toHaveLength(1);
  });

  test('TWO store instances over ONE file-backed DB: exactly ONE claim wins, exactly ONE capture call', async () => {
    const { a, b } = makeFileBackedStorePair();
    driveToPayPalOrderCreated(a);
    const fake = new FakePayPalCaptureExecutor();

    const orchestratorA = makeCaptureOrchestrator(a, fake);
    const orchestratorB = makeCaptureOrchestrator(b, fake);

    const [outcomeA, outcomeB] = await Promise.all([
      orchestratorA.captureApprovedOrder(OPERATION_ID),
      orchestratorB.captureApprovedOrder(OPERATION_ID),
    ]);

    const outcomes = [outcomeA, outcomeB];
    const completed = outcomes.filter((o) => o.kind === 'CAPTURE_COMPLETED');
    const alreadyCapturing = outcomes.filter(
      (o) => o.kind === 'NOT_CAPTURABLE' && o.reason === NOT_CAPTURABLE_REASONS.ALREADY_CAPTURING
    );
    expect(completed, JSON.stringify(outcomes)).toHaveLength(1);
    expect(alreadyCapturing, JSON.stringify(outcomes)).toHaveLength(1);

    // At most ONE captureOrder network call across both "processes".
    expect(fake.captureInputs).toHaveLength(1);

    // The durable result is consistent from both connections.
    expect(a.getOperation(OPERATION_ID)?.status).toBe('COMPLETED');
    expect(b.getOperation(OPERATION_ID)?.status).toBe('COMPLETED');
    expect(completedOutcomeOf(completed[0]).paymentResult.captureId).toBe('CAP-TEST-1');
  });

  test('losing a claim race to an already-resolved competitor → ALREADY_RESOLVED (not a store error)', async () => {
    const { store } = makeStore();
    driveToPayPalOrderCreated(store);
    const fake = new FakePayPalCaptureExecutor();

    // The competitor completes the capture synchronously, durably, without
    // touching the fake — this invocation then finds COMPLETED on re-read.
    const competitor = (): void => {
      store.applyOperationEvent(OPERATION_ID, { type: 'CAPTURE_STARTED' }, T6);
      store.applyOperationEvent(
        OPERATION_ID,
        {
          type: 'PAYMENT_COMPLETED',
          paymentResult: {
            success: true,
            transactionId: 'CAP-COMPETE',
            captureId: 'CAP-COMPETE',
            paypalOrderId: PAYPAL_ORDER_ID,
            amount: APPROVED_AMOUNT,
            currency: APPROVED_CURRENCY,
          },
        },
        T7
      );
    };
    const wrapped = new CompetingCaptureStore(store, competitor);

    const outcome = await makeCaptureOrchestrator(wrapped, fake).captureApprovedOrder(OPERATION_ID);

    expect(outcome).toEqual({
      kind: 'NOT_CAPTURABLE',
      operationId: OPERATION_ID,
      reason: NOT_CAPTURABLE_REASONS.ALREADY_RESOLVED,
      currentStatus: 'COMPLETED',
    });
    expect(fake.captureInputs).toHaveLength(0); // loser never calls PayPal
  });

  test('a genuine store failure while claiming rethrows and makes ZERO PayPal calls', async () => {
    const { store } = makeStore();
    driveToPayPalOrderCreated(store);
    const fake = new FakePayPalCaptureExecutor();
    const wrapped = new FailOnEventStore(store, ['CAPTURE_STARTED']);

    const error = await failureOf(
      makeCaptureOrchestrator(wrapped, fake).captureApprovedOrder(OPERATION_ID)
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('simulated local persistence failure');

    expect(fake.captureInputs).toHaveLength(0);
    // The claim never committed: durable status unchanged.
    expect(store.getOperation(OPERATION_ID)?.status).toBe('PAYPAL_ORDER_CREATED');
  });
});

/* ------------------------------------------------------------------ */
/* 6. Post-claim failure classification                                */
/* ------------------------------------------------------------------ */

describe('CP4. Post-claim failure classification', () => {
  test('transport ambiguity (status undefined) → CAPTURE_AMBIGUOUS, durable stays CAPTURE_EXECUTING, ONE attempt', async () => {
    const { store } = makeStore();
    driveToPayPalOrderCreated(store);
    const fake = new FakePayPalCaptureExecutor();
    fake.queueGetOrderSuccess();
    fake.queueCaptureError(
      new PayPalHttpApiError('PayPal capture request failed at the transport level (remote outcome unknown)')
    );

    const outcome = await makeCaptureOrchestrator(store, fake).captureApprovedOrder(OPERATION_ID);

    expect(outcome).toMatchObject({ kind: 'CAPTURE_AMBIGUOUS', operationId: OPERATION_ID });
    expect(fake.captureInputs).toHaveLength(1); // no automatic retry
    expect(store.getOperation(OPERATION_ID)?.status).toBe('CAPTURE_EXECUTING');
    expect(store.getOperation(OPERATION_ID)?.paymentResult).toBeUndefined();
  });

  test('5xx server error → CAPTURE_AMBIGUOUS, durable stays CAPTURE_EXECUTING', async () => {
    const { store } = makeStore();
    driveToPayPalOrderCreated(store);
    const fake = new FakePayPalCaptureExecutor();
    fake.queueGetOrderSuccess();
    fake.queueCaptureError(
      new PayPalHttpApiError('PayPal capture failed with HTTP status 500 (INTERNAL_SERVICE_ERROR)', {
        status: 500,
        paypalErrorName: 'INTERNAL_SERVICE_ERROR',
      })
    );

    const outcome = await makeCaptureOrchestrator(store, fake).captureApprovedOrder(OPERATION_ID);

    expect(outcome).toMatchObject({ kind: 'CAPTURE_AMBIGUOUS' });
    expect(fake.captureInputs).toHaveLength(1);
    expect(store.getOperation(OPERATION_ID)?.status).toBe('CAPTURE_EXECUTING');
  });

  test('malformed 2xx response → CAPTURE_AMBIGUOUS, durable stays CAPTURE_EXECUTING', async () => {
    const { store } = makeStore();
    driveToPayPalOrderCreated(store);
    const fake = new FakePayPalCaptureExecutor();
    fake.queueGetOrderSuccess();
    fake.queueCaptureError(
      new PayPalMalformedResponseError('PayPal capture response failed validation')
    );

    const outcome = await makeCaptureOrchestrator(store, fake).captureApprovedOrder(OPERATION_ID);

    expect(outcome).toMatchObject({ kind: 'CAPTURE_AMBIGUOUS' });
    expect(store.getOperation(OPERATION_ID)?.status).toBe('CAPTURE_EXECUTING');
  });

  test('unknown error shape → conservatively CAPTURE_AMBIGUOUS, never false FAILED', async () => {
    const { store } = makeStore();
    driveToPayPalOrderCreated(store);
    const fake = new FakePayPalCaptureExecutor();
    fake.queueGetOrderSuccess();
    fake.queueCaptureError(new Error('something entirely unexpected'));

    const outcome = await makeCaptureOrchestrator(store, fake).captureApprovedOrder(OPERATION_ID);

    expect(outcome).toMatchObject({ kind: 'CAPTURE_AMBIGUOUS' });
    expect(store.getOperation(OPERATION_ID)?.status).toBe('CAPTURE_EXECUTING');
  });

  test('definite 4xx rejection → CAPTURE_FAILED to the caller; durable stays CAPTURE_EXECUTING (domain evidence rule)', async () => {
    const { store } = makeStore();
    driveToPayPalOrderCreated(store);
    const fake = new FakePayPalCaptureExecutor();
    fake.queueGetOrderSuccess();
    fake.queueCaptureError(
      new PayPalHttpApiError('PayPal capture failed with HTTP status 400 (INVALID_REQUEST)', {
        status: 400,
        paypalErrorName: 'INVALID_REQUEST',
      })
    );

    const outcome = await makeCaptureOrchestrator(store, fake).captureApprovedOrder(OPERATION_ID);

    expect(outcome).toMatchObject({ kind: 'CAPTURE_FAILED', operationId: OPERATION_ID });
    expect((outcome as { message: string }).message).toContain('HTTP 400');
    expect(fake.captureInputs).toHaveLength(1); // exactly one attempt
    // The domain state machine requires capture evidence for a durable
    // outcome from CAPTURE_EXECUTING — a bare 4xx carries none, so the
    // operation truthfully remains CAPTURE_EXECUTING (no false FAILED).
    expect(store.getOperation(OPERATION_ID)?.status).toBe('CAPTURE_EXECUTING');
    expect(store.getOperation(OPERATION_ID)?.paymentResult).toBeUndefined();
  });

  test('pre-HTTP local validation failure → CAPTURE_FAILED (no side effect), durable stays CAPTURE_EXECUTING', async () => {
    const { store } = makeStore();
    driveToPayPalOrderCreated(store);
    const fake = new FakePayPalCaptureExecutor();
    fake.queueGetOrderSuccess();
    fake.queueCaptureError(new PayPalInvalidRequestError('requestId must be a non-empty string'));

    const outcome = await makeCaptureOrchestrator(store, fake).captureApprovedOrder(OPERATION_ID);

    expect(outcome).toMatchObject({ kind: 'CAPTURE_FAILED' });
    expect((outcome as { message: string }).message).toContain('before any capture request was sent');
    expect(store.getOperation(OPERATION_ID)?.status).toBe('CAPTURE_EXECUTING');
  });

  test('OAuth/config failure before the capture POST → CAPTURE_FAILED (no side effect), durable stays CAPTURE_EXECUTING', async () => {
    const { store } = makeStore();
    driveToPayPalOrderCreated(store);
    const fake = new FakePayPalCaptureExecutor();
    fake.queueGetOrderSuccess();
    fake.queueCaptureError(
      new PayPalAuthenticationError('PayPal OAuth token request failed with HTTP status 401', {
        status: 401,
      })
    );

    const outcome = await makeCaptureOrchestrator(store, fake).captureApprovedOrder(OPERATION_ID);

    expect(outcome).toMatchObject({ kind: 'CAPTURE_FAILED' });
    expect(store.getOperation(OPERATION_ID)?.status).toBe('CAPTURE_EXECUTING');
  });

  test('configuration failure (missing credentials) → CAPTURE_FAILED, durable stays CAPTURE_EXECUTING', async () => {
    const { store } = makeStore();
    driveToPayPalOrderCreated(store);
    const fake = new FakePayPalCaptureExecutor();
    fake.queueGetOrderSuccess();
    fake.queueCaptureError(
      new PayPalConfigurationError('PayPal client credentials are not configured')
    );

    const outcome = await makeCaptureOrchestrator(store, fake).captureApprovedOrder(OPERATION_ID);

    expect(outcome).toMatchObject({ kind: 'CAPTURE_FAILED' });
    expect(store.getOperation(OPERATION_ID)?.status).toBe('CAPTURE_EXECUTING');
  });

  test('ORDER_ALREADY_CAPTURED → NEVER FAILED; routes to reconciliation and resolves COMPLETED from read evidence', async () => {
    const { store } = makeStore();
    driveToPayPalOrderCreated(store);
    const fake = new FakePayPalCaptureExecutor();
    fake.queueGetOrderSuccess(); // 1st read: buyer-approval verification (APPROVED)
    fake.queueCaptureError(
      new PayPalHttpApiError(
        'PayPal capture failed with HTTP status 422 (ORDER_ALREADY_CAPTURED)',
        { status: 422, paypalErrorName: 'ORDER_ALREADY_CAPTURED' }
      )
    );
    fake.queueGetOrderSuccess(
      // 2nd read: reconciliation finds the prior capture.
      approvedOrderRead({ orderStatus: 'COMPLETED', captures: [completedCapture()] })
    );

    const outcome = await makeCaptureOrchestrator(store, fake).captureApprovedOrder(OPERATION_ID);

    expect(outcome.kind).toBe('CAPTURE_COMPLETED');
    const paymentResult = completedOutcomeOf(outcome).paymentResult;
    expect(paymentResult).toEqual({
      success: true,
      transactionId: 'CAP-READ-1',
      captureId: 'CAP-READ-1',
      paypalOrderId: PAYPAL_ORDER_ID,
      amount: APPROVED_AMOUNT,
      currency: APPROVED_CURRENCY,
    });
    expect(fake.captureInputs).toHaveLength(1); // the original attempt only
    expect(fake.getOrderInputs).toHaveLength(2); // verification + reconciliation
    expect(store.getOperation(OPERATION_ID)?.status).toBe('COMPLETED');
  });

  test('ORDER_ALREADY_CAPTURED with unresolved read evidence → CAPTURE_AMBIGUOUS, stays CAPTURE_EXECUTING', async () => {
    const { store } = makeStore();
    driveToPayPalOrderCreated(store);
    const fake = new FakePayPalCaptureExecutor();
    fake.queueGetOrderSuccess(); // verification (APPROVED, no captures)
    fake.queueCaptureError(
      new PayPalHttpApiError(
        'PayPal capture failed with HTTP status 422 (ORDER_ALREADY_CAPTURED)',
        { status: 422, paypalErrorName: 'ORDER_ALREADY_CAPTURED' }
      )
    );
    fake.queueGetOrderSuccess(approvedOrderRead()); // reconciliation: no capture evidence

    const outcome = await makeCaptureOrchestrator(store, fake).captureApprovedOrder(OPERATION_ID);

    expect(outcome).toMatchObject({ kind: 'CAPTURE_AMBIGUOUS' });
    expect(fake.captureInputs).toHaveLength(1);
    expect(store.getOperation(OPERATION_ID)?.status).toBe('CAPTURE_EXECUTING');
  });
});

/* ------------------------------------------------------------------ */
/* 7. Capture result integrity                                         */
/* ------------------------------------------------------------------ */

describe('CP4. Capture result integrity — mismatches never become COMPLETED or FAILED', () => {
  test('echoed result tied to a FOREIGN PayPal order → CAPTURE_INTEGRITY_FAULT, stays CAPTURE_EXECUTING', async () => {
    const { store } = makeStore();
    driveToPayPalOrderCreated(store);
    const fake = new FakePayPalCaptureExecutor();
    fake.queueGetOrderSuccess();
    fake.queueCaptureSuccess(captureSuccess({ paypalOrderId: 'PAYPAL-ORDER-FOREIGN' }));

    const outcome = await makeCaptureOrchestrator(store, fake).captureApprovedOrder(OPERATION_ID);

    expect(outcome).toMatchObject({
      kind: 'CAPTURE_INTEGRITY_FAULT',
      operationId: OPERATION_ID,
    });
    expect(store.getOperation(OPERATION_ID)?.status).toBe('CAPTURE_EXECUTING');
    expect(store.getOperation(OPERATION_ID)?.paymentResult).toBeUndefined();
  });

  test('amount mismatch vs the persisted decision → CAPTURE_INTEGRITY_FAULT', async () => {
    const { store } = makeStore();
    driveToPayPalOrderCreated(store);
    const fake = new FakePayPalCaptureExecutor();
    fake.queueGetOrderSuccess();
    fake.queueCaptureSuccess(
      captureSuccess({
        capture: {
          captureId: 'CAP-TEST-1',
          status: 'COMPLETED',
          amountMinorUnits: 9999,
          currency: APPROVED_CURRENCY,
        },
      })
    );

    const outcome = await makeCaptureOrchestrator(store, fake).captureApprovedOrder(OPERATION_ID);

    expect(outcome).toMatchObject({ kind: 'CAPTURE_INTEGRITY_FAULT' });
    expect(store.getOperation(OPERATION_ID)?.status).toBe('CAPTURE_EXECUTING');
  });

  test('currency mismatch vs the persisted decision → CAPTURE_INTEGRITY_FAULT', async () => {
    const { store } = makeStore();
    driveToPayPalOrderCreated(store);
    const fake = new FakePayPalCaptureExecutor();
    fake.queueGetOrderSuccess();
    fake.queueCaptureSuccess(
      captureSuccess({
        capture: {
          captureId: 'CAP-TEST-1',
          status: 'COMPLETED',
          amountMinorUnits: APPROVED_AMOUNT,
          currency: 'USD',
        },
      })
    );

    const outcome = await makeCaptureOrchestrator(store, fake).captureApprovedOrder(OPERATION_ID);

    expect(outcome).toMatchObject({ kind: 'CAPTURE_INTEGRITY_FAULT' });
    expect(store.getOperation(OPERATION_ID)?.status).toBe('CAPTURE_EXECUTING');
  });

  test('COMPLETED capture with an empty capture ID → CAPTURE_INTEGRITY_FAULT', async () => {
    const { store } = makeStore();
    driveToPayPalOrderCreated(store);
    const fake = new FakePayPalCaptureExecutor();
    fake.queueGetOrderSuccess();
    fake.queueCaptureSuccess(
      captureSuccess({
        capture: {
          captureId: '',
          status: 'COMPLETED',
          amountMinorUnits: APPROVED_AMOUNT,
          currency: APPROVED_CURRENCY,
        },
      })
    );

    const outcome = await makeCaptureOrchestrator(store, fake).captureApprovedOrder(OPERATION_ID);

    expect(outcome).toMatchObject({ kind: 'CAPTURE_INTEGRITY_FAULT' });
    expect(store.getOperation(OPERATION_ID)?.status).toBe('CAPTURE_EXECUTING');
  });

  test('non-COMPLETED capture result (PENDING) → CAPTURE_AMBIGUOUS, stays CAPTURE_EXECUTING', async () => {
    const { store } = makeStore();
    driveToPayPalOrderCreated(store);
    const fake = new FakePayPalCaptureExecutor();
    fake.queueGetOrderSuccess();
    fake.queueCaptureSuccess(
      captureSuccess({
        capture: {
          captureId: 'CAP-PENDING-1',
          status: 'PENDING',
          amountMinorUnits: APPROVED_AMOUNT,
          currency: APPROVED_CURRENCY,
        },
      })
    );

    const outcome = await makeCaptureOrchestrator(store, fake).captureApprovedOrder(OPERATION_ID);

    expect(outcome).toMatchObject({ kind: 'CAPTURE_AMBIGUOUS' });
    expect(store.getOperation(OPERATION_ID)?.status).toBe('CAPTURE_EXECUTING');
  });

  test('DECLINED capture result (positive decline evidence) → durable FAILED with evidence', async () => {
    const { store, db } = makeStore();
    driveToPayPalOrderCreated(store);
    const fake = new FakePayPalCaptureExecutor();
    fake.queueGetOrderSuccess();
    fake.queueCaptureSuccess(
      captureSuccess({
        capture: {
          captureId: 'CAP-DECLINED-1',
          status: 'DECLINED',
          amountMinorUnits: APPROVED_AMOUNT,
          currency: APPROVED_CURRENCY,
        },
      })
    );

    const outcome = await makeCaptureOrchestrator(store, fake).captureApprovedOrder(OPERATION_ID);

    expect(outcome).toMatchObject({ kind: 'CAPTURE_FAILED', operationId: OPERATION_ID });
    const failed = store.getOperation(OPERATION_ID);
    expect(failed?.status).toBe('FAILED');
    expect(failed?.paymentResult).toMatchObject({
      success: false,
      transactionId: 'CAP-DECLINED-1',
      captureId: 'CAP-DECLINED-1',
      paypalOrderId: PAYPAL_ORDER_ID,
      amount: APPROVED_AMOUNT,
      currency: APPROVED_CURRENCY,
    });
    expect(rawAuditEventTypes(db, OPERATION_ID)).toEqual([
      'DECISION_PROPOSED',
      'POLICY_APPROVED',
      'REQUEST_HUMAN_APPROVAL',
      'HUMAN_APPROVED',
      'EXECUTION_STARTED',
      'PAYPAL_ORDER_CREATED',
      'CAPTURE_STARTED',
      'PAYMENT_FAILED',
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* 8. Remote success + local persistence failure                       */
/* ------------------------------------------------------------------ */

describe('CP4. Remote capture succeeds, local persistence fails', () => {
  test('PAYMENT_COMPLETED persistence failure → CAPTURE_RECOVERY_REQUIRED with the known result; durable stays CAPTURE_EXECUTING', async () => {
    const { store } = makeStore();
    driveToPayPalOrderCreated(store);
    const wrapped = new FailOnEventStore(store, ['PAYMENT_COMPLETED']);
    const fake = new FakePayPalCaptureExecutor();
    fake.queueGetOrderSuccess();
    fake.queueCaptureSuccess();

    const outcome = await makeCaptureOrchestrator(wrapped, fake).captureApprovedOrder(OPERATION_ID);

    expect(outcome.kind).toBe('CAPTURE_RECOVERY_REQUIRED');
    const recovery = outcome as Extract<CaptureOutcome, { kind: 'CAPTURE_RECOVERY_REQUIRED' }>;
    expect(recovery.captureResult).toEqual(captureSuccess());
    expect((outcome as { message: string }).message).toContain('persistKnownCaptureResult');
    // Exactly ONE capture call — never re-captured.
    expect(fake.captureInputs).toHaveLength(1);
    // Durable state: still claimed, not resolved, not falsely failed.
    expect(store.getOperation(OPERATION_ID)?.status).toBe('CAPTURE_EXECUTING');
    expect(store.getOperation(OPERATION_ID)?.paymentResult).toBeUndefined();
  });

  test('persistKnownCaptureResult recovers with ZERO PayPal calls and durable COMPLETED', async () => {
    const { store } = makeStore();
    driveToPayPalOrderCreated(store);
    const wrapped = new FailOnEventStore(store, ['PAYMENT_COMPLETED']);
    const fake = new FakePayPalCaptureExecutor();
    fake.queueGetOrderSuccess();
    fake.queueCaptureSuccess();

    await makeCaptureOrchestrator(wrapped, fake).captureApprovedOrder(OPERATION_ID);
    const callsBeforeRecovery = fake.captureInputs.length;

    const recovered = makeCaptureOrchestrator(store, fake).persistKnownCaptureResult(
      OPERATION_ID,
      captureSuccess()
    );

    expect(recovered).toEqual({
      kind: 'RECOVERED',
      operationId: OPERATION_ID,
      paymentResult: {
        success: true,
        transactionId: 'CAP-TEST-1',
        captureId: 'CAP-TEST-1',
        paypalOrderId: PAYPAL_ORDER_ID,
        amount: APPROVED_AMOUNT,
        currency: APPROVED_CURRENCY,
      },
    });
    expect(store.getOperation(OPERATION_ID)?.status).toBe('COMPLETED');
    // ZERO PayPal calls during recovery.
    expect(fake.captureInputs.length).toBe(callsBeforeRecovery);
    expect(fake.getOrderInputs).toHaveLength(1);
  });

  test('recovery is idempotent: repeating the SAME evidence → ALREADY_RECOVERED no-op', () => {
    const { store } = makeStore();
    driveToCaptureExecuting(store);
    const fake = new FakePayPalCaptureExecutor();

    const first = makeCaptureOrchestrator(store, fake).persistKnownCaptureResult(
      OPERATION_ID,
      captureSuccess()
    );
    expect(first.kind).toBe('RECOVERED');

    const second = makeCaptureOrchestrator(store, fake).persistKnownCaptureResult(
      OPERATION_ID,
      captureSuccess()
    );
    expect(second).toEqual({
      kind: 'ALREADY_RECOVERED',
      operationId: OPERATION_ID,
      paymentResult: {
        success: true,
        transactionId: 'CAP-TEST-1',
        captureId: 'CAP-TEST-1',
        paypalOrderId: PAYPAL_ORDER_ID,
        amount: APPROVED_AMOUNT,
        currency: APPROVED_CURRENCY,
      },
    });
    expect(fake.captureInputs).toHaveLength(0);
  });

  test('recovery with CONFLICTING capture evidence → refused, durable state unchanged', () => {
    const { store } = makeStore();
    driveToCaptureExecuting(store);
    const fake = new FakePayPalCaptureExecutor();

    const first = makeCaptureOrchestrator(store, fake).persistKnownCaptureResult(
      OPERATION_ID,
      captureSuccess()
    );
    expect(first.kind).toBe('RECOVERED');

    const conflict = makeCaptureOrchestrator(store, fake).persistKnownCaptureResult(
      OPERATION_ID,
      captureSuccess({
        capture: {
          captureId: 'CAP-DIFFERENT',
          status: 'COMPLETED',
          amountMinorUnits: APPROVED_AMOUNT,
          currency: APPROVED_CURRENCY,
        },
      })
    );
    expect(conflict).toEqual({
      kind: 'RECOVERY_NOT_APPLICABLE',
      operationId: OPERATION_ID,
      reason: RECOVERY_NOT_APPLICABLE_REASONS.CAPTURE_EVIDENCE_CONFLICT,
    });
    // The original evidence remains authoritative.
    expect(store.getOperation(OPERATION_ID)?.paymentResult?.captureId).toBe('CAP-TEST-1');
  });

  test('recovery for a DIFFERENT PayPal order → WRONG_PAYPAL_ORDER, zero calls', () => {
    const { store } = makeStore();
    driveToCaptureExecuting(store);
    const fake = new FakePayPalCaptureExecutor();

    const result = makeCaptureOrchestrator(store, fake).persistKnownCaptureResult(
      OPERATION_ID,
      captureSuccess({ paypalOrderId: 'PAYPAL-ORDER-FOREIGN' })
    );
    expect(result).toEqual({
      kind: 'RECOVERY_NOT_APPLICABLE',
      operationId: OPERATION_ID,
      reason: RECOVERY_NOT_APPLICABLE_REASONS.WRONG_PAYPAL_ORDER,
    });
    expect(fake.captureInputs).toHaveLength(0);
    expect(store.getOperation(OPERATION_ID)?.status).toBe('CAPTURE_EXECUTING');
  });

  test('recovery of a non-COMPLETED capture → NOT_A_COMPLETED_CAPTURE', () => {
    const { store } = makeStore();
    driveToCaptureExecuting(store);
    const fake = new FakePayPalCaptureExecutor();

    const result = makeCaptureOrchestrator(store, fake).persistKnownCaptureResult(
      OPERATION_ID,
      captureSuccess({
        capture: {
          captureId: 'CAP-PENDING-1',
          status: 'PENDING',
          amountMinorUnits: APPROVED_AMOUNT,
          currency: APPROVED_CURRENCY,
        },
      })
    );
    expect(result).toEqual({
      kind: 'RECOVERY_NOT_APPLICABLE',
      operationId: OPERATION_ID,
      reason: RECOVERY_NOT_APPLICABLE_REASONS.NOT_A_COMPLETED_CAPTURE,
    });
  });

  test('recovery with an integrity-failing amount → CAPTURE_EVIDENCE_INTEGRITY_FAULT', () => {
    const { store } = makeStore();
    driveToCaptureExecuting(store);
    const fake = new FakePayPalCaptureExecutor();

    const result = makeCaptureOrchestrator(store, fake).persistKnownCaptureResult(
      OPERATION_ID,
      captureSuccess({
        capture: {
          captureId: 'CAP-TEST-1',
          status: 'COMPLETED',
          amountMinorUnits: 1,
          currency: APPROVED_CURRENCY,
        },
      })
    );
    expect(result).toEqual({
      kind: 'RECOVERY_NOT_APPLICABLE',
      operationId: OPERATION_ID,
      reason: RECOVERY_NOT_APPLICABLE_REASONS.CAPTURE_EVIDENCE_INTEGRITY_FAULT,
    });
    expect(store.getOperation(OPERATION_ID)?.status).toBe('CAPTURE_EXECUTING');
  });

  test('recovery on a non-CAPTURING operation → OPERATION_NOT_CAPTURING', () => {
    const { store } = makeStore();
    // PAYPAL_ORDER_CREATED has the persisted order but no durable claim.
    driveToPayPalOrderCreated(store);
    const fake = new FakePayPalCaptureExecutor();

    const result = makeCaptureOrchestrator(store, fake).persistKnownCaptureResult(
      OPERATION_ID,
      captureSuccess()
    );
    expect(result.kind).toBe('RECOVERY_NOT_APPLICABLE');
    expect((result as { reason: string }).reason).toContain('OPERATION_NOT_CAPTURING');
    expect(fake.captureInputs).toHaveLength(0);
  });

  test('recovery for a missing operation → OPERATION_NOT_FOUND', () => {
    const { store } = makeStore();
    const fake = new FakePayPalCaptureExecutor();
    const result = makeCaptureOrchestrator(store, fake).persistKnownCaptureResult(
      'missing-op',
      captureSuccess()
    );
    expect(result).toEqual({
      kind: 'RECOVERY_NOT_APPLICABLE',
      operationId: 'missing-op',
      reason: RECOVERY_NOT_APPLICABLE_REASONS.OPERATION_NOT_FOUND,
    });
  });
});

/* ------------------------------------------------------------------ */
/* 9. Reconciliation (getOrder ONLY — never captureOrder)              */
/* ------------------------------------------------------------------ */

describe('CP4. Reconciliation — positive evidence only, getOrder only', () => {
  test('completed capture in PayPal read state → RESOLVED_COMPLETED, durable COMPLETED, zero capture calls', async () => {
    const { store, db } = makeStore();
    driveToCaptureExecuting(store);
    const fake = new FakePayPalCaptureExecutor();
    fake.queueGetOrderSuccess(
      approvedOrderRead({ orderStatus: 'COMPLETED', captures: [completedCapture()] })
    );

    const outcome = await makeCaptureOrchestrator(store, fake, makeClock([T8])).reconcileCapture(
      OPERATION_ID
    );

    expect(outcome).toEqual({
      kind: 'RESOLVED_COMPLETED',
      operationId: OPERATION_ID,
      paymentResult: {
        success: true,
        transactionId: 'CAP-READ-1',
        captureId: 'CAP-READ-1',
        paypalOrderId: PAYPAL_ORDER_ID,
        amount: APPROVED_AMOUNT,
        currency: APPROVED_CURRENCY,
      },
    });
    expect(store.getOperation(OPERATION_ID)?.status).toBe('COMPLETED');
    expect(rawAuditEventTypes(db, OPERATION_ID)).toContain('PAYMENT_COMPLETED');
    expect(fake.captureInputs).toHaveLength(0); // reconciliation NEVER captures
  });

  test('DECLINED capture in PayPal read state → RESOLVED_FAILED, durable FAILED', async () => {
    const { store } = makeStore();
    driveToCaptureExecuting(store);
    const fake = new FakePayPalCaptureExecutor();
    fake.queueGetOrderSuccess(
      approvedOrderRead({ orderStatus: 'FAILED', captures: [declinedCapture()] })
    );

    const outcome = await makeCaptureOrchestrator(store, fake, makeClock([T8])).reconcileCapture(
      OPERATION_ID
    );

    expect(outcome.kind).toBe('RESOLVED_FAILED');
    const failed = outcome as Extract<ReconcileOutcome, { kind: 'RESOLVED_FAILED' }>;
    expect(failed.paymentResult.success).toBe(false);
    expect(failed.paymentResult.captureId).toBe('CAP-DECLINED-READ');
    expect(store.getOperation(OPERATION_ID)?.status).toBe('FAILED');
    expect(fake.captureInputs).toHaveLength(0);
  });

  test('zero captures → UNRESOLVED; durable stays CAPTURE_EXECUTING (absence is not proof)', async () => {
    const { store } = makeStore();
    driveToCaptureExecuting(store);
    const fake = new FakePayPalCaptureExecutor();
    fake.queueGetOrderSuccess(approvedOrderRead()); // APPROVED, no captures

    const outcome = await makeCaptureOrchestrator(store, fake, makeClock([T8])).reconcileCapture(
      OPERATION_ID
    );

    expect(outcome).toMatchObject({ kind: 'UNRESOLVED', operationId: OPERATION_ID });
    expect((outcome as { message: string }).message).toContain('CAPTURE_EXECUTING');
    expect(store.getOperation(OPERATION_ID)?.status).toBe('CAPTURE_EXECUTING');
    expect(fake.captureInputs).toHaveLength(0);
  });

  test('PENDING capture → UNRESOLVED, durable stays CAPTURE_EXECUTING', async () => {
    const { store } = makeStore();
    driveToCaptureExecuting(store);
    const fake = new FakePayPalCaptureExecutor();
    fake.queueGetOrderSuccess(
      approvedOrderRead({
        orderStatus: 'PENDING',
        captures: [
          {
            captureId: 'CAP-PENDING-READ',
            status: 'PENDING',
            amountMinorUnits: APPROVED_AMOUNT,
            currency: APPROVED_CURRENCY,
          },
        ],
      })
    );

    const outcome = await makeCaptureOrchestrator(store, fake, makeClock([T8])).reconcileCapture(
      OPERATION_ID
    );

    expect(outcome).toMatchObject({ kind: 'UNRESOLVED' });
    expect(store.getOperation(OPERATION_ID)?.status).toBe('CAPTURE_EXECUTING');
  });

  test('reconciliation read transport failure → UNRESOLVED, durable stays CAPTURE_EXECUTING', async () => {
    const { store } = makeStore();
    driveToCaptureExecuting(store);
    const fake = new FakePayPalCaptureExecutor();
    fake.queueGetOrderError(
      new PayPalHttpApiError('PayPal get-order request failed at the transport level')
    );

    const outcome = await makeCaptureOrchestrator(store, fake, makeClock([T8])).reconcileCapture(
      OPERATION_ID
    );

    expect(outcome).toMatchObject({ kind: 'UNRESOLVED' });
    expect(store.getOperation(OPERATION_ID)?.status).toBe('CAPTURE_EXECUTING');
    expect(fake.captureInputs).toHaveLength(0);
  });

  test('reconciliation read 5xx → UNRESOLVED (never a false conclusion)', async () => {
    const { store } = makeStore();
    driveToCaptureExecuting(store);
    const fake = new FakePayPalCaptureExecutor();
    fake.queueGetOrderError(
      new PayPalHttpApiError('PayPal get-order failed with HTTP status 500', { status: 500 })
    );

    const outcome = await makeCaptureOrchestrator(store, fake, makeClock([T8])).reconcileCapture(
      OPERATION_ID
    );

    expect(outcome).toMatchObject({ kind: 'UNRESOLVED' });
    expect(store.getOperation(OPERATION_ID)?.status).toBe('CAPTURE_EXECUTING');
  });

  test('multiple captures reported → UNRESOLVED (not a trustworthy single-capture conclusion)', async () => {
    const { store } = makeStore();
    driveToCaptureExecuting(store);
    const fake = new FakePayPalCaptureExecutor();
    fake.queueGetOrderSuccess(
      approvedOrderRead({
        orderStatus: 'COMPLETED',
        captures: [completedCapture(), completedCapture({ captureId: 'CAP-READ-2' })],
      })
    );

    const outcome = await makeCaptureOrchestrator(store, fake, makeClock([T8])).reconcileCapture(
      OPERATION_ID
    );

    expect(outcome).toMatchObject({ kind: 'UNRESOLVED' });
    expect(store.getOperation(OPERATION_ID)?.status).toBe('CAPTURE_EXECUTING');
  });

  test('completed capture failing amount integrity → UNRESOLVED for human resolution', async () => {
    const { store } = makeStore();
    driveToCaptureExecuting(store);
    const fake = new FakePayPalCaptureExecutor();
    fake.queueGetOrderSuccess(
      approvedOrderRead({
        orderStatus: 'COMPLETED',
        captures: [completedCapture({ amountMinorUnits: 1 })],
      })
    );

    const outcome = await makeCaptureOrchestrator(store, fake, makeClock([T8])).reconcileCapture(
      OPERATION_ID
    );

    expect(outcome).toMatchObject({ kind: 'UNRESOLVED' });
    expect(store.getOperation(OPERATION_ID)?.status).toBe('CAPTURE_EXECUTING');
  });

  test('get-order echoing a different order → UNRESOLVED (no conclusion from foreign evidence)', async () => {
    const { store } = makeStore();
    driveToCaptureExecuting(store);
    const fake = new FakePayPalCaptureExecutor();
    fake.queueGetOrderSuccess(
      approvedOrderRead({
        paypalOrderId: 'PAYPAL-ORDER-FOREIGN',
        orderStatus: 'COMPLETED',
        captures: [completedCapture()],
      })
    );

    const outcome = await makeCaptureOrchestrator(store, fake, makeClock([T8])).reconcileCapture(
      OPERATION_ID
    );

    expect(outcome).toMatchObject({ kind: 'UNRESOLVED' });
    expect(store.getOperation(OPERATION_ID)?.status).toBe('CAPTURE_EXECUTING');
  });

  test('non-CAPTURING operation → NOT_RECONCILABLE', async () => {
    const { store } = makeStore();
    driveToPayPalOrderCreated(store); // status PAYPAL_ORDER_CREATED, no claim
    const fake = new FakePayPalCaptureExecutor();

    const outcome = await makeCaptureOrchestrator(store, fake).reconcileCapture(OPERATION_ID);

    expect(outcome).toEqual({
      kind: 'NOT_RECONCILABLE',
      operationId: OPERATION_ID,
      reason: NOT_RECONCILABLE_REASONS.NOT_CAPTURING,
      currentStatus: 'PAYPAL_ORDER_CREATED',
    });
    expect(fake.getOrderInputs).toHaveLength(0);
  });

  test('missing operation → NOT_RECONCILABLE OPERATION_NOT_FOUND; completed operation → NOT_RECONCILABLE', async () => {
    const { store } = makeStore();
    const fake = new FakePayPalCaptureExecutor();
    const missing = await makeCaptureOrchestrator(store, fake).reconcileCapture('missing-op');
    expect(missing).toEqual({
      kind: 'NOT_RECONCILABLE',
      operationId: 'missing-op',
      reason: NOT_RECONCILABLE_REASONS.OPERATION_NOT_FOUND,
    });

    driveToPayPalOrderCreated(store);
    await makeCaptureOrchestrator(store, fake).captureApprovedOrder(OPERATION_ID);
    const resolved = await makeCaptureOrchestrator(store, fake, makeClock([T8])).reconcileCapture(
      OPERATION_ID
    );
    expect(resolved).toMatchObject({
      kind: 'NOT_RECONCILABLE',
      reason: NOT_RECONCILABLE_REASONS.NOT_CAPTURING,
      currentStatus: 'COMPLETED',
    });
  });
});

/* ------------------------------------------------------------------ */
/* 10. Restart / durability                                            */
/* ------------------------------------------------------------------ */

describe('CP4. Restart durability', () => {
  test('CAPTURE_EXECUTING survives a reopen; duplicate claims stay rejected; reconciliation resolves', async () => {
    const { store, dbPath, storeDb } = makeFileBackedStore();
    driveToCaptureExecuting(store);
    storeDb.close();
    // Simulated process restart: reopen the same file-backed database.
    const reopenedDb = openStoreDb(dbPath);
    createdClosables.push(reopenedDb);
    const reopenedStore = new CommerceOperationStore({ db: reopenedDb.db });

    // The durable unresolved claim survived the restart.
    expect(reopenedStore.getOperation(OPERATION_ID)?.status).toBe('CAPTURE_EXECUTING');

    // A duplicate capture claim is still durably rejected (single-flight).
    expect(() =>
      reopenedStore.applyOperationEvent(OPERATION_ID, { type: 'CAPTURE_STARTED' }, T8)
    ).toThrow();

    // Reconciliation resolves from PayPal read state — without re-capture.
    const fake = new FakePayPalCaptureExecutor();
    fake.queueGetOrderSuccess(
      approvedOrderRead({ orderStatus: 'COMPLETED', captures: [completedCapture()] })
    );
    const outcome = await makeCaptureOrchestrator(reopenedStore, fake, makeClock([T8])).reconcileCapture(
      OPERATION_ID
    );
    expect(outcome.kind).toBe('RESOLVED_COMPLETED');
    expect(reopenedStore.getOperation(OPERATION_ID)?.status).toBe('COMPLETED');
    expect(fake.captureInputs).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* 11. Secret hygiene + boundary typing                                */
/* ------------------------------------------------------------------ */

describe('CP4. Secret hygiene and boundary typing', () => {
  test('outcome messages never contain secret-looking values from PayPal errors', async () => {
    const { store } = makeStore();
    driveToPayPalOrderCreated(store);
    const fake = new FakePayPalCaptureExecutor();
    fake.queueGetOrderSuccess();
    fake.queueCaptureError(
      new PayPalHttpApiError(
        'capture failed with Bearer abcdefghij123456 and access_token=supersecretvalue',
        { status: 500 }
      )
    );

    const outcome = await makeCaptureOrchestrator(store, fake).captureApprovedOrder(OPERATION_ID);

    expect(outcome.kind).toBe('CAPTURE_AMBIGUOUS');
    const message = (outcome as Extract<CaptureOutcome, { kind: 'CAPTURE_AMBIGUOUS' }>).message;
    expect(message).not.toContain('abcdefghij123456');
    expect(message).not.toContain('supersecretvalue');
    expect(message).toContain('[REDACTED]');
    // And nothing secret-shaped was persisted in the snapshot either.
    const snapshotRow = store
      .listOperations()
      .find((o) => o.id === OPERATION_ID);
    expect(snapshotRow?.paymentResult).toBeUndefined();
  });

  test('buyer-approval verification failure messages are sanitized too', async () => {
    const { store } = makeStore();
    driveToPayPalOrderCreated(store);
    const fake = new FakePayPalCaptureExecutor();
    fake.queueGetOrderError(
      new PayPalHttpApiError('read failed with client_secret=topsecretvalue')
    );

    const outcome = await makeCaptureOrchestrator(store, fake).captureApprovedOrder(OPERATION_ID);

    expect(outcome).toMatchObject({
      kind: 'NOT_CAPTURABLE',
      reason: NOT_CAPTURABLE_REASONS.APPROVAL_UNVERIFIED,
    });
    const message = (outcome as Extract<CaptureOutcome, { kind: 'NOT_CAPTURABLE' }>).message ?? '';
    expect(message).not.toContain('topsecretvalue');
    expect(message).toContain('[REDACTED]');
  });

  test('PayPalService structurally satisfies PayPalCaptureExecutor without credentials or network', () => {
    const service: PayPalCaptureExecutor = new PayPalService({
      config: {
        environment: 'SANDBOX',
        apiBaseUrl: 'https://paypal-mock.invalid',
        clientId: 'not-a-real-client-id',
        clientSecret: 'not-a-real-client-secret',
      },
    });
    expect(typeof service.captureOrder).toBe('function');
    expect(typeof service.getOrder).toBe('function');
  });
});
