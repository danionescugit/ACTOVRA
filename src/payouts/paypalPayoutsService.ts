import {
  type PayPalConfig,
  PAYPAL_API_BASE_URLS,
} from '../services/paypal/config';
import { type FetchLike } from '../services/paypal/paypalService';
import {
  type CreatePayoutProofBatchInput,
  type PayPalRawGetBatchResponse,
  type PayoutReconciliationResult,
  type PayoutReconciledItem,
  PayoutSafetyViolationError,
  PayPalPayoutsApiError,
} from './paypalPayoutsTypes';

export interface PayPalPayoutsServiceOptions {
  readonly config: PayPalConfig;
  readonly fetchImpl?: FetchLike;
}

export class PayPalPayoutsService {
  readonly #config: PayPalConfig;
  readonly #fetchImpl: FetchLike;

  constructor(options: PayPalPayoutsServiceOptions) {
    this.#config = options.config;
    this.#fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Helper to acquire OAuth Bearer token via client credentials.
   * Never logs credentials, secrets, or raw bearer token.
   */
  async getAccessToken(): Promise<string> {
    const { clientId, clientSecret, apiBaseUrl, environment } = this.#config;

    if (environment !== 'SANDBOX') {
      throw new PayoutSafetyViolationError(
        `PAYOUT SAFETY VIOLATION: Environment must be SANDBOX. Found: ${environment}`
      );
    }
    if (apiBaseUrl !== PAYPAL_API_BASE_URLS.SANDBOX) {
      throw new PayoutSafetyViolationError(
        `PAYOUT SAFETY VIOLATION: API base must be ${PAYPAL_API_BASE_URLS.SANDBOX}. Found: ${apiBaseUrl}`
      );
    }
    if (!clientId || !clientSecret) {
      throw new PayoutSafetyViolationError('PayPal client credentials are not configured');
    }

    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64');
    const tokenUrl = `${apiBaseUrl}/v1/oauth2/token`;

    let res: Response;
    try {
      res = await this.#fetchImpl(tokenUrl, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
      });
    } catch (cause) {
      throw new PayPalPayoutsApiError('PayPal OAuth request failed at transport level', { details: cause });
    }

    if (!res.ok) {
      throw new PayPalPayoutsApiError(`PayPal OAuth failed with HTTP status ${res.status}`, {
        status: res.status,
      });
    }

    const data = (await res.json()) as { access_token?: string; scope?: string };
    if (!data.access_token) {
      throw new PayPalPayoutsApiError('PayPal OAuth response missing access_token');
    }

    // Verify scope contains payouts
    const scopes = (data.scope ?? '').split(/\s+/);
    if (!scopes.includes('https://uri.paypal.com/payments/payouts')) {
      throw new PayoutSafetyViolationError(
        'OAuth token does not have the required Payouts scope (https://uri.paypal.com/payments/payouts)'
      );
    }

    return data.access_token;
  }

  /**
   * Creates an authorized sandbox payout batch with hard transaction ceiling guards.
   *
   * STRICT HARD GUARDS:
   * - environment === 'SANDBOX'
   * - items.length === 2
   * - each amount === 100 cents ($1.00 USD)
   * - currency === 'USD'
   * - total amount === 200 cents ($2.00 USD)
   * - no duplicate senderItemId in batch
   * - no automatic retry logic
   */
  async createAuthorizedProofBatch(input: CreatePayoutProofBatchInput): Promise<{
    payoutBatchId: string;
    batchStatus: string;
    senderBatchId: string;
    timeCreated: string;
    debugId?: string;
  }> {
    // 1. HARD SAFETY GUARDS (Reject before any network request)
    if (this.#config.environment !== 'SANDBOX') {
      throw new PayoutSafetyViolationError(
        `PAYOUT SAFETY VIOLATION: Refusing payout creation in non-SANDBOX environment: ${this.#config.environment}`
      );
    }
    if (this.#config.apiBaseUrl !== PAYPAL_API_BASE_URLS.SANDBOX) {
      throw new PayoutSafetyViolationError(
        `PAYOUT SAFETY VIOLATION: Refusing payout creation with non-SANDBOX host: ${this.#config.apiBaseUrl}`
      );
    }

    if (input.items.length !== 2) {
      throw new PayoutSafetyViolationError(
        `PAYOUT CEILING VIOLATION: Exactly 2 items authorized. Received: ${input.items.length}`
      );
    }

    let totalCents = 0;
    const seenSenderItemIds = new Set<string>();

    for (const [idx, item] of input.items.entries()) {
      if (!item.receiverEmail || !item.receiverEmail.includes('@')) {
        throw new PayoutSafetyViolationError(`PAYOUT SAFETY VIOLATION: Item ${idx} has invalid receiver email`);
      }
      if (item.currency !== 'USD') {
        throw new PayoutSafetyViolationError(
          `PAYOUT SAFETY VIOLATION: Item ${idx} has unauthorized currency ${item.currency}. Only USD authorized.`
        );
      }
      if (item.amountCents !== 100) {
        throw new PayoutSafetyViolationError(
          `PAYOUT CEILING VIOLATION: Item ${idx} amount is ${item.amountCents}¢. Authorized ceiling is exactly 100¢ ($1.00).`
        );
      }
      if (!item.senderItemId || seenSenderItemIds.has(item.senderItemId)) {
        throw new PayoutSafetyViolationError(
          `PAYOUT SAFETY VIOLATION: Duplicate or missing senderItemId: ${item.senderItemId}`
        );
      }
      seenSenderItemIds.add(item.senderItemId);
      totalCents += item.amountCents;
    }

    if (totalCents !== 200) {
      throw new PayoutSafetyViolationError(
        `PAYOUT CEILING VIOLATION: Total payout amount is ${totalCents}¢ ($${(totalCents / 100).toFixed(2)}). Authorized ceiling is exactly 200¢ ($2.00).`
      );
    }

    if (!input.senderBatchId || !input.senderBatchId.trim()) {
      throw new PayoutSafetyViolationError('PAYOUT SAFETY VIOLATION: Missing senderBatchId');
    }

    // 2. Obtain Token
    const accessToken = await this.getAccessToken();

    // 3. Build Safe Payload
    const payload = {
      sender_batch_header: {
        sender_batch_id: input.senderBatchId,
        email_subject: 'ACTOVRA Sandbox Payout Settlement Proof',
        email_message: 'Automated Sandbox Payout Proof from ACTOVRA Financial Operations',
      },
      items: input.items.map((item) => ({
        recipient_type: 'EMAIL',
        amount: {
          value: (item.amountCents / 100).toFixed(2),
          currency: item.currency,
        },
        receiver: item.receiverEmail,
        note: item.note || `ACTOVRA Proof Payout: ${item.senderItemId}`,
        sender_item_id: item.senderItemId,
      })),
    };

    const url = `${this.#config.apiBaseUrl}/v1/payments/payouts`;

    let response: Response;
    try {
      response = await this.#fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    } catch (cause) {
      throw new PayPalPayoutsApiError('POST /v1/payments/payouts transport failure', { details: cause });
    }

    const debugId = response.headers.get('paypal-debug-id') || response.headers.get('Paypal-Debug-Id') || undefined;

    let responseBody: Record<string, unknown> = {};
    try {
      responseBody = (await response.json()) as Record<string, unknown>;
    } catch {
      throw new PayPalPayoutsApiError(
        `POST /v1/payments/payouts failed with HTTP status ${response.status} (non-JSON response)`,
        { status: response.status, debugId }
      );
    }

    if (!response.ok) {
      const errName = typeof responseBody.name === 'string' ? responseBody.name : 'UNKNOWN_ERROR';
      const errMsg = typeof responseBody.message === 'string' ? responseBody.message : 'Payout creation failed';
      throw new PayPalPayoutsApiError(`PayPal Payouts error [${errName}]: ${errMsg}`, {
        status: response.status,
        debugId,
        details: responseBody,
      });
    }

    const batchHeader = responseBody.batch_header as
      | {
          payout_batch_id?: string;
          batch_status?: string;
          time_created?: string;
        }
      | undefined;

    if (!batchHeader || !batchHeader.payout_batch_id) {
      throw new PayPalPayoutsApiError('Malformed payout creation response: missing batch_header.payout_batch_id', {
        status: response.status,
        debugId,
        details: responseBody,
      });
    }

    return {
      payoutBatchId: batchHeader.payout_batch_id,
      batchStatus: batchHeader.batch_status || 'PENDING',
      senderBatchId: input.senderBatchId,
      timeCreated: batchHeader.time_created || new Date().toISOString(),
      debugId,
    };
  }

  /**
   * Retrieves status for an existing payout batch and maps to ACTOVRA reconciliation model.
   * Performs read-only querying without making retry decisions.
   */
  async getPayoutBatch(payoutBatchId: string): Promise<PayoutReconciliationResult> {
    if (!payoutBatchId || !payoutBatchId.trim()) {
      throw new PayoutSafetyViolationError('payoutBatchId cannot be empty');
    }

    const accessToken = await this.getAccessToken();
    const url = `${this.#config.apiBaseUrl}/v1/payments/payouts/${encodeURIComponent(payoutBatchId)}`;

    let response: Response;
    try {
      response = await this.#fetchImpl(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      });
    } catch (cause) {
      throw new PayPalPayoutsApiError('GET /v1/payments/payouts/{id} transport failure', { details: cause });
    }

    const debugId = response.headers.get('paypal-debug-id') || response.headers.get('Paypal-Debug-Id') || undefined;

    if (!response.ok) {
      throw new PayPalPayoutsApiError(`GET /v1/payments/payouts failed with HTTP status ${response.status}`, {
        status: response.status,
        debugId,
      });
    }

    const data = (await response.json()) as PayPalRawGetBatchResponse;
    const header = data.batch_header;

    if (!header || !header.payout_batch_id) {
      throw new PayPalPayoutsApiError('Invalid batch response: missing batch_header', { debugId });
    }

    const rawItems = data.items || [];
    let completedCount = 0;
    let pendingCount = 0;
    let failedCount = 0;
    let unclaimedCount = 0;

    const reconciledItems: PayoutReconciledItem[] = [];

    for (const raw of rawItems) {
      const status = (raw.transaction_status || 'PENDING').toUpperCase();
      if (status === 'SUCCESS') completedCount += 1;
      else if (status === 'PENDING' || status === 'PROCESSING') pendingCount += 1;
      else if (status === 'FAILED' || status === 'BLOCKED' || status === 'DENIED' || status === 'RETURNED') failedCount += 1;
      else if (status === 'UNCLAIMED') unclaimedCount += 1;
      else pendingCount += 1;

      const amtNum = parseFloat(raw.payout_item?.amount?.value || '0');
      const amountCents = Math.round(amtNum * 100);

      reconciledItems.push({
        payoutItemId: raw.payout_item_id,
        senderItemId: raw.payout_item?.sender_item_id || 'UNKNOWN',
        receiverEmail: raw.payout_item?.receiver || 'UNKNOWN',
        amountCents,
        currency: raw.payout_item?.amount?.currency || 'USD',
        transactionStatus: status,
        transactionId: raw.transaction_id,
        errorDetails: raw.errors?.message,
      });
    }

    const totalAmtFloat = parseFloat(header.amount?.value || '0');
    const totalAmountCents = Math.round(totalAmtFloat * 100);

    return {
      payoutBatchId: header.payout_batch_id,
      senderBatchId: header.sender_batch_header?.sender_batch_id || 'UNKNOWN',
      batchStatus: (header.batch_status || 'PENDING').toUpperCase(),
      totalAmountCents,
      currency: header.amount?.currency || 'USD',
      timeCreated: header.time_created,
      timeCompleted: header.time_completed,
      requestedCount: data.total_items ?? rawItems.length,
      completedCount,
      pendingCount,
      failedCount,
      unclaimedCount,
      items: reconciledItems,
      debugId,
    };
  }
}
