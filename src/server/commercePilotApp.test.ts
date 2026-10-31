import { afterEach, describe, expect, it } from 'vitest';
import { CommerceOperationStore } from '../store';
import { openStoreDb, type StoreDb, type SqliteDb } from '../store/db';
import type { CommerceOperation } from '../domain/schemas';
import {
  CommercePilotApplication,
  CommercePilotApplicationError,
} from './commercePilotApp';
import {
  SyntheticDecisionProposer,
  SyntheticDecisionProposerError,
  listSyntheticOpportunities,
  type DecisionProposer,
} from './syntheticDecisionProposer';

/* ------------------------------------------------------------------ */
/* Durable store helpers (same pattern as the orchestrator tests)      */
/* ------------------------------------------------------------------ */

const createdClosables: Array<{ close(): void }> = [];

function makeStore(): { store: CommerceOperationStore; db: SqliteDb } {
  const storeDb: StoreDb = openStoreDb(':memory:');
  createdClosables.push(storeDb);
  return { store: new CommerceOperationStore({ db: storeDb.db }), db: storeDb.db };
}

const T0 = new Date('2026-01-01T00:00:00.000Z');
const T1 = new Date('2026-01-01T00:01:00.000Z');

function makeClock(): () => Date {
  let i = 0;
  const times = [T0, T1];
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

/** Recording store wrapper: proves the application never applies raw events. */
class RecordingStore {
  readonly appliedEvents: Array<{ operationId: string; type: string }> = [];
  readonly created: string[] = [];
  constructor(readonly inner: CommerceOperationStore) {}
  createOperation(operationId: string, opportunityId: string, timestamp: Date): CommerceOperation {
    this.created.push(operationId);
    return this.inner.createOperation(operationId, opportunityId, timestamp);
  }
  applyOperationEvent(
    operationId: string,
    event: Parameters<CommerceOperationStore['applyOperationEvent']>[1],
    timestamp: Date
  ) {
    this.appliedEvents.push({ operationId, type: event.type });
    return this.inner.applyOperationEvent(operationId, event, timestamp);
  }
  getOperation(operationId: string): CommerceOperation | undefined {
    return this.inner.getOperation(operationId);
  }
  listOperations(): CommerceOperation[] {
    return this.inner.listOperations();
  }
  getAuditTrail(operationId: string) {
    return this.inner.getAuditTrail(operationId);
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
});

describe('SyntheticDecisionProposer (E1)', () => {
  it('proposes the deterministic decision for every known opportunity', async () => {
    const proposer = new SyntheticDecisionProposer();
    const d1 = await proposer.proposeDecision('opp-001');
    expect(d1).toEqual({
      opportunityId: 'opp-001',
      action: 'CREATE_PAYMENT',
      amount: 2500,
      currency: 'USD',
      recipient: 'customer-demo-001',
      justification: expect.any(String) as string,
    });
    // Deterministic: same input, same output.
    expect(await proposer.proposeDecision('opp-001')).toEqual(d1);
    // All catalog opportunities produce decisions.
    for (const opp of listSyntheticOpportunities()) {
      await expect(proposer.proposeDecision(opp.id)).resolves.toMatchObject({
        opportunityId: opp.id,
      });
    }
  });

  it('throws SyntheticDecisionProposerError for unknown or empty opportunity IDs', async () => {
    const proposer = new SyntheticDecisionProposer();
    await expect(proposer.proposeDecision('opp-999')).rejects.toBeInstanceOf(
      SyntheticDecisionProposerError
    );
    await expect(proposer.proposeDecision('')).rejects.toBeInstanceOf(
      SyntheticDecisionProposerError
    );
    await expect(proposer.proposeDecision('   ')).rejects.toBeInstanceOf(
      SyntheticDecisionProposerError
    );
  });
});

describe('createOperationAwaitingApproval — happy path (E2)', () => {
  it('creates the exact audit sequence DECISION_PROPOSED → POLICY_APPROVED → REQUEST_HUMAN_APPROVAL', async () => {
    const { store, db } = makeStore();
    const app = new CommercePilotApplication({
      store,
      now: makeClock(),
      generateOperationId: () => 'op-e2-1',
    });

    const outcome = await app.createOperationAwaitingApproval('opp-001');

    expect(outcome).toEqual({
      kind: 'AWAITING_HUMAN_APPROVAL',
      operationId: 'op-e2-1',
      decision: {
        opportunityId: 'opp-001',
        action: 'CREATE_PAYMENT',
        amount: 2500,
        currency: 'USD',
        recipient: 'customer-demo-001',
        justification: expect.any(String) as string,
      },
      policyDecision: 'APPROVE',
    });

    expect(rawAuditEventTypes(db, 'op-e2-1')).toEqual([
      'DECISION_PROPOSED',
      'POLICY_APPROVED',
      'REQUEST_HUMAN_APPROVAL',
    ]);
    const operation = store.getOperation('op-e2-1');
    expect(operation?.status).toBe('AWAITING_HUMAN_APPROVAL');
    expect(operation?.decision).toEqual(outcome.decision);
    expect(operation?.policyResult?.decision).toBe('APPROVE');
  });

  it('generates unique op-<uuid> operation IDs when no generator is injected', async () => {
    const { store } = makeStore();
    const app = new CommercePilotApplication({ store });

    const first = await app.createOperationAwaitingApproval('opp-001');
    const second = await app.createOperationAwaitingApproval('opp-003');

    expect(first.operationId).toMatch(/^op-[0-9a-f-]{36}$/);
    expect(second.operationId).toMatch(/^op-[0-9a-f-]{36}$/);
    expect(first.operationId).not.toBe(second.operationId);
    expect(store.listOperations().length).toBe(2);
  });

  it('ESCALATION path (opp-002: $450 > $50 automatic max): POLICY_ESCALATED → REQUEST_HUMAN_APPROVAL', async () => {
    const { store, db } = makeStore();
    const app = new CommercePilotApplication({
      store,
      generateOperationId: () => 'op-e2-esc',
    });

    const outcome = await app.createOperationAwaitingApproval('opp-002');

    expect(outcome.kind).toBe('AWAITING_HUMAN_APPROVAL');
    if (outcome.kind === 'AWAITING_HUMAN_APPROVAL') {
      expect(outcome.policyDecision).toBe('ESCALATE');
    }
    expect(rawAuditEventTypes(db, 'op-e2-esc')).toEqual([
      'DECISION_PROPOSED',
      'POLICY_ESCALATED',
      'REQUEST_HUMAN_APPROVAL',
    ]);
    expect(store.getOperation('op-e2-esc')?.status).toBe('AWAITING_HUMAN_APPROVAL');
  });

  it('policy-REJECT path applies NO REQUEST_HUMAN_APPROVAL (terminal)', async () => {
    const { store, db } = makeStore();
    const app = new CommercePilotApplication({
      store,
      generateOperationId: () => 'op-e2-rej',
      // Custom proposer proposing an out-of-policy decision (GBP not allowed).
      decisionProposer: {
        proposeDecision: async (opportunityId: string) => ({
          opportunityId,
          action: 'CREATE_PAYMENT',
          amount: 2500,
          currency: 'GBP',
          recipient: 'customer-demo-001',
          justification: 'Out-of-policy currency proposal',
        }),
      },
    });

    const outcome = await app.createOperationAwaitingApproval('opp-001');

    expect(outcome).toEqual({
      kind: 'POLICY_REJECTED',
      operationId: 'op-e2-rej',
      decision: expect.objectContaining({ currency: 'GBP' }) as never,
    });
    expect(rawAuditEventTypes(db, 'op-e2-rej')).toEqual([
      'DECISION_PROPOSED',
      'POLICY_REJECTED',
    ]);
    expect(store.getOperation('op-e2-rej')?.status).toBe('POLICY_REJECTED');
  });

  it('unknown opportunity → SyntheticDecisionProposerError and NO durable state created', async () => {
    const { store, db } = makeStore();
    const app = new CommercePilotApplication({ store });

    await expect(app.createOperationAwaitingApproval('opp-404')).rejects.toBeInstanceOf(
      SyntheticDecisionProposerError
    );
    expect(store.listOperations().length).toBe(0);
    // Nothing was written at all.
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM commerce_operations;').get()
    ).toEqual({ n: 0 });
  });

  it('wraps unexpected proposer failures in CommercePilotApplicationError (no raw crash)', async () => {
    const { store } = makeStore();
    const app = new CommercePilotApplication({
      store,
      decisionProposer: {
        proposeDecision: async () => {
          throw new Error('LLM exploded');
        },
      },
    });
    await expect(app.createOperationAwaitingApproval('opp-001')).rejects.toBeInstanceOf(
      CommercePilotApplicationError
    );
  });
});

describe('human approval use cases (E3)', () => {
  async function createAwaitingOperation(
    store: CommerceOperationStore,
    operationId: string
  ): Promise<void> {
    const app = new CommercePilotApplication({
      store,
      generateOperationId: () => operationId,
    });
    await app.createOperationAwaitingApproval('opp-001');
  }

  it('approveOperation applies HUMAN_APPROVED exactly once → APPROVED', async () => {
    const { store, db } = makeStore();
    const app = new CommercePilotApplication({ store });
    await createAwaitingOperation(store, 'op-e3-1');

    const outcome = app.approveOperation('op-e3-1');
    expect(outcome).toEqual({ kind: 'APPROVED', operationId: 'op-e3-1' });

    expect(store.getOperation('op-e3-1')?.status).toBe('APPROVED');
    expect(rawAuditEventTypes(db, 'op-e3-1')).toEqual([
      'DECISION_PROPOSED',
      'POLICY_APPROVED',
      'REQUEST_HUMAN_APPROVAL',
      'HUMAN_APPROVED',
    ]);
  });

  it('rejectOperation applies HUMAN_REJECTED exactly once → REJECTED_BY_HUMAN', async () => {
    const { store, db } = makeStore();
    const app = new CommercePilotApplication({ store });
    await createAwaitingOperation(store, 'op-e3-2');

    const outcome = app.rejectOperation('op-e3-2');
    expect(outcome).toEqual({ kind: 'REJECTED', operationId: 'op-e3-2' });

    expect(store.getOperation('op-e3-2')?.status).toBe('REJECTED_BY_HUMAN');
    expect(rawAuditEventTypes(db, 'op-e3-2')).toEqual([
      'DECISION_PROPOSED',
      'POLICY_APPROVED',
      'REQUEST_HUMAN_APPROVAL',
      'HUMAN_REJECTED',
    ]);
  });

  it('illegal approval attempts surface the state-machine refusal (no special-casing)', async () => {
    const { store } = makeStore();
    const app = new CommercePilotApplication({ store });
    await createAwaitingOperation(store, 'op-e3-3');
    app.approveOperation('op-e3-3'); // now APPROVED

    // A second HUMAN_APPROVED is not a legal transition; the store/state
    // machine refuses it. The application does NOT bypass the guard.
    await expect(
      Promise.resolve().then(() => app.approveOperation('op-e3-3'))
    ).rejects.toThrow();
  });
});

describe('execution/capture delegation use cases (E4)', () => {
  it('executeOperation delegates to the injected execution orchestrator', async () => {
    const { store } = makeStore();
    const calls: string[] = [];
    const app = new CommercePilotApplication({
      store,
      execution: {
        executeApprovedOperation: async (operationId: string) => {
          calls.push(operationId);
          return {
            kind: 'ORDER_CREATED',
            operationId,
            paypalOrder: {
              paypalOrderId: 'PAYPAL-1',
              paypalStatus: 'CREATED',
              requestId: 'commercepilot-op-op-1',
            },
          };
        },
      },
    });

    const outcome = await app.executeOperation('op-e4-1');
    expect(outcome.kind).toBe('ORDER_CREATED');
    expect(calls).toEqual(['op-e4-1']);
  });

  it('executeOperation without an orchestrator fails with a clear configuration error', async () => {
    const { store } = makeStore();
    const app = new CommercePilotApplication({ store });
    await expect(app.executeOperation('op-e4-2')).rejects.toThrow(
      /no execution orchestrator was provided/
    );
  });

  it('captureOperation and reconcileOperation delegate to the capture orchestrator', async () => {
    const { store } = makeStore();
    const captured: string[] = [];
    const reconciled: string[] = [];
    const app = new CommercePilotApplication({
      store,
      capture: {
        captureApprovedOrder: async (operationId: string) => {
          captured.push(operationId);
          return { kind: 'CAPTURE_COMPLETED', operationId } as never;
        },
        reconcileCapture: async (operationId: string) => {
          reconciled.push(operationId);
          return { kind: 'RESOLVED_COMPLETED', operationId } as never;
        },
      },
    });

    await app.captureOperation('op-e4-3');
    await app.reconcileOperation('op-e4-4');
    expect(captured).toEqual(['op-e4-3']);
    expect(reconciled).toEqual(['op-e4-4']);
  });

  it('capture/reconcile without an orchestrator fail with clear configuration errors', async () => {
    const { store } = makeStore();
    const app = new CommercePilotApplication({ store });
    await expect(app.captureOperation('op-e4-5')).rejects.toThrow(
      /no capture orchestrator was provided/
    );
    await expect(app.reconcileOperation('op-e4-5')).rejects.toThrow(
      /no capture orchestrator was provided/
    );
  });
});

describe('application boundary invariant (E5): routes must not apply arbitrary domain events', () => {
  it('only use-case-owned event types are ever applied by the application', async () => {
    const { store } = makeStore();
    const recording = new RecordingStore(store);
    const app = new CommercePilotApplication({
      store: recording,
      generateOperationId: () => 'op-e5-1',
    });

    await app.createOperationAwaitingApproval('opp-001');
    app.approveOperation('op-e5-1');

    // The full owned sequence for create+approve, nothing else.
    expect(recording.appliedEvents.map((e) => e.type)).toEqual([
      'DECISION_PROPOSED',
      'POLICY_APPROVED',
      'REQUEST_HUMAN_APPROVAL',
      'HUMAN_APPROVED',
    ]);
    expect(recording.created).toEqual(['op-e5-1']);
  });

  it('the application exposes NO method that accepts an arbitrary domain event', () => {
    const { store } = makeStore();
    const app = new CommercePilotApplication({ store });
    const prototype = Object.getPrototypeOf(app) as Record<string, unknown>;
    const methodNames = Object.getOwnPropertyNames(prototype).filter(
      (name) => typeof prototype[name] === 'function' && name !== 'constructor'
    );
    expect(methodNames.sort()).toEqual([
      'approveOperation',
      'captureOperation',
      'createOperationAwaitingApproval',
      'executeOperation',
      'findOperationByPayPalOrderId',
      'getAuditTrail',
      'getOperation',
      'listOperations',
      'reconcileOperation',
      'rejectOperation',
    ]);
    // No applyEvent / applyOperationEvent / handleEvent surface exists.
    expect(
      methodNames.some((name) =>
        /apply|event/i.test(name) && name !== 'getAuditTrail'
      )
    ).toBe(false);
  });

  it('read methods are pass-throughs to the store (no reshaping, no caching)', async () => {
    const { store } = makeStore();
    const app = new CommercePilotApplication({
      store,
      generateOperationId: () => 'op-e5-2',
    });
    const { operationId } = await app.createOperationAwaitingApproval('opp-003');

    const direct = store.getOperation(operationId);
    expect(app.getOperation(operationId)).toEqual(direct);
    expect(app.listOperations()).toEqual(store.listOperations());
    expect(app.getAuditTrail(operationId)).toEqual(store.getAuditTrail(operationId));
    expect(app.getOperation('missing')).toBeUndefined();
  });
});

describe('DecisionProposer interface compatibility (E6)', () => {
  it('accepts any DecisionProposer-shaped collaborator (structural typing)', async () => {
    const { store } = makeStore();
    const proposer: DecisionProposer = {
      proposeDecision: async (opportunityId: string) => ({
        opportunityId,
        action: 'CREATE_PAYMENT',
        amount: 1000,
        currency: 'USD',
        recipient: 'customer-demo-001',
        justification: 'Structurally-typed custom proposer',
      }),
    };
    const app = new CommercePilotApplication({
      store,
      decisionProposer: proposer,
      generateOperationId: () => 'op-e6-1',
    });
    const outcome = await app.createOperationAwaitingApproval('opp-001');
    expect(outcome.kind).toBe('AWAITING_HUMAN_APPROVAL');
    expect(store.getOperation('op-e6-1')?.decision?.amount).toBe(1000);
  });
});
