/**
 * Type definitions and schemas for the ACTOVRA PayPal Payouts integration (PAYOUT-06).
 */

export interface PayoutProofItemInput {
  readonly senderItemId: string;
  readonly receiverEmail: string;
  readonly amountCents: number;
  readonly currency: 'USD';
  readonly note?: string;
}

export interface CreatePayoutProofBatchInput {
  readonly senderBatchId: string;
  readonly items: readonly PayoutProofItemInput[];
}

export interface PayPalRawBatchHeader {
  readonly payout_batch_id: string;
  readonly batch_status: string;
  readonly time_created: string;
  readonly time_completed?: string;
  readonly sender_batch_header: {
    readonly sender_batch_id: string;
    readonly email_subject?: string;
  };
  readonly amount?: {
    readonly currency: string;
    readonly value: string;
  };
  readonly fees?: {
    readonly currency: string;
    readonly value: string;
  };
}

export interface PayPalRawPayoutItem {
  readonly payout_item_id: string;
  readonly transaction_id?: string;
  readonly transaction_status: string;
  readonly payout_item_fee?: {
    readonly currency: string;
    readonly value: string;
  };
  readonly payout_batch_id: string;
  readonly payout_item: {
    readonly recipient_type: string;
    readonly amount: {
      readonly currency: string;
      readonly value: string;
    };
    readonly note?: string;
    readonly receiver: string;
    readonly sender_item_id: string;
  };
  readonly errors?: {
    readonly name?: string;
    readonly message?: string;
  };
}

export interface PayPalRawGetBatchResponse {
  readonly total_items?: number;
  readonly total_pages?: number;
  readonly batch_header: PayPalRawBatchHeader;
  readonly items?: readonly PayPalRawPayoutItem[];
  readonly links?: readonly { readonly href: string; readonly rel: string; readonly method: string }[];
}

export interface PayoutReconciledItem {
  readonly payoutItemId?: string;
  readonly senderItemId: string;
  readonly receiverEmail: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly transactionStatus: string;
  readonly transactionId?: string;
  readonly errorDetails?: string;
}

export interface PayoutReconciliationResult {
  readonly payoutBatchId: string;
  readonly senderBatchId: string;
  readonly batchStatus: string;
  readonly totalAmountCents: number;
  readonly currency: string;
  readonly timeCreated: string;
  readonly timeCompleted?: string;
  readonly requestedCount: number;
  readonly completedCount: number;
  readonly pendingCount: number;
  readonly failedCount: number;
  readonly unclaimedCount: number;
  readonly items: readonly PayoutReconciledItem[];
  readonly debugId?: string;
}

export class PayoutSafetyViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayoutSafetyViolationError';
  }
}

export class PayPalPayoutsApiError extends Error {
  readonly status?: number;
  readonly debugId?: string;
  readonly details?: unknown;

  constructor(message: string, options?: { status?: number; debugId?: string; details?: unknown }) {
    super(message);
    this.name = 'PayPalPayoutsApiError';
    this.status = options?.status;
    this.debugId = options?.debugId;
    this.details = options?.details;
  }
}
