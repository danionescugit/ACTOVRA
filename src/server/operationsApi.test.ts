import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCommercePilotComposition,
  getCommercePilotComposition,
  type CommercePilotComposition,
} from './composition';
import { POST as create, GET as list } from '../app/api/operations/route';
import { GET as get } from '../app/api/operations/[id]/route';
import { POST as approve } from '../app/api/operations/[id]/approve/route';
import { POST as execute } from '../app/api/operations/[id]/execute/route';

vi.mock('./composition', async importOriginal => ({
  ...await importOriginal<typeof import('./composition')>(),
  getCommercePilotComposition: vi.fn(),
}));

const approvalUrl = 'https://www.sandbox.paypal.com/checkoutnow?token=OFFLINE-ORDER';
const fetchGuard = vi.fn(() => { throw new Error('Network forbidden in CP3 tests'); });
let composition: CommercePilotComposition;
let directory: string;

function makeComposition() {
  const result = createCommercePilotComposition({
    appConfig: {
      dbPath: join(directory, 'operations.db'),
      publicBaseUrl: 'https://demo.example',
      paypalReturnUrl: 'https://demo.example/paypal/return',
      paypalCancelUrl: 'https://demo.example/paypal/cancel',
    },
    paypalConfig: {
      environment: 'SANDBOX',
      apiBaseUrl: 'https://paypal-offline.invalid',
      clientId: 'offline-client',
      clientSecret: 'offline-secret',
    },
  });
  vi.spyOn(result.paypal, 'createOrder').mockImplementation(async input => ({
    environment: 'SANDBOX',
    requestId: input.requestId,
    paypalOrderId: 'OFFLINE-ORDER',
    status: 'PAYER_ACTION_REQUIRED',
    approveUrl: approvalUrl,
  }));
  vi.mocked(getCommercePilotComposition).mockReturnValue(result);
  return result;
}

function request(payload?: unknown) {
  return new Request('https://demo.example/api/operations', {
    method: 'POST',
    ...(payload === undefined ? {} : {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  });
}

function context(id: string) { return { params: Promise.resolve({ id }) }; }

async function createDemo(opportunityId = 'opp-001') {
  const response = await create(request({ opportunityId }));
  expect(response.status).toBe(201);
  return response.json();
}

beforeEach(() => {
  fetchGuard.mockClear();
  vi.stubGlobal('fetch', fetchGuard);
  directory = mkdtempSync(join(tmpdir(), 'commercepilot-cp3-'));
  composition = makeComposition();
});

afterEach(() => {
  expect(fetchGuard).not.toHaveBeenCalled();
  composition.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(directory, { recursive: true, force: true });
});

describe('CP3 operation route adapters — offline', () => {
  it('creates through the sanctioned application use case, synthetic decision, policy and approval request', async () => {
    const useCase = vi.spyOn(composition.application, 'createOperationAwaitingApproval');
    const response = await create(request({ opportunityId: 'opp-001' }));
    const operation = await response.json();
    expect(response.status).toBe(201);
    expect(response.headers.get('Location')).toBe(`/api/operations/${operation.operationId}`);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(useCase).toHaveBeenCalledWith('opp-001');
    expect(operation).toMatchObject({
      opportunityId: 'opp-001',
      opportunity: { id: 'opp-001', title: 'Summer Promotion Discount' },
      status: 'AWAITING_HUMAN_APPROVAL',
      decision: { action: 'CREATE_PAYMENT', amount: 2500, currency: 'USD' },
      amount: 2500, currency: 'USD',
      justification: expect.any(String),
      policyResult: { decision: 'APPROVE' },
      approvalStatus: 'PENDING',
      paypalOrder: null, approvalUrl: null, paymentResult: null, nextAction: 'APPROVE',
    });
    expect(operation.auditTrail.map((entry: { eventType: string }) => entry.eventType)).toEqual([
      'DECISION_PROPOSED', 'POLICY_APPROVED', 'REQUEST_HUMAN_APPROVAL',
    ]);
    expect(composition.paypal.createOrder).not.toHaveBeenCalled();
  });

  it('preserves the escalated risk/policy result for the owner', async () => {
    const operation = await createDemo('opp-002');
    expect(operation).toMatchObject({
      status: 'AWAITING_HUMAN_APPROVAL', amount: 45000,
      policyResult: { decision: 'ESCALATE', reasonCode: 'AMOUNT_EXCEEDS_AUTOMATIC_MAX' },
    });
    expect(operation.auditTrail[1].eventType).toBe('POLICY_ESCALATED');
  });

  it('rejects unknown opportunities without creating durable state', async () => {
    const response = await create(request({ opportunityId: 'unknown' }));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: {
      code: 'UNKNOWN_OPPORTUNITY', message: 'Unknown synthetic opportunity.',
    } });
    expect(composition.application.listOperations()).toEqual([]);
    expect(composition.paypal.createOrder).not.toHaveBeenCalled();
  });

  it('GET returns state and ordered audit from a reopened durable database without internal objects', async () => {
    const operation = await createDemo();
    composition.close();
    composition = makeComposition();
    const response = await get(request(), context(operation.operationId));
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual(operation);
    expect(operation.auditTrail[0]).toEqual({
      sequence: 1, eventType: 'DECISION_PROPOSED', occurredAt: operation.createdAt,
    });
    expect(JSON.stringify(operation)).not.toMatch(/offline-secret|offline-client|operations\.db|rowId|event_json|requestId/);
  });

  it.each(['get', 'approve', 'execute'])('returns truthful 404 for missing operation: %s', async action => {
    const route = action === 'get' ? get : action === 'approve' ? approve : execute;
    const response = await route(request(), context('missing'));
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe('OPERATION_NOT_FOUND');
    expect(composition.paypal.createOrder).not.toHaveBeenCalled();
  });

  it('approves through HUMAN_APPROVED and GET immediately reflects durable state', async () => {
    const operation = await createDemo();
    const useCase = vi.spyOn(composition.application, 'approveOperation');
    const response = await approve(request({}), context(operation.operationId));
    expect(useCase).toHaveBeenCalledWith(operation.operationId);
    expect(response.status).toBe(200);
    const approved = await response.json();
    expect(approved).toMatchObject({ status: 'APPROVED', approvalStatus: 'APPROVED', nextAction: 'EXECUTE' });
    expect(approved.auditTrail.at(-1).eventType).toBe('HUMAN_APPROVED');
    const read = await get(request(), context(operation.operationId));
    expect(await read.json()).toEqual(approved);
    expect(composition.paypal.createOrder).not.toHaveBeenCalled();
  });

  it('rejects execution before human approval without claiming execution or calling the provider', async () => {
    const operation = await createDemo();
    const response = await execute(request(), context(operation.operationId));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: 'NOT_EXECUTABLE' }, operation: { status: 'AWAITING_HUMAN_APPROVAL' },
    });
    expect(composition.application.getAuditTrail(operation.operationId)).toHaveLength(3);
    expect(composition.paypal.createOrder).not.toHaveBeenCalled();
  });

  it('executes via the existing orchestrator and persists an actionable normalized approval URL across restart', async () => {
    const operation = await createDemo();
    await approve(request(), context(operation.operationId));
    const useCase = vi.spyOn(composition.application, 'executeOperation');
    const response = await execute(request(), context(operation.operationId));
    expect(useCase).toHaveBeenCalledWith(operation.operationId);
    expect(response.status).toBe(200);
    const executed = await response.json();
    expect(executed).toMatchObject({
      status: 'PAYPAL_ORDER_CREATED', approvalUrl,
      paypalOrder: { paypalOrderId: 'OFFLINE-ORDER', paypalStatus: 'PAYER_ACTION_REQUIRED' },
      paymentResult: null, nextAction: 'BUYER_APPROVAL',
    });
    expect(composition.paypal.createOrder).toHaveBeenCalledExactlyOnceWith({
      requestId: `commercepilot-op-${operation.operationId}`,
      amountMinorUnits: 2500, currency: 'USD', commerceOperationId: operation.operationId,
      returnUrl: 'https://demo.example/paypal/return', cancelUrl: 'https://demo.example/paypal/cancel',
    });
    expect(executed.auditTrail.slice(-2).map((entry: { eventType: string }) => entry.eventType))
      .toEqual(['EXECUTION_STARTED', 'PAYPAL_ORDER_CREATED']);
    composition.close();
    composition = makeComposition();
    const read = await get(request(), context(operation.operationId));
    expect(await read.json()).toEqual(executed);
  });

  it('repeated approval and concurrent/repeated execution preserve the durable claim and single provider call', async () => {
    const operation = await createDemo();
    await approve(request(), context(operation.operationId));
    expect((await approve(request(), context(operation.operationId))).status).toBe(409);
    const responses = await Promise.all([
      execute(request(), context(operation.operationId)), execute(request(), context(operation.operationId)),
    ]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
    expect((await execute(request(), context(operation.operationId))).status).toBe(409);
    expect((await approve(request(), context(operation.operationId))).status).toBe(409);
    expect(composition.paypal.createOrder).toHaveBeenCalledTimes(1);
    expect(composition.application.getAuditTrail(operation.operationId)).toHaveLength(6);
  });

  it('cannot approve or execute an operation rejected by the sanctioned application service', async () => {
    const operation = await createDemo();
    composition.application.rejectOperation(operation.operationId);
    expect((await approve(request(), context(operation.operationId))).status).toBe(409);
    expect((await execute(request(), context(operation.operationId))).status).toBe(409);
    expect(composition.application.getOperation(operation.operationId)?.status).toBe('REJECTED_BY_HUMAN');
    expect(composition.paypal.createOrder).not.toHaveBeenCalled();
  });

  it.each([
    {}, { opportunityId: '' }, { opportunityId: 1 }, null, [],
    { opportunityId: 'opp-001', decision: { amount: 1 } },
    { opportunityId: 'opp-001', event: { type: 'HUMAN_APPROVED' } },
    { opportunityId: 'opp-001', status: 'APPROVED' },
    { opportunityId: 'opp-001', policyResult: { decision: 'APPROVE' } },
    { opportunityId: 'opp-001', paymentResult: { success: true } },
  ])('rejects malformed or privileged create input: %j', async payload => {
    expect((await create(request(payload))).status).toBe(400);
    expect(composition.application.listOperations()).toEqual([]);
    expect(composition.paypal.createOrder).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON truthfully', async () => {
    const response = await create(new Request('https://demo.example/api/operations', { method: 'POST', body: '{' }));
    expect(response.status).toBe(400);
    expect(composition.application.listOperations()).toEqual([]);
  });

  it.each([
    { event: { type: 'PAYMENT_COMPLETED' } }, { approvalStatus: 'APPROVED' },
    { state: { status: 'COMPLETED' } }, { decision: { amount: 1 } },
    { policyResult: { decision: 'APPROVE' } }, { paymentResult: { success: true } },
    { paypalOrderId: 'BROWSER-ORDER', token: 'BROWSER-AUTHORIZATION' },
  ])('rejects injection into both action routes before invoking use cases: %j', async payload => {
    const operation = await createDemo();
    const approval = vi.spyOn(composition.application, 'approveOperation');
    const execution = vi.spyOn(composition.application, 'executeOperation');
    expect((await approve(request(payload), context(operation.operationId))).status).toBe(400);
    expect((await execute(request(payload), context(operation.operationId))).status).toBe(400);
    expect(approval).not.toHaveBeenCalled();
    expect(execution).not.toHaveBeenCalled();
    expect(composition.application.getAuditTrail(operation.operationId)).toHaveLength(3);
    expect(composition.paypal.createOrder).not.toHaveBeenCalled();
  });

  it('does not invent an approval URL when the provider supplies none', async () => {
    vi.mocked(composition.paypal.createOrder).mockImplementation(async input => ({
      environment: 'SANDBOX', requestId: input.requestId,
      paypalOrderId: 'OFFLINE-ORDER', status: 'CREATED',
    }));
    const operation = await createDemo();
    await approve(request(), context(operation.operationId));
    const response = await execute(request(), context(operation.operationId));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'PAYPAL_ORDER_CREATED', approvalUrl: null, nextAction: null });
  });

  it('reports failed execution without exposing provider error details or claiming payment success', async () => {
    vi.mocked(composition.paypal.createOrder).mockRejectedValue(new Error('private-provider-detail'));
    const operation = await createDemo();
    await approve(request(), context(operation.operationId));
    const response = await execute(request(), context(operation.operationId));
    expect(response.status).toBe(502);
    const output = await response.json();
    expect(output).toMatchObject({ error: { code: 'EXECUTION_FAILED' }, operation: { status: 'FAILED', paymentResult: { success: false } } });
    expect(JSON.stringify(output)).not.toContain('private-provider-detail');
    const read = await get(request(), context(operation.operationId));
    expect(await read.text()).not.toContain('private-provider-detail');
  });

  it('reports post-provider persistence failure without exposing unpersisted recovery data or retrying', async () => {
    const operation = await createDemo();
    await approve(request(), context(operation.operationId));
    const apply = composition.store.applyOperationEvent.bind(composition.store);
    vi.spyOn(composition.store, 'applyOperationEvent').mockImplementation((id, event, timestamp) => {
      if (event.type === 'PAYPAL_ORDER_CREATED') throw new Error('private-database-detail');
      return apply(id, event, timestamp);
    });
    const response = await execute(request(), context(operation.operationId));
    expect(response.status).toBe(500);
    const output = await response.json();
    expect(output).toMatchObject({ error: { code: 'PERSISTENCE_FAILED' }, operation: { status: 'EXECUTING', approvalUrl: null } });
    expect(JSON.stringify(output)).not.toMatch(/OFFLINE-ORDER|paypalResult|private-database-detail/);
    expect((await execute(request(), context(operation.operationId))).status).toBe(409);
    expect(composition.paypal.createOrder).toHaveBeenCalledTimes(1);
  });

  it('hides unexpected composition/configuration errors', async () => {
    vi.mocked(getCommercePilotComposition).mockImplementation(() => { throw new Error('secret-configuration-value'); });
    const response = await create(request({ opportunityId: 'opp-001' }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Operation could not be processed.' } });
  });

  it('GET /api/operations returns list of operations and synthetic opportunities', async () => {
    const listBefore = await list();
    expect(listBefore.status).toBe(200);
    const dataBefore = await listBefore.json();
    expect(dataBefore.operations).toEqual([]);
    expect(dataBefore.opportunities.length).toBe(3);

    const op = await createDemo();
    const listAfter = await list();
    expect(listAfter.status).toBe(200);
    const dataAfter = await listAfter.json();
    expect(dataAfter.operations.length).toBe(1);
    expect(dataAfter.operations[0].operationId).toBe(op.operationId);
  });
});
