import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCommercePilotComposition,
  getCommercePilotComposition,
  type CommercePilotComposition,
} from './composition';
import { POST as create } from '../app/api/operations/route';
import { GET as get } from '../app/api/operations/[id]/route';
import { POST as approve } from '../app/api/operations/[id]/approve/route';
import { POST as execute } from '../app/api/operations/[id]/execute/route';
import { GET as returned } from '../app/paypal/return/route';
import { GET as cancelled } from '../app/paypal/cancel/route';

vi.mock('./composition', async importOriginal => ({
  ...await importOriginal<typeof import('./composition')>(),
  getCommercePilotComposition: vi.fn(),
}));

const fetchGuard = vi.fn(() => { throw new Error('Network forbidden in offline CP4 tests'); });
let composition: CommercePilotComposition;
let directory: string;

function makeComposition() {
  const result = createCommercePilotComposition({
    appConfig: {
      dbPath: join(directory, 'operations.db'), publicBaseUrl: 'https://demo.example',
      paypalReturnUrl: 'https://demo.example/paypal/return',
      paypalCancelUrl: 'https://demo.example/paypal/cancel',
    },
    paypalConfig: {
      environment: 'SANDBOX', apiBaseUrl: 'https://paypal-offline.invalid',
      clientId: 'offline-client', clientSecret: 'offline-secret',
    },
  });
  vi.spyOn(result.paypal, 'createOrder').mockImplementation(async input => ({
    environment: 'SANDBOX', requestId: input.requestId,
    paypalOrderId: `ORDER-${input.commerceOperationId}`, status: 'PAYER_ACTION_REQUIRED',
    approveUrl: `https://www.sandbox.paypal.com/checkoutnow?token=ORDER-${input.commerceOperationId}`,
  }));
  vi.spyOn(result.paypal, 'getOrder').mockImplementation(async input => ({
    paypalOrderId: input.paypalOrderId, orderStatus: 'APPROVED', captures: [],
  }));
  vi.spyOn(result.paypal, 'captureOrder').mockImplementation(async input => ({
    environment: 'SANDBOX', requestId: input.requestId,
    paypalOrderId: input.paypalOrderId, orderStatus: 'COMPLETED',
    capture: { captureId: `CAPTURE-${input.paypalOrderId}`, status: 'COMPLETED', amountMinorUnits: 2500, currency: 'USD' },
  }));
  vi.mocked(getCommercePilotComposition).mockReturnValue(result);
  return result;
}

function context(id: string) { return { params: Promise.resolve({ id }) }; }
function post(payload?: unknown) {
  return new Request('https://demo.example/api/operations', {
    method: 'POST', ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
}
function callback(token?: string, extras: Record<string, string> = {}) {
  const url = new URL('https://demo.example/paypal/return');
  if (token !== undefined) url.searchParams.set('token', token);
  for (const [key, value] of Object.entries(extras)) url.searchParams.set(key, value);
  return new Request(url);
}
async function createOrder() {
  const created = await create(post({ opportunityId: 'opp-001' }));
  expect(created.status).toBe(201);
  const { operationId } = await created.json();
  expect((await approve(post(), context(operationId))).status).toBe(200);
  const executed = await execute(post(), context(operationId));
  expect(executed.status).toBe(200);
  return executed.json();
}

beforeEach(() => {
  fetchGuard.mockClear();
  vi.stubGlobal('fetch', fetchGuard);
  directory = mkdtempSync(join(tmpdir(), 'commercepilot-callback-'));
  composition = makeComposition();
});
afterEach(() => {
  expect(fetchGuard).not.toHaveBeenCalled();
  composition.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(directory, { recursive: true, force: true });
});

describe('PayPal callbacks — correlation only, offline', () => {
  it('unknown token cannot capture or mutate any operation', async () => {
    const operation = await createOrder();
    const response = await returned(callback('FABRICATED', { operationId: operation.operationId }));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: 'ORDER_NOT_FOUND' } });
    expect(composition.paypal.getOrder).not.toHaveBeenCalled();
    expect(composition.paypal.captureOrder).not.toHaveBeenCalled();
    expect(composition.application.getOperation(operation.operationId)?.status).toBe('PAYPAL_ORDER_CREATED');
  });

  it.each([undefined, '', ' ', 'x'.repeat(201)])('rejects absent/invalid token even with PayerID or forged results', async token => {
    const response = await returned(callback(token, { PayerID: 'FORGED-PAYER', paymentStatus: 'COMPLETED', approved: 'true' }));
    expect(response.status).toBe(400);
    expect(composition.paypal.getOrder).not.toHaveBeenCalled();
    expect(composition.paypal.captureOrder).not.toHaveBeenCalled();
  });

  it('rejects duplicate token parameters rather than selecting one', async () => {
    const operation = await createOrder();
    const url = new URL(callback(operation.paypalOrder.paypalOrderId).url);
    url.searchParams.append('token', 'FOREIGN-ORDER');
    expect((await returned(new Request(url))).status).toBe(400);
    expect((await cancelled(new Request(url))).status).toBe(400);
    expect(composition.paypal.getOrder).not.toHaveBeenCalled();
    expect(composition.paypal.captureOrder).not.toHaveBeenCalled();
  });

  it('correlates exactly the persisted order and ignores a foreign operation/order selector', async () => {
    const first = await createOrder();
    const foreign = await createOrder();
    const captureUseCase = vi.spyOn(composition.application, 'captureOperation');
    const response = await returned(callback(first.paypalOrder.paypalOrderId, {
      operationId: foreign.operationId, paypalOrderId: foreign.paypalOrder.paypalOrderId, PayerID: 'UNTRUSTED-PAYER',
    }));
    expect(response.status).toBe(303);
    expect(captureUseCase).toHaveBeenCalledExactlyOnceWith(first.operationId);
    expect(composition.paypal.getOrder).toHaveBeenCalledExactlyOnceWith({ paypalOrderId: first.paypalOrder.paypalOrderId });
    expect(composition.paypal.captureOrder).toHaveBeenCalledExactlyOnceWith({
      paypalOrderId: first.paypalOrder.paypalOrderId, requestId: `commercepilot-capture-${first.operationId}`,
    });
    expect(composition.application.getOperation(foreign.operationId)?.status).toBe('PAYPAL_ORDER_CREATED');
    expect(response.headers.get('Location')).toBe(`/?operation=${first.operationId}&paypal=returned`);
  });

  it.each(['CREATED', 'PAYER_ACTION_REQUIRED', 'VOIDED', 'COMPLETED'])('provider %s never authorizes a capture despite forged browser approval', async orderStatus => {
    const operation = await createOrder();
    vi.mocked(composition.paypal.getOrder).mockResolvedValue({
      paypalOrderId: operation.paypalOrder.paypalOrderId, orderStatus, captures: [],
    });
    const before = composition.application.getAuditTrail(operation.operationId);
    const response = await returned(callback(operation.paypalOrder.paypalOrderId, {
      PayerID: 'FAKE', status: 'APPROVED', paymentResult: '{"success":true}', policyResult: 'APPROVE',
      event: 'PAYMENT_COMPLETED', state: 'COMPLETED', approved: 'true',
    }));
    expect(response.status).toBe(303);
    expect(composition.paypal.getOrder).toHaveBeenCalledTimes(1);
    expect(composition.paypal.captureOrder).not.toHaveBeenCalled();
    expect(composition.application.getAuditTrail(operation.operationId)).toEqual(before);
    expect(composition.application.getOperation(operation.operationId)?.status).toBe('PAYPAL_ORDER_CREATED');
  });

  it('provider read failure or wrong returned order cannot authorize capture', async () => {
    const operation = await createOrder();
    vi.mocked(composition.paypal.getOrder).mockRejectedValueOnce(new Error('private-read-error'));
    expect((await returned(callback(operation.paypalOrder.paypalOrderId))).status).toBe(303);
    vi.mocked(composition.paypal.getOrder).mockResolvedValueOnce({ paypalOrderId: 'FOREIGN', orderStatus: 'APPROVED', captures: [] });
    expect((await returned(callback(operation.paypalOrder.paypalOrderId))).status).toBe(303);
    expect(composition.paypal.captureOrder).not.toHaveBeenCalled();
    expect(composition.application.getOperation(operation.operationId)?.status).toBe('PAYPAL_ORDER_CREATED');
  });

  it('real API chain reaches durable COMPLETED only after provider verification, with one capture and truthful audit/evidence', async () => {
    const operation = await createOrder();
    const response = await returned(callback(operation.paypalOrder.paypalOrderId));
    expect(response.status).toBe(303);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('Location')).toBe(`/?operation=${operation.operationId}&paypal=returned`);
    expect(response.headers.get('Location')).not.toMatch(/token|PayerID|captureId|COMPLETED/);
    const read = await get(post(), context(operation.operationId));
    const completed = await read.json();
    expect(completed).toMatchObject({
      status: 'COMPLETED', approvalStatus: 'APPROVED',
      paymentResult: {
        success: true, paypalOrderId: operation.paypalOrder.paypalOrderId,
        captureId: `CAPTURE-${operation.paypalOrder.paypalOrderId}`, amount: 2500, currency: 'USD',
      },
    });
    expect(completed.auditTrail.map((entry: { eventType: string }) => entry.eventType)).toEqual([
      'DECISION_PROPOSED', 'POLICY_APPROVED', 'REQUEST_HUMAN_APPROVAL', 'HUMAN_APPROVED',
      'EXECUTION_STARTED', 'PAYPAL_ORDER_CREATED', 'CAPTURE_STARTED', 'PAYMENT_COMPLETED',
    ]);
    expect(composition.paypal.getOrder).toHaveBeenCalledTimes(1);
    expect(vi.mocked(composition.paypal.getOrder).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(composition.paypal.captureOrder).mock.invocationCallOrder[0]);
    expect(composition.paypal.createOrder).toHaveBeenCalledTimes(1);
    expect(composition.paypal.captureOrder).toHaveBeenCalledTimes(1);
    composition.close();
    composition = makeComposition();
    expect(await (await get(post(), context(operation.operationId))).json()).toEqual(completed);
  });

  it('repeated/concurrent return and resolved operation cannot double-capture', async () => {
    const operation = await createOrder();
    const responses = await Promise.all([
      returned(callback(operation.paypalOrder.paypalOrderId)), returned(callback(operation.paypalOrder.paypalOrderId)),
    ]);
    expect(responses.map(r => r.status)).toEqual([303, 303]);
    const reads = vi.mocked(composition.paypal.getOrder).mock.calls.length;
    const before = composition.application.getAuditTrail(operation.operationId);
    expect((await returned(callback(operation.paypalOrder.paypalOrderId))).status).toBe(303);
    expect(composition.paypal.getOrder).toHaveBeenCalledTimes(reads);
    expect(composition.paypal.captureOrder).toHaveBeenCalledTimes(1);
    expect(composition.application.getAuditTrail(operation.operationId)).toEqual(before);
    expect(composition.application.getOperation(operation.operationId)?.status).toBe('COMPLETED');
  });

  it('ambiguous capture stops at CAPTURE_EXECUTING; returns never recapture or reconcile automatically', async () => {
    const operation = await createOrder();
    vi.mocked(composition.paypal.captureOrder).mockRejectedValue(new Error('private-ambiguous-error'));
    const reconcile = vi.spyOn(composition.application, 'reconcileOperation');
    const response = await returned(callback(operation.paypalOrder.paypalOrderId));
    expect(response.headers.get('Location')).toBe(`/?operation=${operation.operationId}&paypal=review-required`);
    expect(composition.application.getOperation(operation.operationId)?.status).toBe('CAPTURE_EXECUTING');
    expect((await returned(callback(operation.paypalOrder.paypalOrderId))).status).toBe(303);
    expect(composition.paypal.captureOrder).toHaveBeenCalledTimes(1);
    expect(composition.paypal.getOrder).toHaveBeenCalledTimes(1);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('cancel with token leaves durable state and audit untouched without provider calls', async () => {
    const operation = await createOrder();
    const before = await (await get(post(), context(operation.operationId))).json();
    const response = await cancelled(callback(operation.paypalOrder.paypalOrderId, { state: 'CANCELLED', event: 'PAYMENT_FAILED' }));
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe(`/?operation=${operation.operationId}&paypal=approval-not-completed`);
    expect(await (await get(post(), context(operation.operationId))).json()).toEqual(before);
    expect(composition.paypal.getOrder).not.toHaveBeenCalled();
    expect(composition.paypal.captureOrder).not.toHaveBeenCalled();
  });

  it('cancel without token needs no composition and only hands off information', async () => {
    vi.mocked(getCommercePilotComposition).mockImplementation(() => { throw new Error('must not construct'); });
    const response = await cancelled(callback(undefined, { PayerID: 'FAKE' }));
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('/?paypal=approval-not-completed');
    expect(composition.paypal.getOrder).not.toHaveBeenCalled();
    expect(composition.paypal.captureOrder).not.toHaveBeenCalled();
  });

  it('unknown cancel token does not select an operation or make provider calls', async () => {
    expect((await cancelled(callback('UNKNOWN'))).status).toBe(404);
    expect(composition.paypal.getOrder).not.toHaveBeenCalled();
    expect(composition.paypal.captureOrder).not.toHaveBeenCalled();
  });

  it('homepage handoff safely encodes the operation selector without forwarding callback fields', async () => {
    const operation = await createOrder();
    const persisted = composition.application.getOperation(operation.operationId)!;
    vi.spyOn(composition.application, 'findOperationByPayPalOrderId').mockReturnValue({ ...persisted, id: 'op /?&=#' });
    const response = await cancelled(callback(operation.paypalOrder.paypalOrderId, { PayerID: 'IGNORED' }));
    const target = new URL(response.headers.get('Location')!, 'https://demo.example');
    expect(target.pathname).toBe('/');
    expect(target.searchParams.get('operation')).toBe('op /?&=#');
    expect([...target.searchParams.keys()]).toEqual(['operation', 'paypal']);
    expect(composition.paypal.captureOrder).not.toHaveBeenCalled();
  });

  it('ambiguous persisted order correlation fails closed', async () => {
    const first = await createOrder();
    vi.mocked(composition.paypal.createOrder).mockImplementation(async input => ({
      environment: 'SANDBOX', requestId: input.requestId,
      paypalOrderId: first.paypalOrder.paypalOrderId, status: 'CREATED',
    }));
    await createOrder();
    expect(composition.application.findOperationByPayPalOrderId(first.paypalOrder.paypalOrderId)).toBeUndefined();
    expect(composition.application.findOperationByPayPalOrderId('')).toBeUndefined();
    expect((await returned(callback(first.paypalOrder.paypalOrderId))).status).toBe(404);
    expect(composition.paypal.getOrder).not.toHaveBeenCalled();
    expect(composition.paypal.captureOrder).not.toHaveBeenCalled();
  });

  it('unexpected application failure exposes no credentials, provider data or callback parameters', async () => {
    const operation = await createOrder();
    vi.spyOn(composition.application, 'captureOperation').mockRejectedValue(new Error('private-provider-configuration'));
    const response = await returned(callback(operation.paypalOrder.paypalOrderId, { PayerID: 'PRIVATE-PAYER' }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { code: 'CALLBACK_REVIEW_REQUIRED' } });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(composition.paypal.captureOrder).not.toHaveBeenCalled();
  });
});
