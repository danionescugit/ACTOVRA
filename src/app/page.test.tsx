// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import Home from './page';

function operation(overrides: Record<string, unknown> = {}) {
  return {
    operationId: 'op-real-123', opportunityId: 'opp-001', status: 'APPROVED',
    opportunity: { id: 'opp-001', title: 'Test opportunity' },
    decision: { opportunityId: 'opp-001', action: 'CREATE_PAYMENT', amount: 2500, currency: 'USD', recipient: 'demo', justification: 'Test' },
    amount: 2500, currency: 'USD', justification: 'Test',
    policyResult: { decision: 'APPROVE', reason: 'Test policy' }, approvalStatus: 'APPROVED',
    paypalOrder: null, approvalUrl: null, paymentResult: null,
    auditTrail: [{ sequence: 1, eventType: 'HUMAN_APPROVED', occurredAt: '2026-10-30T10:00:00.000Z' }],
    createdAt: '2026-10-30T10:00:00.000Z', updatedAt: '2026-10-30T10:00:00.000Z', nextAction: 'EXECUTE',
    ...overrides,
  };
}

const approvalUrl = 'https://www.sandbox.paypal.com/checkoutnow?token=OFFLINE-ORDER';
const createdOrder = () => operation({
  status: 'PAYPAL_ORDER_CREATED', nextAction: 'BUYER_APPROVAL', approvalUrl,
  paypalOrder: { paypalOrderId: 'OFFLINE-ORDER', paypalStatus: 'PAYER_ACTION_REQUIRED' },
});

let persisted: ReturnType<typeof operation>[];
let execute: ReturnType<typeof vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>>;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  window.history.replaceState(null, '', '/?tab=operations');
  sessionStorage.clear();
  persisted = [operation()];
  execute = vi.fn(async () => Response.json(createdOrder()));
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (input === '/api/operations' && (!init?.method || init.method === 'GET')) {
      return Response.json({ operations: persisted });
    }
    if (typeof input === 'string' && input.startsWith('/api/operations/') && input.endsWith('/execute') && init?.method === 'POST') {
      return execute(input, init);
    }
    throw new Error('Unexpected request: all UI test traffic must use local mocked operation APIs');
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  for (const [input] of fetchMock.mock.calls) expect(String(input)).toMatch(/^\/api\/operations(?:\/|$)/);
  vi.unstubAllGlobals();
});

async function renderApproved() {
  render(<Home />);
  const button = await screen.findByRole('button', { name: 'Execute with PayPal Sandbox' });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  return button;
}

describe('PayPal Sandbox UI — real React rendering, mocked local APIs only', () => {
  it('header renders Policy Guard Active and omits PayPal AI Hackathon', async () => {
    render(<Home />);
    await screen.findByText('Policy Guard Active');
    expect(screen.queryByText('PayPal AI Hackathon')).toBeNull();
    expect(screen.queryByText('Deterministic Policy Gate Active')).toBeNull();
  });

  it('APPROVED displays explicit Execute without executing on mount, rerender or reload', async () => {
    const view = render(<Home />);
    await screen.findByRole('button', { name: 'Execute with PayPal Sandbox' });
    view.rerender(<Home />);
    view.unmount();
    render(<Home />);
    await screen.findByRole('button', { name: 'Execute with PayPal Sandbox' });
    expect(execute).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
  });

  it('explicit execution POST uses the real operationId, updates state and offers the exact backend approvalUrl', async () => {
    persisted = [operation({ operationId: 'op-real/with space' })];
    execute.mockResolvedValue(Response.json(createdOrderWithId('op-real/with space')));
    fireEvent.click(await renderApproved());
    const links = await screen.findAllByRole('link', { name: 'Continue to PayPal Sandbox' });
    expect(links.length).toBeGreaterThanOrEqual(1);
    for (const link of links) {
      expect(link.getAttribute('href')).toBe(approvalUrl);
    }
    expect(execute).toHaveBeenCalledExactlyOnceWith('/api/operations/op-real%2Fwith%20space/execute', expect.objectContaining({ method: 'POST', body: '{}' }));
    expect(screen.queryByRole('button', { name: 'Execute with PayPal Sandbox' })).toBeNull();
    expect(screen.getByText(/payment is not yet confirmed/)).toBeTruthy();
  });

  it('PAYPAL_ORDER_CREATED + approvalUrl renders the visible CTA in the success notification banner', async () => {
    execute.mockResolvedValue(Response.json(createdOrder()));
    fireEvent.click(await renderApproved());
    const banner = await screen.findByRole('status');
    expect(banner.textContent).toContain('PayPal order created. Continue to PayPal Sandbox to approve the payment.');
    const bannerLink = within(banner).getByRole('link', { name: 'Continue to PayPal Sandbox' });
    expect(bannerLink.getAttribute('href')).toBe(approvalUrl);
    expect(bannerLink.getAttribute('referrerPolicy')).toBe('no-referrer');
  });

  it('no approvalUrl means no fake/constructed PayPal link in notification or controls', async () => {
    const noLinkOrder = createdOrder();
    noLinkOrder.approvalUrl = null;
    execute.mockResolvedValue(Response.json(noLinkOrder));
    fireEvent.click(await renderApproved());
    await screen.findAllByText(/a valid PayPal Sandbox approval link is unavailable/i);
    expect(screen.queryByRole('link', { name: 'Continue to PayPal Sandbox' })).toBeNull();
  });

  it('Execute cannot be accidentally repeated after PAYPAL_ORDER_CREATED', async () => {
    execute.mockResolvedValue(Response.json(createdOrder()));
    fireEvent.click(await renderApproved());
    await screen.findAllByRole('link', { name: 'Continue to PayPal Sandbox' });
    expect(screen.queryByRole('button', { name: 'Execute with PayPal Sandbox' })).toBeNull();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('blocks synchronous double-submit and displays loading', async () => {
    let finish!: (response: Response) => void;
    execute.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const button = await renderApproved();
    act(() => { fireEvent.click(button); fireEvent.click(button); });
    expect(execute).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('button', { name: 'Creating PayPal order...' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish(Response.json(createdOrder())));
    await screen.findAllByRole('link', { name: 'Continue to PayPal Sandbox' });
  });

  it('handles 409 by rereading persistent state without another POST', async () => {
    execute.mockImplementation(async () => {
      persisted = [createdOrder()];
      return Response.json({ error: { code: 'NOT_EXECUTABLE' }, operation: persisted[0] }, { status: 409 });
    });
    fireEvent.click(await renderApproved());
    await screen.findByText(/Execution was not accepted.*409/);
    await screen.findAllByRole('link', { name: 'Continue to PayPal Sandbox' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/operations')).toHaveLength(2);
  });

  it.each([500, 502, 503])('handles HTTP %s without retry, including refresh and remount', async status => {
    execute.mockResolvedValue(Response.json({ error: { code: 'INTERNAL_ERROR' } }, { status }));
    fireEvent.click(await renderApproved());
    await screen.findByText(/Execution could not be confirmed/);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url === '/api/operations').length).toBe(3));
    expect((screen.getByRole('button', { name: 'Execute with PayPal Sandbox' }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    render(<Home />);
    const button = await screen.findByRole('button', { name: 'Execute with PayPal Sandbox' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('network error refreshes truthful state and never retries execution', async () => {
    execute.mockImplementation(async () => {
      persisted = [operation({ status: 'EXECUTING', nextAction: null })];
      throw new TypeError('Offline transport failure');
    });
    fireEvent.click(await renderApproved());
    await screen.findByText(/Execution response is unknown/);
    await screen.findByText('Persistent state: EXECUTING');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Execute with PayPal Sandbox' })).toBeNull();
  });

  it('malformed success is ambiguous and cannot trigger an execution retry', async () => {
    execute.mockResolvedValue(new Response('not-json', { status: 200 }));
    fireEvent.click(await renderApproved());
    await screen.findByText(/Execution response is unknown/);
    expect((screen.getByRole('button', { name: 'Execute with PayPal Sandbox' }) as HTMLButtonElement).disabled).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('reload in PAYPAL_ORDER_CREATED restores buyer approval without executing', async () => {
    persisted = [createdOrder()];
    render(<Home />);
    expect((await screen.findByRole('link', { name: 'Continue to PayPal Sandbox' })).getAttribute('href')).toBe(approvalUrl);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    'http://www.sandbox.paypal.com/checkoutnow',
    'https://www.paypal.com/checkoutnow',
    'https://www.sandbox.paypal.com.evil.invalid/checkoutnow',
    'https://name:password@www.sandbox.paypal.com/checkoutnow',
    'https://www.sandbox.paypal.com:444/checkoutnow',
    'javascript:alert(1)', '/checkoutnow', null,
  ])('never navigates to invalid/non-Sandbox approvalUrl %s', async url => {
    persisted = [operation({ status: 'PAYPAL_ORDER_CREATED', nextAction: 'BUYER_APPROVAL', approvalUrl: url })];
    render(<Home />);
    await screen.findByText(/A valid PayPal Sandbox approval link is unavailable/);
    expect(screen.queryByRole('link', { name: 'Continue to PayPal Sandbox' })).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it('homepage return selects exact persistent operation even when another operation has the same opportunity', async () => {
    persisted = [operation({ operationId: 'op-other' }), operation({
      operationId: 'op-returned', status: 'COMPLETED', nextAction: null,
      paymentResult: { success: true, captureId: 'CAPTURE-OFFLINE', amount: 2500, currency: 'USD' },
    })];
    window.history.replaceState(null, '', '/?operation=op-returned&paypal=returned');
    render(<Home />);
    await screen.findByText('Payment completed successfully.');
    expect(screen.getByText('op-returned')).toBeTruthy();
    expect(screen.getByText('Persistent state: COMPLETED')).toBeTruthy();
    expect(screen.getByText('Capture: CAPTURE-OFFLINE')).toBeTruthy();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['FAILED', 'CAPTURE_EXECUTING', 'EXECUTING'])('return parameters never turn persistent %s into success', async status => {
    persisted = [operation({ status, nextAction: 'EXECUTE' })];
    window.history.replaceState(null, '', '/?operation=op-real-123&paypal=returned&status=COMPLETED&success=true');
    render(<Home />);
    await screen.findByText(`Persistent state: ${status}`);
    expect(screen.queryByText('Payment completed successfully.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Execute with PayPal Sandbox' })).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it('missing returned operation is reported instead of claiming success', async () => {
    window.history.replaceState(null, '', '/?operation=op-missing&paypal=returned');
    render(<Home />);
    await screen.findByText(/The returned operation was not found/);
    expect(screen.queryByText('Payment completed successfully.')).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it('manual GET refresh recovers a failed return-page read and selects the returned opportunity', async () => {
    persisted = [operation({ opportunityId: 'opp-003', status: 'COMPLETED', nextAction: null })];
    window.history.replaceState(null, '', '/?operation=op-real-123&paypal=returned');
    fetchMock.mockRejectedValueOnce(new TypeError('Initial read unavailable'));
    render(<Home />);
    await screen.findByText(/Could not load persistent operations/);
    expect((screen.getByRole('button', { name: /Analyze with AI/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
    await screen.findByText('Payment completed successfully.');
    expect(screen.getByText('op-real-123')).toBeTruthy();
    expect(execute).not.toHaveBeenCalled();
  });

  it('renders ACTOVRA branding, tagline, and descriptor correctly', async () => {
    persisted = [];
    window.history.replaceState(null, '', '/?tab=operations');
    render(<Home />);
    expect(await screen.findByRole('heading', { level: 1, name: 'ACTOVRA' })).toBeTruthy();
    expect(screen.getByText(/Where AI decisions become controlled actions/)).toBeTruthy();
    expect(screen.getByText(/Controlled execution for AI-driven commerce/)).toBeTruthy();
  });

  it('displays human-friendly Create payment label and demoted Refresh status button', async () => {
    persisted = [operation({
      operationId: 'op-returned',
      status: 'COMPLETED',
      nextAction: null,
      paymentResult: { success: true, captureId: 'CAPTURE-OFFLINE', amount: 2500, currency: 'USD' },
    })];
    window.history.replaceState(null, '', '/?operation=op-returned&paypal=returned');
    render(<Home />);
    await screen.findByText('Payment completed successfully.');
    expect(screen.getAllByText('Create payment').length).toBeGreaterThan(0);
    const refreshBtn = screen.getByRole('button', { name: 'Refresh status' });
    expect(refreshBtn.className).toContain('btnSecondary');
    expect(refreshBtn.className).not.toContain('btnPrimary');
    expect(screen.getByText(/PayPal payment completed successfully/)).toBeTruthy();
  });

  it('renders AI-generated proposal badge when provenance is REAL_AI', async () => {
    persisted = [operation({
      operationId: 'op-real-ai',
      status: 'AWAITING_HUMAN_APPROVAL',
      decision: {
        opportunityId: 'opp-001',
        action: 'CREATE_PAYMENT',
        amount: 2500,
        currency: 'USD',
        recipient: 'customer-demo-001',
        justification: 'Real model proposed incentive',
        provenance: 'REAL_AI',
      },
    })];
    window.history.replaceState(null, '', '/?operation=op-real-ai');
    render(<Home />);
    expect(await screen.findByText('AI-generated proposal')).toBeTruthy();
    expect(screen.getByText('NVIDIA Nemotron (Real AI)')).toBeTruthy();
  });

  it('renders Demo fallback proposal badge when provenance is SYNTHETIC_FALLBACK', async () => {
    persisted = [operation({
      operationId: 'op-fallback',
      status: 'AWAITING_HUMAN_APPROVAL',
      decision: {
        opportunityId: 'opp-001',
        action: 'CREATE_PAYMENT',
        amount: 2500,
        currency: 'USD',
        recipient: 'customer-demo-001',
        justification: 'Synthetic fallback proposal',
        provenance: 'SYNTHETIC_FALLBACK',
      },
    })];
    window.history.replaceState(null, '', '/?operation=op-fallback');
    render(<Home />);
    expect(await screen.findByText('Demo fallback proposal')).toBeTruthy();
    expect(screen.getByText('Deterministic Demo Fallback')).toBeTruthy();
  });
});

function createdOrderWithId(id: string) { return { ...createdOrder(), operationId: id }; }
