import { describe, it, expect, vi } from 'vitest';
import { PayPalPayoutsService } from './paypalPayoutsService';
import { PayoutSafetyViolationError } from './paypalPayoutsTypes';
import { type PayPalConfig } from '../services/paypal/config';
import { PayPalService } from '../services/paypal';
import { classifyPayoutPopulation, aggregatePayoutBatch } from './calculationEngine';
import { generateSyntheticPayoutPopulation } from './syntheticData';

const validSandboxConfig: PayPalConfig = {
  environment: 'SANDBOX',
  apiBaseUrl: 'https://api-m.sandbox.paypal.com',
  clientId: 'fake-sandbox-client-id',
  clientSecret: 'fake-sandbox-client-secret',
};

const fakeOAuthTokenResponse = {
  access_token: 'fake-access-token-12345',
  scope: 'https://uri.paypal.com/payments/payouts https://uri.paypal.com/services/payments/payment/authcapture',
  token_type: 'Bearer',
  expires_in: 32400,
};

function createMockFetch(payoutResponse: Record<string, unknown>, batchGetResponse?: Record<string, unknown>) {
  return vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
    if (input.includes('/v1/oauth2/token')) {
      return new Response(JSON.stringify(fakeOAuthTokenResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (input.includes('/v1/payments/payouts/') && init?.method === 'GET') {
      return new Response(JSON.stringify(batchGetResponse || payoutResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'paypal-debug-id': 'mock-debug-id-get' },
      });
    }
    if (input.endsWith('/v1/payments/payouts') && init?.method === 'POST') {
      return new Response(JSON.stringify(payoutResponse), {
        status: 201,
        headers: { 'Content-Type': 'application/json', 'paypal-debug-id': 'mock-debug-id-post' },
      });
    }
    return new Response('Not found', { status: 404 });
  });
}

describe('PAYOUT-06: PayPalPayoutsService Unit Tests & Safety Guards', () => {
  const validTwoItemInput = {
    senderBatchId: 'ACTOVRA-SANDBOX-PROOF-TEST-001',
    items: [
      {
        senderItemId: 'PROOF-ITEM-1',
        receiverEmail: 'sb-test-1@personal.example.com',
        amountCents: 100,
        currency: 'USD' as const,
      },
      {
        senderItemId: 'PROOF-ITEM-2',
        receiverEmail: 'sb-test-2@personal.example.com',
        amountCents: 100,
        currency: 'USD' as const,
      },
    ],
  };

  // 1. Production hostname rejected
  it('1. rejects production hostname or environment with hard safety violation error', async () => {
    const prodConfig: PayPalConfig = {
      environment: 'LIVE',
      apiBaseUrl: 'https://api-m.paypal.com',
      clientId: 'prod-id',
      clientSecret: 'prod-secret',
    };
    const service = new PayPalPayoutsService({ config: prodConfig, fetchImpl: vi.fn() });

    await expect(service.createAuthorizedProofBatch(validTwoItemInput)).rejects.toThrow(
      PayoutSafetyViolationError
    );
    await expect(service.createAuthorizedProofBatch(validTwoItemInput)).rejects.toThrow(
      /Refusing payout creation in non-SANDBOX environment/i
    );
  });

  // 2. More than 2 recipients rejected by proof guard
  it('2. rejects more than 2 recipients (3 items) by proof ceiling guard', async () => {
    const mockFetch = createMockFetch({});
    const service = new PayPalPayoutsService({ config: validSandboxConfig, fetchImpl: mockFetch });

    const threeItemInput = {
      senderBatchId: 'ACTOVRA-3-ITEMS',
      items: [
        ...validTwoItemInput.items,
        {
          senderItemId: 'PROOF-ITEM-3',
          receiverEmail: 'sb-test-3@personal.example.com',
          amountCents: 100,
          currency: 'USD' as const,
        },
      ],
    };

    await expect(service.createAuthorizedProofBatch(threeItemInput)).rejects.toThrow(
      /PAYOUT CEILING VIOLATION: Exactly 2 items authorized/i
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects fewer than 2 recipients (1 item) by proof ceiling guard', async () => {
    const mockFetch = createMockFetch({});
    const service = new PayPalPayoutsService({ config: validSandboxConfig, fetchImpl: mockFetch });

    const oneItemInput = {
      senderBatchId: 'ACTOVRA-1-ITEM',
      items: [validTwoItemInput.items[0]],
    };

    await expect(service.createAuthorizedProofBatch(oneItemInput)).rejects.toThrow(
      /PAYOUT CEILING VIOLATION: Exactly 2 items authorized/i
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // 3. Total > $2 rejected
  it('3. rejects total amount > 200 cents ($2.00)', async () => {
    const mockFetch = createMockFetch({});
    const service = new PayPalPayoutsService({ config: validSandboxConfig, fetchImpl: mockFetch });

    const overTotalInput = {
      senderBatchId: 'ACTOVRA-OVER-TOTAL',
      items: [
        { ...validTwoItemInput.items[0], amountCents: 150 },
        { ...validTwoItemInput.items[1], amountCents: 100 },
      ],
    };

    await expect(service.createAuthorizedProofBatch(overTotalInput)).rejects.toThrow(
      PayoutSafetyViolationError
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // 4. Individual amount != $1 rejected
  it('4. rejects individual amount != 100 cents ($1.00) even if total is balanced', async () => {
    const mockFetch = createMockFetch({});
    const service = new PayPalPayoutsService({ config: validSandboxConfig, fetchImpl: mockFetch });

    const unbalancedInput = {
      senderBatchId: 'ACTOVRA-UNBALANCED',
      items: [
        { ...validTwoItemInput.items[0], amountCents: 50 },
        { ...validTwoItemInput.items[1], amountCents: 150 },
      ],
    };

    await expect(service.createAuthorizedProofBatch(unbalancedInput)).rejects.toThrow(
      /Authorized ceiling is exactly 100¢/i
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // 5. Non-USD rejected
  it('5. rejects non-USD currency (e.g. EUR)', async () => {
    const mockFetch = createMockFetch({});
    const service = new PayPalPayoutsService({ config: validSandboxConfig, fetchImpl: mockFetch });

    const nonUsdInput = {
      senderBatchId: 'ACTOVRA-EUR',
      items: [
        { ...validTwoItemInput.items[0], currency: 'EUR' as unknown as 'USD' },
        validTwoItemInput.items[1],
      ],
    };

    await expect(service.createAuthorizedProofBatch(nonUsdInput)).rejects.toThrow(
      /Only USD authorized/i
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // 6. Missing recipient rejected
  it('6. rejects missing or invalid receiver email address', async () => {
    const mockFetch = createMockFetch({});
    const service = new PayPalPayoutsService({ config: validSandboxConfig, fetchImpl: mockFetch });

    const invalidEmailInput = {
      senderBatchId: 'ACTOVRA-BAD-EMAIL',
      items: [
        { ...validTwoItemInput.items[0], receiverEmail: '' },
        validTwoItemInput.items[1],
      ],
    };

    await expect(service.createAuthorizedProofBatch(invalidEmailInput)).rejects.toThrow(
      /invalid receiver email/i
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // 7. Duplicate sender_item_id rejected
  it('7. rejects duplicate senderItemId within the same batch', async () => {
    const mockFetch = createMockFetch({});
    const service = new PayPalPayoutsService({ config: validSandboxConfig, fetchImpl: mockFetch });

    const duplicateItemIdsInput = {
      senderBatchId: 'ACTOVRA-DUP-IDS',
      items: [
        { ...validTwoItemInput.items[0], senderItemId: 'DUPLICATE_ITEM_ID' },
        { ...validTwoItemInput.items[1], senderItemId: 'DUPLICATE_ITEM_ID' },
      ],
    };

    await expect(service.createAuthorizedProofBatch(duplicateItemIdsInput)).rejects.toThrow(
      /Duplicate or missing senderItemId/i
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // 8. Held payout cannot enter payload
  it('8. ensures held payouts cannot be passed into the authorized proof payload', async () => {
    const mockFetch = createMockFetch({});
    const service = new PayPalPayoutsService({ config: validSandboxConfig, fetchImpl: mockFetch });

    // John Doe (aff-067) is held below threshold ($42.16)
    const heldInput = {
      senderBatchId: 'ACTOVRA-HELD-ITEM',
      items: [
        { senderItemId: 'payout-067', receiverEmail: 'john.doe@creatorhub.net', amountCents: 4216, currency: 'USD' as const },
        validTwoItemInput.items[1],
      ],
    };

    await expect(service.createAuthorizedProofBatch(heldInput)).rejects.toThrow(
      PayoutSafetyViolationError
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // 9. Negative payout cannot enter payload
  it('9. ensures negative balance payouts cannot be passed into the payload', async () => {
    const mockFetch = createMockFetch({});
    const service = new PayPalPayoutsService({ config: validSandboxConfig, fetchImpl: mockFetch });

    // Inactive Affiliate Delta (payout-401) is negative (-$25.00)
    const negativeInput = {
      senderBatchId: 'ACTOVRA-NEGATIVE-ITEM',
      items: [
        { senderItemId: 'payout-401', receiverEmail: 'delta.inactive@creatorhub.net', amountCents: -2500, currency: 'USD' as const },
        validTwoItemInput.items[1],
      ],
    };

    await expect(service.createAuthorizedProofBatch(negativeInput)).rejects.toThrow(
      PayoutSafetyViolationError
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // 10. Retry cannot happen automatically
  it('10. verifies service performs exactly 1 HTTP POST and never retries automatically on failure', async () => {
    let postCalls = 0;
    const failingFetch = vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      if (input.includes('/v1/oauth2/token')) {
        return new Response(JSON.stringify(fakeOAuthTokenResponse), { status: 200 });
      }
      if (input.endsWith('/v1/payments/payouts') && init?.method === 'POST') {
        postCalls += 1;
        return new Response(JSON.stringify({ name: 'INSUFFICIENT_FUNDS', message: 'No funds' }), {
          status: 400,
          headers: { 'paypal-debug-id': 'debug-fail-1' },
        });
      }
      return new Response('Not found', { status: 404 });
    });

    const service = new PayPalPayoutsService({ config: validSandboxConfig, fetchImpl: failingFetch });

    await expect(service.createAuthorizedProofBatch(validTwoItemInput)).rejects.toThrow(
      /PayPal Payouts error \[INSUFFICIENT_FUNDS\]/i
    );

    // Exactly ONE call was made — no automatic retries!
    expect(postCalls).toBe(1);
  });

  // 11. Reconciliation maps statuses correctly
  it('11. correctly maps PayPal batch and item statuses into ACTOVRA reconciliation model', async () => {
    const mockBatchResponse = {
      total_items: 2,
      total_pages: 1,
      batch_header: {
        payout_batch_id: 'MOCK_BATCH_123',
        batch_status: 'SUCCESS',
        time_created: '2026-10-31T18:00:00Z',
        time_completed: '2026-10-31T18:00:15Z',
        sender_batch_header: {
          sender_batch_id: 'ACTOVRA-PROOF-001',
          email_subject: 'You have a payout!',
        },
        amount: { currency: 'USD', value: '2.00' },
        fees: { currency: 'USD', value: '0.50' },
      },
      items: [
        {
          payout_item_id: 'ITEM_001',
          transaction_id: 'TXN_001',
          transaction_status: 'SUCCESS',
          payout_item: {
            recipient_type: 'EMAIL',
            amount: { currency: 'USD', value: '1.00' },
            receiver: 'sb-test-1@personal.example.com',
            sender_item_id: 'PROOF-ITEM-1',
          },
        },
        {
          payout_item_id: 'ITEM_002',
          transaction_id: 'TXN_002',
          transaction_status: 'UNCLAIMED',
          payout_item: {
            recipient_type: 'EMAIL',
            amount: { currency: 'USD', value: '1.00' },
            receiver: 'sb-test-2@personal.example.com',
            sender_item_id: 'PROOF-ITEM-2',
          },
        },
      ],
    };

    const mockFetch = createMockFetch({}, mockBatchResponse);
    const service = new PayPalPayoutsService({ config: validSandboxConfig, fetchImpl: mockFetch });

    const result = await service.getPayoutBatch('MOCK_BATCH_123');

    expect(result.payoutBatchId).toBe('MOCK_BATCH_123');
    expect(result.senderBatchId).toBe('ACTOVRA-PROOF-001');
    expect(result.batchStatus).toBe('SUCCESS');
    expect(result.totalAmountCents).toBe(200);
    expect(result.requestedCount).toBe(2);
    expect(result.completedCount).toBe(1);
    expect(result.unclaimedCount).toBe(1);
    expect(result.failedCount).toBe(0);
    expect(result.items).toHaveLength(2);
    expect(result.items[0].transactionStatus).toBe('SUCCESS');
    expect(result.items[0].transactionId).toBe('TXN_001');
    expect(result.items[1].transactionStatus).toBe('UNCLAIMED');
  });

  // 12. Secrets/tokens are not persisted in audit data
  it('12. ensures secrets, basic auth tokens, and bearer tokens are not exposed in reconciliation objects', async () => {
    const mockBatchResponse = {
      batch_header: {
        payout_batch_id: 'CLEAN_BATCH_456',
        batch_status: 'PENDING',
        time_created: '2026-10-31T18:00:00Z',
        sender_batch_header: { sender_batch_id: 'ACTOVRA-PROOF-002' },
        amount: { currency: 'USD', value: '2.00' },
      },
      items: [],
    };

    const mockFetch = createMockFetch({}, mockBatchResponse);
    const service = new PayPalPayoutsService({ config: validSandboxConfig, fetchImpl: mockFetch });

    const recon = await service.getPayoutBatch('CLEAN_BATCH_456');
    const jsonStr = JSON.stringify(recon);

    expect(jsonStr).not.toContain('fake-sandbox-client-secret');
    expect(jsonStr).not.toContain('fake-access-token');
    expect(jsonStr).not.toContain('Basic');
    expect(jsonStr).not.toContain('Bearer');
  });

  // 13. Existing Orders v2 integration remains unchanged
  it('13. confirms existing Orders v2 PayPalService remains intact and functional', () => {
    const ordersService = new PayPalService({ config: validSandboxConfig });
    expect(typeof ordersService.createOrder).toBe('function');
    expect(typeof ordersService.captureOrder).toBe('function');
    expect(typeof ordersService.getOrder).toBe('function');
    expect(typeof ordersService.getAccessToken).toBe('function');
  });

  // 14. Existing PAYOUT-01 through PAYOUT-05 behavior remains intact
  it('14. confirms existing 1,000-population and deterministic calculation engine remain intact', () => {
    const population = generateSyntheticPayoutPopulation();
    const evaluated = classifyPayoutPopulation(population);
    const summary = aggregatePayoutBatch(evaluated);

    expect(population).toHaveLength(1000);
    expect(summary.totalRecipients).toBe(1000);
    expect(summary.readyCount).toBe(917);
    expect(summary.heldCount).toBe(66);
    expect(summary.analysisRequiredCount).toBe(17);
    expect(summary.totalNetPayableCents).toBe(14793075);
    expect(summary.readyAmountCents).toBe(14059447);
    expect(summary.heldAmountCents).toBe(183420);
    expect(summary.analysisRequiredAmountCents).toBe(552708);
  });
});
