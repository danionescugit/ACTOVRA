/**
 * Commerce Execution Orchestrator (Task 08, Checkpoint 3).
 *
 * Smallest safe connector between an APPROVED CommerceOperation and PayPal:
 *
 *   APPROVED operation
 *     → durable EXECUTION_STARTED (the authoritative execution claim)
 *     → PayPalService.createOrder()            [injected boundary]
 *     → durable PAYPAL_ORDER_CREATED           (NEVER PAYMENT_COMPLETED)
 *
 * Safety invariants implemented here:
 * - Only APPROVED operations reach PayPal. The claim is the store transaction
 *   (BEGIN IMMEDIATE → transition → snapshot + audit), never a stale pre-read:
 *   if EXECUTION_STARTED cannot commit, this invocation makes ZERO PayPal
 *   calls (concurrent/double invocation yields exactly one logical execution).
 * - EXECUTION_STARTED is durably persisted BEFORE createOrder() is called.
 * - The orchestrator never mutates snapshots directly; the only writes go
 *   through CommerceOperationStore.applyOperationEvent().
 * - PayPalService stays unaware of store/state machine/policy: it is injected
 *   via the minimal structural PayPalOrderCreator interface (createOrder only)
 *   so unit tests never need real credentials, config, or network.
 * - Successful createOrder() persists PAYPAL_ORDER_CREATED — never
 *   PAYMENT_COMPLETED — with the exact normalized PayPal result.
 * - Clear createOrder() failures persist PAYMENT_FAILED (→ FAILED) with a
 *   sanitized message. Transport/malformed-response ambiguity is documented:
 *   an order MAY exist remotely even though no proof of it exists locally.
 * - If PayPal succeeded but PAYPAL_ORDER_CREATED persistence failed, the
 *   outcome is POST_PAYPAL_PERSISTENCE_FAILED (operation stays EXECUTING) and
 *   the safe normalized result is returned so a caller can recover via
 *   persistPayPalOrderOutcome() — which never calls PayPal.
 * - No retries, no capture, no webhooks, no UI/API wiring, no reconciliation
 *   subsystem. No secrets in persisted or returned errors.
 * - Optional buyer-redirect approval flow (Task 10 CP2-B): an approvalRedirect
 *   option is forwarded VERBATIM into createOrder() returnUrl/cancelUrl.
 *   The orchestrator never invents or validates these (the PayPal boundary
 *   validates HTTPS-only pairing); with the option absent, requests are
 *   byte-identical to before (backward compatible).
 */

import type {
  CommerceOperation,
  CommerceOperationStatus,
  PayPalOrderInfo,
} from '../domain/schemas';
import {
  PayPalInvalidRequestError,
  type CreatePayPalOrderInput,
  type PayPalCreateOrderResult,
  type PayPalSupportedCurrency,
} from '../services/paypal';
import type {
  CommerceOperationStore,
  AppliedOperationEvent,
} from '../store';

/* ------------------------------------------------------------------ */
/* Injected PayPal execution boundary                                  */
/* ------------------------------------------------------------------ */

/**
 * Minimal structural interface the orchestrator needs from the PayPal
 * service boundary: ONLY createOrder() with the existing PayPal input/result
 * types. The concrete PayPalService satisfies it structurally, and unit tests
 * inject a fake — no credentials, no config, no network. Not a provider
 * framework.
 */
export interface PayPalOrderCreator {
  createOrder(input: CreatePayPalOrderInput): Promise<PayPalCreateOrderResult>;
}

/** Normalized successful create-order result (PayPalService shape). */
export type PayPalOrderCreatorResult = PayPalCreateOrderResult;

/**
 * Buyer-redirect approval flow configuration for executeApprovedOperation().
 * Pure pass-through: forwarded VERBATIM into PayPal createOrder()'s
 * returnUrl/cancelUrl (which are validated there — HTTPS-only, paired).
 * The orchestrator never invents, defaults, or normalizes these values.
 */
export interface PayPalApprovalRedirect {
  readonly returnUrl: string;
  readonly cancelUrl: string;
}

export type CommerceExecutionClock = () => Date;

/* ------------------------------------------------------------------ */
/* Deterministic PayPal request ID                                     */
/* ------------------------------------------------------------------ */

/**
 * Stable namespace/prefix for orchestrator-owned PayPal-Request-Ids.
 * The full request ID is `${PAYPAL_REQUEST_ID_PREFIX}${operationId}` —
 * derived purely from the CommerceOperation ID: no timestamps, no
 * randomness, no secrets. PayPal deduplicates logical executions that
 * reuse the same PayPal-Request-Id.
 */
export const PAYPAL_REQUEST_ID_PREFIX = 'commercepilot-op-';

/** Deterministic stable PayPal-Request-Id for a CommerceOperation ID. */
export function payPalRequestIdForOperation(operationId: string): string {
  return `${PAYPAL_REQUEST_ID_PREFIX}${operationId}`;
}

/* ------------------------------------------------------------------ */
/* Outcome model                                                       */
/* ------------------------------------------------------------------ */

/** Terminal outcome of executeApprovedOperation(). */
export type CommerceExecutionOutcome =
  | {
      readonly kind: 'ORDER_CREATED';
      readonly operationId: string;
      readonly paypalOrder: PayPalOrderInfo;
    }
  | {
      readonly kind: 'EXECUTION_FAILED';
      readonly operationId: string;
      /** Safe, sanitized failure description (no secrets). */
      readonly message: string;
    }
  | {
      readonly kind: 'POST_PAYPAL_PERSISTENCE_FAILED';
      readonly operationId: string;
      /** Safe recovery information for persistPayPalOrderOutcome(). */
      readonly paypalResult: PayPalOrderCreatorResult;
      readonly message: string;
    }
  | {
      readonly kind: 'NOT_EXECUTABLE';
      readonly operationId: string;
      /** The operation's current durable status at decision time, when known. */
      readonly currentStatus?: CommerceOperationStatus;
      /** Stable machine-readable reason (see NON_EXECUTABLE_REASONS). */
      readonly reason: string;
    };

/**
 * Stable machine-readable reasons for NOT_EXECUTABLE outcomes.
 * These strings are part of the orchestrator's public surface.
 */
export const NON_EXECUTABLE_REASONS = {
  OPERATION_NOT_FOUND: 'OPERATION_NOT_FOUND',
  NOT_APPROVED: 'NOT_APPROVED',
  ALREADY_EXECUTING: 'ALREADY_EXECUTING',
} as const;

/** Constructor dependencies for CommerceExecutionOrchestrator. */
export interface CommerceExecutionOrchestratorOptions {
  /**
   * Durable store. applyOperationEvent() is the only write path used;
   * getOperation()/getAuditTrail() are read-only. Structural so tests can
   * inject focused fakes; CommerceOperationStore satisfies it directly.
   */
  readonly store: Pick<
    CommerceOperationStore,
    'getOperation' | 'applyOperationEvent' | 'getAuditTrail'
  >;
  /** PayPal execution boundary (PayPalService or a test fake). */
  readonly paypal: PayPalOrderCreator;
  /**
   * Optional buyer-redirect approval flow. When present, BOTH fields are
   * forwarded verbatim to PayPal createOrder() as returnUrl/cancelUrl;
   * when absent, the create-order request is unchanged (server-driven flow).
   * Validation (pairing, HTTPS-only) happens inside the PayPal boundary.
   */
  readonly approvalRedirect?: PayPalApprovalRedirect;
  /** Injectable clock for deterministic tests. Defaults to () => new Date(). */
  readonly now?: CommerceExecutionClock;
}

/* ------------------------------------------------------------------ */
/* Secret hygiene                                                      */
/* ------------------------------------------------------------------ */

/**
 * Lightweight secret scrubbing for failure messages. PayPalService errors are
 * already built secret-free by construction; this is defense in depth so
 * unexpected error shapes still cannot persist or return secret-looking
 * values.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9][A-Za-z0-9-]{7,}/g, // sk-... style keys
  /Bearer\s+[A-Za-z0-9._-]{8,}/gi, // bearer tokens
  /access_token[=:]\s*\S+/gi, // oauth tokens
  /client_secret[=:]\s*\S+/gi, // client secrets
  /Authorization\s*:\s*\S+/gi, // auth headers
];

/** Return a message with secret-looking values redacted. Never throws. */
function sanitizeMessage(message: string): string {
  let sanitized = message;
  for (const pattern of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }
  return sanitized;
}

/**
 * Safe description of a createOrder() failure. Uses the existing typed PayPal
 * error model where possible: PayPal error names and HTTP status are safe and
 * useful; only error.message (already secret-free by the PayPal boundary's
 * own contract) is forwarded, additionally scrubbed as defense in depth.
 * Non-PayPal error shapes are reduced to name + message, scrubbed.
 */
function describePayPalFailure(error: unknown): {
  message: string;
  paypalError?: { name: string; status?: number };
} {
  if (error instanceof Error && typeof error.name === 'string') {
    const isPayPalBoundaryError = error.name.startsWith('PayPal');
    const raw = isPayPalBoundaryError
      ? error.message
      : `${error.name}: ${error.message}`;
    if (isPayPalBoundaryError) {
      const withStatus = error as Error & { status?: number };
      return {
        message: sanitizeMessage(raw),
        paypalError: {
          name: error.name,
          ...(typeof withStatus.status === 'number' ? { status: withStatus.status } : {}),
        },
      };
    }
    return { message: sanitizeMessage(raw) };
  }
  return { message: 'PayPal create-order failed with an unrecognized error' };
}

/**
 * True when the error is definite proof that NO PayPal order exists:
 * PayPalInvalidRequestError is raised by pre-HTTP local validation, before
 * any network side effect. Transport (PayPalHttpApiError without status) and
 * malformed-response (PayPalMalformedResponseError) failures carry NO such
 * proof — an order may exist remotely even though the caller cannot prove
 * its ID. CP3 does not reconcile those; callers must treat them as
 * "remote side effect unknown".
 */
export function isDefiniteNoOrderFailure(error: unknown): boolean {
  return error instanceof PayPalInvalidRequestError;
}

/* ------------------------------------------------------------------ */
/* Orchestrator                                                        */
/* ------------------------------------------------------------------ */

const DEFAULT_NOW: CommerceExecutionClock = () => new Date();

export class CommerceExecutionOrchestrator {
  readonly #store: CommerceExecutionOrchestratorOptions['store'];
  readonly #paypal: PayPalOrderCreator;
  readonly #approvalRedirect: PayPalApprovalRedirect | undefined;
  readonly #now: CommerceExecutionClock;

  constructor(options: CommerceExecutionOrchestratorOptions) {
    this.#store = options.store;
    this.#paypal = options.paypal;
    this.#approvalRedirect = options.approvalRedirect;
    this.#now = options.now ?? DEFAULT_NOW;
  }

  /**
   * Execute an approved operation:
   *   read → fast-path guards → durable EXECUTION_STARTED claim
   *   → exactly one createOrder() → durable PAYPAL_ORDER_CREATED.
   *
   * Expected outcomes are returned as typed results, never thrown. The one
   * deliberate throw path: a genuine store persistence failure while claiming
   * execution propagates as-is, because the only safe continuation is to
   * abort with ZERO PayPal calls.
   */
  async executeApprovedOperation(operationId: string): Promise<CommerceExecutionOutcome> {
    // 1–3. Read + fast-path guards. Any non-APPROVED status short-circuits
    // here with ZERO PayPal calls.
    const operation = this.#store.getOperation(operationId);
    if (operation === undefined) {
      return this.#notExecutable(operationId, NON_EXECUTABLE_REASONS.OPERATION_NOT_FOUND);
    }
    if (operation.status !== 'APPROVED') {
      if (operation.status === 'EXECUTING') {
        // Someone else already holds (or held) the execution claim.
        return this.#notExecutable(
          operationId,
          NON_EXECUTABLE_REASONS.ALREADY_EXECUTING,
          operation.status
        );
      }
      return this.#notExecutable(
        operationId,
        NON_EXECUTABLE_REASONS.NOT_APPROVED,
        operation.status
      );
    }

    // 5. CLAIM EXECUTION DURABLY. This transaction is the authoritative
    // ownership gate: the invocation whose EXECUTION_STARTED commits owns the
    // PayPal call. A stale APPROVED pre-read (step 1) grants nothing.
    let claim: AppliedOperationEvent;
    try {
      claim = this.#store.applyOperationEvent(
        operationId,
        { type: 'EXECUTION_STARTED' },
        this.#now()
      );
    } catch (error) {
      // The most likely cause of an EXECUTION_STARTED failure from APPROVED is
      // a concurrent invocation that committed the claim first (the durable
      // state is now EXECUTING and rejects the duplicate transition).
      // Re-read durably to distinguish that from a genuine persistence fault.
      const current = this.#readCurrent(operationId);
      if (current !== undefined && current.status === 'EXECUTING') {
        return this.#notExecutable(
          operationId,
          NON_EXECUTABLE_REASONS.ALREADY_EXECUTING,
          current.status
        );
      }
      // Genuine store failure: abort with ZERO PayPal calls.
      throw error;
    }
    if (claim.newStatus !== 'EXECUTING') {
      // Defensive: the state machine guarantees EXECUTING from APPROVED, so
      // anything else means the race was lost in a way the catch above did
      // not observe. Do not call PayPal.
      return this.#notExecutable(
        operationId,
        NON_EXECUTABLE_REASONS.ALREADY_EXECUTING,
        claim.newStatus
      );
    }

    // 6. Derive the PayPal input from the durably claimed operation.
    const claimed = claim.operation;
    const decision = claimed.decision;
    if (decision === undefined) {
      // An EXECUTING operation without decision data is an integrity fault:
      // never invent data. No safe transition exists from EXECUTING for this
      // condition (PAYPAL_PENDING / PAYMENT_* would overclaim a PayPal call
      // that never happened), so surface the inconsistency clearly and stop.
      throw new Error(
        `Operation ${operationId} is EXECUTING but has no persisted decision data; ` +
          'refusing to call PayPal without approved decision data'
      );
    }

    const requestId = payPalRequestIdForOperation(operationId);
    const input: CreatePayPalOrderInput = {
      requestId,
      amountMinorUnits: decision.amount,
      currency: decision.currency as PayPalSupportedCurrency,
      commerceOperationId: operationId,
      ...(this.#approvalRedirect !== undefined
        ? {
            returnUrl: this.#approvalRedirect.returnUrl,
            cancelUrl: this.#approvalRedirect.cancelUrl,
          }
        : {}),
    };
    let paypalResult: PayPalOrderCreatorResult;
    try {
      // Called exactly once per successfully claimed execution.
      paypalResult = await this.#paypal.createOrder(input);
    } catch (error) {
      // 8. Clear PayPal failure before any known order creation.
      const description = describePayPalFailure(error);
      try {
        this.#store.applyOperationEvent(
          operationId,
          {
            type: 'PAYMENT_FAILED',
            paymentResult: {
              success: false,
              errorMessage: description.message,
            },
          },
          this.#now()
        );
      } catch (persistError) {
        // PayPal failed AND the failure could not be persisted. Surface both
        // distinctly; the durable operation stays EXECUTING (no false FAILED,
        // no overclaimed completion).
        throw new AggregateError(
          [
            persistError,
            new Error(
              `PayPal create-order failed for operation ${operationId} ` +
                `(${description.message}) and persisting PAYMENT_FAILED also failed`
            ),
          ],
          `Operation ${operationId}: PayPal failed and PAYMENT_FAILED persistence ` +
            'also failed; operation remains EXECUTING'
        );
      }
      return {
        kind: 'EXECUTION_FAILED',
        operationId,
        message: description.message,
      };
    }

    // 7. SUCCESS: durably persist PAYPAL_ORDER_CREATED (never
    // PAYMENT_COMPLETED) with the exact normalized PayPal result.
    const paypalOrder = paypalResultToOrderInfo(paypalResult, requestId);
    try {
      this.#store.applyOperationEvent(
        operationId,
        { type: 'PAYPAL_ORDER_CREATED', paypalOrder },
        this.#now()
      );
    } catch {
      // 9. PayPal succeeded but local persistence failed. Do NOT retry
      // createOrder, do NOT emit PAYMENT_FAILED, do NOT mark COMPLETED, do
      // NOT hide the error: return the safe normalized result so a caller can
      // recover via persistPayPalOrderOutcome(). Durable status: EXECUTING.
      return {
        kind: 'POST_PAYPAL_PERSISTENCE_FAILED',
        operationId,
        paypalResult,
        message:
          'PayPal order was created, but persisting PAYPAL_ORDER_CREATED failed. ' +
          'The operation remains EXECUTING. Recover with persistPayPalOrderOutcome().',
      };
    }

    return { kind: 'ORDER_CREATED', operationId, paypalOrder };
  }

  /**
   * Explicit recovery for POST_PAYPAL_PERSISTENCE_FAILED (approved in CP1).
   *
   * Persists an ALREADY-SUCCESSFUL normalized PayPal create-order result as a
   * PAYPAL_ORDER_CREATED event. It NEVER calls PayPal, never overwrites a
   * different already-persisted PayPal order, and is deterministically safe
   * to repeat:
   *   - operation missing → refused (OPERATION_NOT_FOUND)
   *   - an equivalent PayPal order already persisted → no-op
   *     (PAYPAL_ORDER_ALREADY_PERSISTED)
   *   - a DIFFERENT PayPal order already persisted → refused
   *     (DIFFERENT_PAYPAL_ORDER_ALREADY_PERSISTED)
   *   - otherwise only while currently EXECUTING → persists exactly once
   *     (RECOVERED); any other status → refused (OPERATION_NOT_EXECUTING)
   */
  persistPayPalOrderOutcome(
    operationId: string,
    result: PayPalOrderCreatorResult
  ): { kind: 'RECOVERED'; operationId: string; paypalOrder: PayPalOrderInfo } | {
    kind: 'RECOVERY_NOT_APPLICABLE';
    operationId: string;
    reason: string;
  } {
    const operation = this.#store.getOperation(operationId);
    if (operation === undefined) {
      return {
        kind: 'RECOVERY_NOT_APPLICABLE',
        operationId,
        reason: 'OPERATION_NOT_FOUND',
      };
    }

    const paypalOrder = paypalResultToOrderInfo(
      result,
      payPalRequestIdForOperation(operationId)
    );

    // Already recovered (idempotent repeat) or conflicting order? Checked
    // before the status guard so repeats after successful recovery are
    // deterministic no-ops rather than misleading "not executing" refusals.
    const existing = operation.paypalOrder;
    if (existing !== undefined) {
      if (existing.paypalOrderId === paypalOrder.paypalOrderId) {
        return {
          kind: 'RECOVERY_NOT_APPLICABLE',
          operationId,
          reason: 'PAYPAL_ORDER_ALREADY_PERSISTED',
        };
      }
      return {
        kind: 'RECOVERY_NOT_APPLICABLE',
        operationId,
        reason: 'DIFFERENT_PAYPAL_ORDER_ALREADY_PERSISTED',
      };
    }

    if (operation.status !== 'EXECUTING') {
      return {
        kind: 'RECOVERY_NOT_APPLICABLE',
        operationId,
        reason: `OPERATION_NOT_EXECUTING (status: ${operation.status})`,
      };
    }

    try {
      this.#store.applyOperationEvent(
        operationId,
        { type: 'PAYPAL_ORDER_CREATED', paypalOrder },
        this.#now()
      );
    } catch (error) {
      throw new Error(
        `Failed to persist recovered PAYPAL_ORDER_CREATED for operation ${operationId}: ` +
          (error instanceof Error ? sanitizeMessage(error.message) : 'unknown store error')
      );
    }
    return { kind: 'RECOVERED', operationId, paypalOrder };
  }

  #notExecutable(
    operationId: string,
    reason: string,
    currentStatus?: CommerceOperationStatus
  ): CommerceExecutionOutcome {
    return {
      kind: 'NOT_EXECUTABLE',
      operationId,
      ...(currentStatus !== undefined ? { currentStatus } : {}),
      reason,
    };
  }

  #readCurrent(operationId: string): CommerceOperation | undefined {
    try {
      return this.#store.getOperation(operationId);
    } catch {
      // A read failure here must not mask the original claim failure.
      return undefined;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Normalized PayPal result → persisted PayPalOrderInfo (exact fields). */
function paypalResultToOrderInfo(
  result: PayPalOrderCreatorResult,
  requestId: string
): PayPalOrderInfo {
  const info: PayPalOrderInfo = {
    paypalOrderId: result.paypalOrderId,
    paypalStatus: result.status,
    requestId,
  };
  if (result.approveUrl !== undefined) {
    info.approveUrl = result.approveUrl;
  }
  return info;
}
