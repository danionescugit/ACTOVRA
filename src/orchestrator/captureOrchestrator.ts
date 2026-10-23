/**
 * Capture Orchestrator (Task 09, Checkpoint 4).
 *
 * Minimal safe connector between a PAYPAL_ORDER_CREATED CommerceOperation and
 * the PayPal capture side effect:
 *
 *   PAYPAL_ORDER_CREATED operation
 *     → getOrder() verification: PayPal buyer approval is PROVIDER evidence
 *       (orderStatus === 'APPROVED'), never owner approval (approvalStatus),
 *       never a policy result, never a browser callback, never a caller flag
 *     → durable CAPTURE_STARTED claim  (the authoritative single-flight gate)
 *     → exactly ONE captureOrder() attempt, deterministic PayPal-Request-Id
 *     → durable PAYMENT_COMPLETED / PAYMENT_FAILED (only with truthful
 *       capture evidence) or the operation remains CAPTURE_EXECUTING
 *
 * Safety invariants implemented here:
 * - Buyer approval is verified against PayPal read state (getOrder) BEFORE
 *   the claim. If it cannot be verified, there is no CAPTURE_STARTED and
 *   ZERO capture calls.
 * - The PayPal order ID is sourced ONLY from the persisted
 *   operation.paypalOrder — never from a caller, callback, or read result.
 * - If PayPal reports the order already COMPLETED before capture, the flow
 *   routes to reconciliation and never calls captureOrder.
 * - The store transaction (BEGIN IMMEDIATE → transition → snapshot + audit)
 *   is the single-flight gate. A claim loser re-reads durable state: seeing
 *   CAPTURE_EXECUTING, it returns ALREADY_CAPTURING with ZERO capture calls.
 * - Exactly one captureOrder attempt per successful claim. No automatic
 *   retry, no random request IDs: 'commercepilot-capture-{operationId}'.
 * - PAYMENT_COMPLETED is persisted only after integrity checks: echoed order
 *   ID matches the persisted order, capture.status === 'COMPLETED', captured
 *   amount/currency match the persisted approved decision, captureId
 *   non-empty. Evidence mismatches are surfaced as CAPTURE_INTEGRITY_FAULT
 *   and never become COMPLETED or FAILED.
 * - Transport ambiguity (HTTP status undefined), 5xx, malformed 2xx bodies
 *   and unknown error shapes leave the operation CAPTURE_EXECUTING
 *   (reconcile via getOrder). They are never mapped to FAILED.
 * - If PayPal captured but local persistence failed, the known normalized
 *   result is returned as CAPTURE_RECOVERY_REQUIRED; the operation stays
 *   CAPTURE_EXECUTING and persistKnownCaptureResult() recovers locally with
 *   ZERO PayPal calls. Capture is NEVER repeated.
 * - A durable FAILED outcome requires declined-capture evidence (the domain
 *   state machine requires transactionId/captureId + matching paypalOrderId
 *   for any outcome from CAPTURE_EXECUTING). A definite 4xx rejection without
 *   capture evidence therefore cannot durably become FAILED: the outcome is
 *   reported as CAPTURE_FAILED to the caller while the durable operation
 *   remains CAPTURE_EXECUTING for explicit resolution.
 * - Commercial-lifecycle seam: this orchestrator keys on the durable
 *   PAYPAL_ORDER_CREATED status plus provider evidence only. It never reads
 *   approvalStatus or policyResult as capture authorization, so upstream
 *   stages (Offer → Owner Approval → Customer Acceptance → Payment Checkout
 *   → Buyer Approval) can be introduced later without rewriting capture.
 * - No webhooks, no UI/API wiring, no secrets in outcomes, thrown errors, or
 *   logs. No .env access.
 */

import type {
  CommerceOperation,
  CommerceOperationStatus,
  PaymentResult,
} from '../domain/schemas';
import {
  PayPalConfigurationError,
  PayPalAuthenticationError,
  PayPalHttpApiError,
  PayPalInvalidRequestError,
  type CapturePayPalOrderInput,
  type PayPalCaptureOrderResult,
  type PayPalGetOrderResult,
} from '../services/paypal';
import type {
  CommerceOperationStore,
  AppliedOperationEvent,
} from '../store';
import type { CommerceExecutionClock } from './commerceExecutionOrchestrator';

/* ------------------------------------------------------------------ */
/* Injected PayPal execution boundary                                  */
/* ------------------------------------------------------------------ */

/**
 * Minimal structural interface the capture orchestrator needs from the PayPal
 * service boundary: captureOrder + getOrder with the existing PayPal
 * input/result types. The concrete PayPalService satisfies it structurally,
 * and unit tests inject a fake — no credentials, no config, no network.
 */
export interface PayPalCaptureExecutor {
  captureOrder(input: CapturePayPalOrderInput): Promise<PayPalCaptureOrderResult>;
  getOrder(input: { readonly paypalOrderId: string }): Promise<PayPalGetOrderResult>;
}

/* ------------------------------------------------------------------ */
/* Deterministic PayPal request ID (capture-specific)                  */
/* ------------------------------------------------------------------ */

/**
 * Stable namespace/prefix for capture PayPal-Request-Ids. The full request ID
 * is `${PAYPAL_CAPTURE_REQUEST_ID_PREFIX}${operationId}` — derived purely from
 * the CommerceOperation ID: deterministic, operation-specific,
 * capture-specific (distinct from the create-order prefix
 * 'commercepilot-op-'), reconstructable after restart without storage, and
 * never random. Reused verbatim by recovery/reconciliation re-invocations.
 *
 * NOTE (audit, section F): PayPal-side request-ID constraints and capture
 * endpoint idempotency semantics are NOT verifiable from this repository and
 * require external verification. CP4 safety therefore never depends on
 * PayPal-side dedupe: single-flight + at-most-one-attempt are the primary
 * guards; the stable ID is defense in depth for operator-driven retry only.
 */
export const PAYPAL_CAPTURE_REQUEST_ID_PREFIX = 'commercepilot-capture-';

/** Deterministic stable PayPal-Request-Id for a capture of a CommerceOperation. */
export function payPalCaptureRequestIdForOperation(operationId: string): string {
  return `${PAYPAL_CAPTURE_REQUEST_ID_PREFIX}${operationId}`;
}

/* ------------------------------------------------------------------ */
/* Outcome model                                                       */
/* ------------------------------------------------------------------ */

/** Terminal outcome of captureApprovedOrder(). */
export type CaptureOutcome =
  | {
      readonly kind: 'CAPTURE_COMPLETED';
      readonly operationId: string;
      /** The exact PaymentResult persisted on the operation (COMPLETED). */
      readonly paymentResult: PaymentResult;
    }
  | {
      readonly kind: 'CAPTURE_FAILED';
      readonly operationId: string;
      /** Safe, sanitized failure description (no secrets). */
      readonly message: string;
    }
  | {
      readonly kind: 'CAPTURE_AMBIGUOUS';
      readonly operationId: string;
      /** Safe, sanitized ambiguity description (no secrets). */
      readonly message: string;
    }
  | {
      readonly kind: 'CAPTURE_INTEGRITY_FAULT';
      readonly operationId: string;
      /**
       * The known normalized capture result that failed integrity checks.
       * Evidence only — the operation was intentionally NOT resolved.
       */
      readonly captureResult: PayPalCaptureOrderResult;
      readonly message: string;
    }
  | {
      readonly kind: 'CAPTURE_RECOVERY_REQUIRED';
      readonly operationId: string;
      /** Known successful capture result that could not be persisted. */
      readonly captureResult: PayPalCaptureOrderResult;
      readonly message: string;
    }
  | {
      readonly kind: 'NOT_CAPTURABLE';
      readonly operationId: string;
      /** Stable machine-readable reason (see NOT_CAPTURABLE_REASONS). */
      readonly reason: string;
      /** The operation's current durable status at decision time, when known. */
      readonly currentStatus?: CommerceOperationStatus;
      /** Safe, sanitized detail (no secrets). */
      readonly message?: string;
    };

/** Terminal outcome of reconcileCapture(). */
export type ReconcileOutcome =
  | {
      readonly kind: 'RESOLVED_COMPLETED';
      readonly operationId: string;
      readonly paymentResult: PaymentResult;
    }
  | {
      readonly kind: 'RESOLVED_FAILED';
      readonly operationId: string;
      readonly paymentResult: PaymentResult;
    }
  | {
      readonly kind: 'UNRESOLVED';
      readonly operationId: string;
      /** Safe, sanitized reason why no trustworthy conclusion exists. */
      readonly message: string;
    }
  | {
      readonly kind: 'NOT_RECONCILABLE';
      readonly operationId: string;
      /** Stable machine-readable reason (see NOT_RECONCILABLE_REASONS). */
      readonly reason: string;
      readonly currentStatus?: CommerceOperationStatus;
    };

/** Result of persistKnownCaptureResult() recovery. */
export type CaptureRecoveryResult =
  | {
      readonly kind: 'RECOVERED';
      readonly operationId: string;
      readonly paymentResult: PaymentResult;
    }
  | {
      readonly kind: 'ALREADY_RECOVERED';
      readonly operationId: string;
      /** The capture evidence already persisted (idempotent no-op). */
      readonly paymentResult: PaymentResult;
    }
  | {
      readonly kind: 'RECOVERY_NOT_APPLICABLE';
      readonly operationId: string;
      /** Stable machine-readable reason (see RECOVERY_NOT_APPLICABLE_REASONS). */
      readonly reason: string;
    };

/**
 * Stable machine-readable reasons for NOT_CAPTURABLE outcomes.
 * These strings are part of the orchestrator's public surface.
 */
export const NOT_CAPTURABLE_REASONS = {
  OPERATION_NOT_FOUND: 'OPERATION_NOT_FOUND',
  NOT_IN_ORDER_CREATED_STATE: 'NOT_IN_ORDER_CREATED_STATE',
  MISSING_PERSISTED_PAYPAL_ORDER: 'MISSING_PERSISTED_PAYPAL_ORDER',
  MISSING_DECISION_DATA: 'MISSING_DECISION_DATA',
  ALREADY_CAPTURING: 'ALREADY_CAPTURING',
  ALREADY_RESOLVED: 'ALREADY_RESOLVED',
  APPROVAL_UNVERIFIED: 'APPROVAL_UNVERIFIED',
  BUYER_NOT_APPROVED: 'BUYER_NOT_APPROVED',
  ALREADY_CAPTURED_REMOTELY: 'ALREADY_CAPTURED_REMOTELY',
} as const;

/** Stable machine-readable reasons for NOT_RECONCILABLE outcomes. */
export const NOT_RECONCILABLE_REASONS = {
  OPERATION_NOT_FOUND: 'OPERATION_NOT_FOUND',
  NOT_CAPTURING: 'NOT_CAPTURING',
  MISSING_PERSISTED_PAYPAL_ORDER: 'MISSING_PERSISTED_PAYPAL_ORDER',
  MISSING_DECISION_DATA: 'MISSING_DECISION_DATA',
} as const;

/** Stable machine-readable reasons for RECOVERY_NOT_APPLICABLE outcomes. */
export const RECOVERY_NOT_APPLICABLE_REASONS = {
  OPERATION_NOT_FOUND: 'OPERATION_NOT_FOUND',
  WRONG_PAYPAL_ORDER: 'WRONG_PAYPAL_ORDER',
  NOT_A_COMPLETED_CAPTURE: 'NOT_A_COMPLETED_CAPTURE',
  MISSING_DECISION_DATA: 'MISSING_DECISION_DATA',
  CAPTURE_EVIDENCE_INTEGRITY_FAULT: 'CAPTURE_EVIDENCE_INTEGRITY_FAULT',
  OPERATION_NOT_CAPTURING: 'OPERATION_NOT_CAPTURING',
  CAPTURE_EVIDENCE_CONFLICT: 'CAPTURE_EVIDENCE_CONFLICT',
} as const;

/**
 * PayPal error names that constitute POSITIVE evidence of a PRIOR successful
 * capture (the order was already captured — never mark FAILED; route to
 * reconciliation). Kept minimal: only names attested by this repository's
 * PayPal boundary tests. Unknown names are NOT added here.
 */
const PRIOR_CAPTURE_ERROR_NAMES: readonly string[] = ['ORDER_ALREADY_CAPTURED'];

/** Constructor dependencies for CaptureOrchestrator. */
export interface CaptureOrchestratorOptions {
  /**
   * Durable store. applyOperationEvent() is the only write path used;
   * getOperation() is read-only. Structural so tests can inject focused
   * fakes; CommerceOperationStore satisfies it directly.
   */
  readonly store: Pick<
    CommerceOperationStore,
    'getOperation' | 'applyOperationEvent'
  >;
  /** PayPal execution boundary (PayPalService or a test fake). */
  readonly paypal: PayPalCaptureExecutor;
  /** Injectable clock for deterministic tests. Defaults to () => new Date(). */
  readonly now?: CommerceExecutionClock;
}

/* ------------------------------------------------------------------ */
/* Secret hygiene (defense in depth; mirrors the CP3 orchestrator)     */
/* ------------------------------------------------------------------ */

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
 * Safe description of a capture/get-order failure. Uses the typed PayPal
 * error model: error name and HTTP status are safe and useful; error.message
 * is already secret-free by the PayPal boundary's contract and is additionally
 * scrubbed as defense in depth. Non-PayPal shapes are reduced to
 * name + message, scrubbed. Never includes raw provider bodies or headers.
 */
function describePayPalFailure(error: unknown): { message: string } {
  if (error instanceof Error && typeof error.name === 'string') {
    const isPayPalBoundaryError = error.name.startsWith('PayPal');
    const raw = isPayPalBoundaryError
      ? error.message
      : `${error.name}: ${error.message}`;
    return { message: sanitizeMessage(raw) };
  }
  return { message: 'PayPal call failed with an unrecognized error' };
}

/** True for a definite pre-outcome HTTP rejection (4xx) from PayPal. */
function isDefiniteHttpRejection(error: unknown): error is PayPalHttpApiError {
  return (
    error instanceof PayPalHttpApiError &&
    typeof error.status === 'number' &&
    error.status >= 400 &&
    error.status < 500
  );
}

/** True when the error name attests a PRIOR successful capture remotely. */
function isPriorCaptureEvidence(error: unknown): boolean {
  return (
    error instanceof PayPalHttpApiError &&
    typeof error.paypalErrorName === 'string' &&
    PRIOR_CAPTURE_ERROR_NAMES.includes(error.paypalErrorName)
  );
}

/**
 * True for failures where THIS capture attempt provably produced no remote
 * side effect:
 * - PayPalInvalidRequestError: pre-HTTP local validation, no call made.
 * - PayPalConfigurationError / PayPalAuthenticationError: the OAuth token is
 *   acquired BEFORE the capture POST, so no capture request was sent.
 */
function isNoSideEffectFailure(error: unknown): boolean {
  return (
    error instanceof PayPalInvalidRequestError ||
    error instanceof PayPalConfigurationError ||
    error instanceof PayPalAuthenticationError
  );
}

/* ------------------------------------------------------------------ */
/* Orchestrator                                                        */
/* ------------------------------------------------------------------ */

const DEFAULT_NOW: CommerceExecutionClock = () => new Date();

export class CaptureOrchestrator {
  readonly #store: CaptureOrchestratorOptions['store'];
  readonly #paypal: PayPalCaptureExecutor;
  readonly #now: CommerceExecutionClock;

  constructor(options: CaptureOrchestratorOptions) {
    this.#store = options.store;
    this.#paypal = options.paypal;
    this.#now = options.now ?? DEFAULT_NOW;
  }

  /* -------------------------------------------------------------- */
  /* captureApprovedOrder                                            */
  /* -------------------------------------------------------------- */

  /**
   * Capture a PAYPAL_ORDER_CREATED operation whose PayPal buyer approval is
   * verified against PayPal read state immediately before the durable claim:
   *
   *   load → guards (zero PayPal calls) → getOrder() buyer-approval
   *   verification → durable CAPTURE_STARTED claim (single-flight gate)
   *   → exactly ONE captureOrder() → durable evidence-checked outcome.
   *
   * Expected outcomes are returned as typed results, never thrown. The one
   * deliberate throw path: a genuine store persistence failure while claiming
   * propagates as-is, because the only safe continuation is to abort with
   * ZERO PayPal calls.
   */
  async captureApprovedOrder(operationId: string): Promise<CaptureOutcome> {
    // 1. Load the durable operation.
    const operation = this.#store.getOperation(operationId);
    if (operation === undefined) {
      return this.#notCapturable(
        operationId,
        NOT_CAPTURABLE_REASONS.OPERATION_NOT_FOUND
      );
    }

    // 2. Durable status guards — all short-circuit with ZERO PayPal calls.
    if (operation.status === 'CAPTURE_EXECUTING') {
      // Another invocation (possibly another worker) already holds the claim.
      return this.#notCapturable(
        operationId,
        NOT_CAPTURABLE_REASONS.ALREADY_CAPTURING,
        operation.status
      );
    }
    if (
      operation.status === 'COMPLETED' ||
      operation.status === 'FAILED' ||
      operation.status === 'OUTCOME_RECORDED'
    ) {
      return this.#notCapturable(
        operationId,
        NOT_CAPTURABLE_REASONS.ALREADY_RESOLVED,
        operation.status
      );
    }
    if (operation.status !== 'PAYPAL_ORDER_CREATED') {
      return this.#notCapturable(
        operationId,
        NOT_CAPTURABLE_REASONS.NOT_IN_ORDER_CREATED_STATE,
        operation.status
      );
    }

    // 3. The capture target comes ONLY from durable state. There is no
    //    parameter that could redirect the capture at a foreign order.
    const persistedOrder = operation.paypalOrder;
    if (persistedOrder === undefined) {
      // Schema-valid but integrity-broken snapshot (the CAPTURE_STARTED domain
      // guard would also reject the claim). Surface it; call nothing.
      return this.#notCapturable(
        operationId,
        NOT_CAPTURABLE_REASONS.MISSING_PERSISTED_PAYPAL_ORDER,
        operation.status
      );
    }
    // Decision data is required for capture-evidence integrity checks
    // (amount/currency). Never invent data; verify before any PayPal call.
    const decision = operation.decision;
    if (decision === undefined) {
      return this.#notCapturable(
        operationId,
        NOT_CAPTURABLE_REASONS.MISSING_DECISION_DATA,
        operation.status
      );
    }

    // 4–5. Verify PayPal buyer approval from PROVIDER read state BEFORE the
    // claim. Owner approval (approvalStatus), policy results, browser
    // callbacks, and caller-supplied booleans are never consulted.
    let read: PayPalGetOrderResult;
    try {
      read = await this.#paypal.getOrder({
        paypalOrderId: persistedOrder.paypalOrderId,
      });
    } catch (error) {
      // Buyer approval cannot be verified: zero capture calls, no claim.
      const description = describePayPalFailure(error);
      return this.#notCapturable(
        operationId,
        NOT_CAPTURABLE_REASONS.APPROVAL_UNVERIFIED,
        operation.status,
        `PayPal buyer approval could not be verified (${description.message})`
      );
    }
    if (read.paypalOrderId !== persistedOrder.paypalOrderId) {
      // The read does not even correspond to our order: verification impossible.
      return this.#notCapturable(
        operationId,
        NOT_CAPTURABLE_REASONS.APPROVAL_UNVERIFIED,
        operation.status,
        'get-order returned a different PayPal order ID than the persisted order'
      );
    }
    if (read.orderStatus === 'COMPLETED') {
      // Already captured remotely — route to reconciliation, never capture.
      return this.#notCapturable(
        operationId,
        NOT_CAPTURABLE_REASONS.ALREADY_CAPTURED_REMOTELY,
        operation.status,
        'PayPal reports the order COMPLETED (already captured); run reconcileCapture()'
      );
    }
    if (read.orderStatus !== 'APPROVED') {
      // PayPal buyer approval not established (e.g. CREATED): never capture.
      return this.#notCapturable(
        operationId,
        NOT_CAPTURABLE_REASONS.BUYER_NOT_APPROVED,
        operation.status,
        `PayPal order status ${read.orderStatus} is not APPROVED (buyer approval not established)`
      );
    }

    // 6. CLAIM CAPTURE DURABLY. This transaction is the authoritative
    //    single-flight gate: the invocation whose CAPTURE_STARTED commits owns
    //    the capture network call. A stale pre-read grants nothing.
    let claim: AppliedOperationEvent;
    try {
      claim = this.#store.applyOperationEvent(
        operationId,
        { type: 'CAPTURE_STARTED' },
        this.#now()
      );
    } catch (error) {
      // Most likely a concurrent invocation committed the claim first (the
      // durable state rejects a duplicate claim transition). Re-read durably
      // to distinguish a lost race from a genuine persistence fault: a
      // competitor that already reached a terminal status is ALREADY_RESOLVED,
      // not a store error.
      const current = this.#readCurrent(operationId);
      if (current !== undefined) {
        if (current.status === 'CAPTURE_EXECUTING') {
          return this.#notCapturable(
            operationId,
            NOT_CAPTURABLE_REASONS.ALREADY_CAPTURING,
            current.status
          );
        }
        if (
          current.status === 'COMPLETED' ||
          current.status === 'FAILED' ||
          current.status === 'OUTCOME_RECORDED'
        ) {
          return this.#notCapturable(
            operationId,
            NOT_CAPTURABLE_REASONS.ALREADY_RESOLVED,
            current.status
          );
        }
      }
      // Genuine store failure (or unreadable state): abort with ZERO PayPal
      // calls.
      throw error;
    }
    if (claim.newStatus !== 'CAPTURE_EXECUTING') {
      // Defensive: the state machine guarantees CAPTURE_EXECUTING from
      // PAYPAL_ORDER_CREATED, so anything else means the race was lost in a
      // way the catch above did not observe. Do not call PayPal.
      return this.#notCapturable(
        operationId,
        NOT_CAPTURABLE_REASONS.ALREADY_CAPTURING,
        claim.newStatus
      );
    }

    // 7. The claim winner alone calls captureOrder — exactly ONE attempt,
    //    with the deterministic capture-specific request ID. No retry.
    const requestId = payPalCaptureRequestIdForOperation(operationId);
    let captureResult: PayPalCaptureOrderResult;
    try {
      captureResult = await this.#paypal.captureOrder({
        paypalOrderId: persistedOrder.paypalOrderId,
        requestId,
      });
    } catch (error) {
      return await this.#classifyCaptureFailure(operationId, error);
    }

    // 8. Classify the successful-transport capture result with full
    //    integrity checks before any durable outcome.
    return this.#resolveCaptureResult(operationId, decision, captureResult);
  }

  /* -------------------------------------------------------------- */
  /* reconcileCapture                                                */
  /* -------------------------------------------------------------- */

  /**
   * Reconcile a CAPTURE_EXECUTING operation using getOrder() ONLY. Never
   * calls captureOrder, never automatically re-captures.
   *
   * Resolution requires positive evidence:
   * - RESOLVED_COMPLETED: matching order, capture.status === 'COMPLETED',
   *   amount/currency integrity vs the persisted decision, captureId present.
   * - RESOLVED_FAILED: matching DECLINED capture (equally positive evidence
   *   that funds were not captured), with the same integrity checks.
   * - UNRESOLVED: zero captures, PENDING capture, CREATED/APPROVED order
   *   without capture evidence, transport/HTTP/malformed read failures,
   *   multiple captures, or any evidence whose meaning is uncertain. The
   *   durable operation remains CAPTURE_EXECUTING.
   */
  async reconcileCapture(operationId: string): Promise<ReconcileOutcome> {
    const operation = this.#store.getOperation(operationId);
    if (operation === undefined) {
      return {
        kind: 'NOT_RECONCILABLE',
        operationId,
        reason: NOT_RECONCILABLE_REASONS.OPERATION_NOT_FOUND,
      };
    }
    if (operation.status !== 'CAPTURE_EXECUTING') {
      return {
        kind: 'NOT_RECONCILABLE',
        operationId,
        reason: NOT_RECONCILABLE_REASONS.NOT_CAPTURING,
        currentStatus: operation.status,
      };
    }
    const persistedOrder = operation.paypalOrder;
    if (persistedOrder === undefined) {
      return {
        kind: 'NOT_RECONCILABLE',
        operationId,
        reason: NOT_RECONCILABLE_REASONS.MISSING_PERSISTED_PAYPAL_ORDER,
        currentStatus: operation.status,
      };
    }
    if (operation.decision === undefined) {
      return {
        kind: 'NOT_RECONCILABLE',
        operationId,
        reason: NOT_RECONCILABLE_REASONS.MISSING_DECISION_DATA,
        currentStatus: operation.status,
      };
    }

    try {
      return await this.#resolveFromOrderRead(operationId, operation.decision, persistedOrder.paypalOrderId);
    } catch (error) {
      // The reconciliation READ itself failed (transport/HTTP/malformed).
      // No conclusion → the operation stays CAPTURE_EXECUTING.
      const description = describePayPalFailure(error);
      return {
        kind: 'UNRESOLVED',
        operationId,
        message: `PayPal read state could not be obtained (${description.message}); the operation remains CAPTURE_EXECUTING`,
      };
    }
  }

  /* -------------------------------------------------------------- */
  /* persistKnownCaptureResult (post-capture persistence recovery)   */
  /* -------------------------------------------------------------- */

  /**
   * Explicit recovery for CAPTURE_RECOVERY_REQUIRED (remote capture known
   * successful, local PAYMENT_COMPLETED persistence failed).
   *
   * Persists an ALREADY-SUCCESSFUL normalized capture result. It NEVER calls
   * PayPal, never performs another capture, and is deterministically safe to
   * repeat:
   *   - operation missing → refused (OPERATION_NOT_FOUND)
   *   - result tied to a different PayPal order → refused (WRONG_PAYPAL_ORDER)
   *   - capture.status !== 'COMPLETED' → refused (NOT_A_COMPLETED_CAPTURE)
   *   - amount/currency/captureId integrity fault → refused
   *     (CAPTURE_EVIDENCE_INTEGRITY_FAULT / MISSING_DECISION_DATA)
   *   - already COMPLETED with the SAME capture evidence → idempotent
   *     no-op (ALREADY_RECOVERED)
   *   - already COMPLETED with DIFFERENT capture evidence → refused
   *     (CAPTURE_EVIDENCE_CONFLICT)
   *   - otherwise only while CAPTURE_EXECUTING → persists exactly once
   *     (RECOVERED); any other status → refused (OPERATION_NOT_CAPTURING)
   */
  persistKnownCaptureResult(
    operationId: string,
    result: PayPalCaptureOrderResult
  ): CaptureRecoveryResult {
    const operation = this.#store.getOperation(operationId);
    if (operation === undefined) {
      return {
        kind: 'RECOVERY_NOT_APPLICABLE',
        operationId,
        reason: RECOVERY_NOT_APPLICABLE_REASONS.OPERATION_NOT_FOUND,
      };
    }

    // The known result must belong to the operation's own persisted order.
    if (
      operation.paypalOrder === undefined ||
      result.paypalOrderId !== operation.paypalOrder.paypalOrderId
    ) {
      return {
        kind: 'RECOVERY_NOT_APPLICABLE',
        operationId,
        reason: RECOVERY_NOT_APPLICABLE_REASONS.WRONG_PAYPAL_ORDER,
      };
    }

    // Only a positively-completed capture may be recovered as success.
    if (result.capture.status !== 'COMPLETED') {
      return {
        kind: 'RECOVERY_NOT_APPLICABLE',
        operationId,
        reason: RECOVERY_NOT_APPLICABLE_REASONS.NOT_A_COMPLETED_CAPTURE,
      };
    }

    // Integrity vs the persisted approved decision.
    const decision = operation.decision;
    if (decision === undefined) {
      return {
        kind: 'RECOVERY_NOT_APPLICABLE',
        operationId,
        reason: RECOVERY_NOT_APPLICABLE_REASONS.MISSING_DECISION_DATA,
      };
    }
    const paymentResult = buildCompletedPaymentResult(
      result.paypalOrderId,
      result.capture,
      decision.amount,
      decision.currency
    );
    if (paymentResult === undefined) {
      return {
        kind: 'RECOVERY_NOT_APPLICABLE',
        operationId,
        reason: RECOVERY_NOT_APPLICABLE_REASONS.CAPTURE_EVIDENCE_INTEGRITY_FAULT,
      };
    }

    // Idempotent repeat (same evidence) vs conflicting evidence, checked
    // before the status guard so repeats after successful recovery are
    // deterministic no-ops rather than misleading refusals.
    if (operation.status === 'COMPLETED') {
      const existing = operation.paymentResult;
      if (
        existing !== undefined &&
        existing.captureId === paymentResult.captureId &&
        existing.transactionId === paymentResult.transactionId &&
        existing.paypalOrderId === paymentResult.paypalOrderId
      ) {
        return { kind: 'ALREADY_RECOVERED', operationId, paymentResult: existing };
      }
      return {
        kind: 'RECOVERY_NOT_APPLICABLE',
        operationId,
        reason: RECOVERY_NOT_APPLICABLE_REASONS.CAPTURE_EVIDENCE_CONFLICT,
      };
    }

    if (operation.status !== 'CAPTURE_EXECUTING') {
      return {
        kind: 'RECOVERY_NOT_APPLICABLE',
        operationId,
        reason: `OPERATION_NOT_CAPTURING (status: ${operation.status})`,
      };
    }

    try {
      this.#store.applyOperationEvent(
        operationId,
        { type: 'PAYMENT_COMPLETED', paymentResult },
        this.#now()
      );
    } catch (error) {
      throw new Error(
        `Failed to persist recovered PAYMENT_COMPLETED for operation ${operationId}: ` +
          (error instanceof Error ? sanitizeMessage(error.message) : 'unknown store error')
      );
    }
    return { kind: 'RECOVERED', operationId, paymentResult };
  }

  /* -------------------------------------------------------------- */
  /* Internal classification helpers                                 */
  /* -------------------------------------------------------------- */

  /**
   * Classify a captureOrder() failure AFTER the durable claim. The durable
   * operation is CAPTURE_EXECUTING here; a durable FAILED outcome is only
   * possible with declined-capture evidence (the domain state machine
   * requires transactionId/captureId + matching paypalOrderId for outcomes
   * from CAPTURE_EXECUTING), so failures without capture evidence leave the
   * operation CAPTURE_EXECUTING and are reported truthfully to the caller.
   */
  async #classifyCaptureFailure(
    operationId: string,
    error: unknown
  ): Promise<CaptureOutcome> {
    // 1. Prior-capture evidence (e.g. ORDER_ALREADY_CAPTURED): positive proof
    //    the order was already captured — NEVER mark FAILED. Route to
    //    reconciliation (getOrder only) and resolve from its evidence.
    if (isPriorCaptureEvidence(error)) {
      return await this.#reconcileAfterClaim(operationId);
    }

    // 2. Definite PayPal HTTP rejection (4xx): PayPal refused THIS capture
    //    request, so it did not succeed. No capture evidence exists (the
    //    typed 4xx carries no capture object), so a durable FAILED outcome is
    //    not possible; the operation remains CAPTURE_EXECUTING for explicit
    //    resolution while the caller learns the truth.
    if (isDefiniteHttpRejection(error)) {
      return {
        kind: 'CAPTURE_FAILED',
        operationId,
        message:
          `PayPal definitely rejected the capture request (HTTP ${error.status}` +
          `${error.paypalErrorName !== undefined ? ` ${error.paypalErrorName}` : ''}); ` +
          'the capture did not succeed. The durable operation remains CAPTURE_EXECUTING ' +
          'because a durable FAILED outcome requires declined-capture evidence; ' +
          'resolve via reconcileCapture() or explicitly.',
      };
    }

    // 3. No-side-effect failures (pre-HTTP validation, OAuth/config before
    //    the capture POST): this attempt captured nothing, but the same
    //    domain evidence rule applies — the operation remains
    //    CAPTURE_EXECUTING; the caller learns the attempt failed.
    if (isNoSideEffectFailure(error)) {
      const description = describePayPalFailure(error);
      return {
        kind: 'CAPTURE_FAILED',
        operationId,
        message:
          `The capture attempt failed before any capture request was sent (${description.message}). ` +
          'The durable operation remains CAPTURE_EXECUTING because a durable FAILED outcome ' +
          'requires declined-capture evidence; resolve explicitly.',
      };
    }

    // 4. Transport ambiguity (HTTP status undefined), 5xx, malformed 2xx and
    //    every unrecognized error shape: the remote outcome is UNKNOWN.
    //    Stay CAPTURE_EXECUTING; reconcile via getOrder. Never FAILED.
    const description = describePayPalFailure(error);
    return {
      kind: 'CAPTURE_AMBIGUOUS',
      operationId,
      message:
        `PayPal capture outcome is unknown (${description.message}); ` +
        'the operation remains CAPTURE_EXECUTING — run reconcileCapture()',
    };
  }

  /**
   * Classify a captureOrder() 2xx result. Integrity is checked BEFORE any
   * durable outcome; evidence mismatches never become COMPLETED or FAILED.
   */
  #resolveCaptureResult(
    operationId: string,
    decision: CommerceOperation['decision'] & {},
    captureResult: PayPalCaptureOrderResult
  ): CaptureOutcome {
    // The echoed order must be our own persisted order (foreign-order guard).
    const persistedOrderId = this.#store.getOperation(operationId)?.paypalOrder
      ?.paypalOrderId;
    if (
      persistedOrderId === undefined ||
      captureResult.paypalOrderId !== persistedOrderId
    ) {
      return {
        kind: 'CAPTURE_INTEGRITY_FAULT',
        operationId,
        captureResult,
        message:
          'Capture result is tied to a different PayPal order than the persisted order; ' +
          'the operation remains CAPTURE_EXECUTING for manual resolution',
      };
    }

    const capture = captureResult.capture;

    if (capture.status === 'COMPLETED') {
      const paymentResult = buildCompletedPaymentResult(
        captureResult.paypalOrderId,
        capture,
        decision.amount,
        decision.currency
      );
      if (paymentResult === undefined) {
        // Wrong thing captured (amount/currency/captureId mismatch): never
        // COMPLETED, never FAILED — surface for human handling.
        return {
          kind: 'CAPTURE_INTEGRITY_FAULT',
          operationId,
          captureResult,
          message:
            'Capture evidence fails integrity checks against the persisted decision ' +
            '(captureId/amount/currency); the operation remains CAPTURE_EXECUTING ' +
            'for human resolution',
        };
      }
      try {
        this.#store.applyOperationEvent(
          operationId,
          { type: 'PAYMENT_COMPLETED', paymentResult },
          this.#now()
        );
      } catch {
        // PayPal succeeded but local persistence failed. Do NOT retry the
        // capture, do NOT mark FAILED, do NOT hide the error: return the known
        // result for local recovery. Durable status stays CAPTURE_EXECUTING.
        return {
          kind: 'CAPTURE_RECOVERY_REQUIRED',
          operationId,
          captureResult,
          message:
            'PayPal capture succeeded, but persisting PAYMENT_COMPLETED failed. ' +
            'The operation remains CAPTURE_EXECUTING. Recover with ' +
            'persistKnownCaptureResult() (zero PayPal calls). Never re-capture.',
        };
      }
      return { kind: 'CAPTURE_COMPLETED', operationId, paymentResult };
    }

    if (capture.status === 'DECLINED' && capture.captureId.length > 0) {
      // Positive evidence this capture did not succeed (a recorded declined
      // capture). The domain requires capture evidence for a durable outcome
      // from CAPTURE_EXECUTING — a declined capture provides it.
      const paymentResult: PaymentResult = {
        success: false,
        transactionId: capture.captureId,
        captureId: capture.captureId,
        paypalOrderId: captureResult.paypalOrderId,
        amount: capture.amountMinorUnits,
        currency: capture.currency,
        errorMessage: 'PayPal declined the capture (capture status DECLINED)',
      };
      try {
        this.#store.applyOperationEvent(
          operationId,
          { type: 'PAYMENT_FAILED', paymentResult },
          this.#now()
        );
      } catch {
        // Remote decline known, durable failure not persisted: stay
        // CAPTURE_EXECUTING; a later reconcileCapture() resolves it from the
        // persisted declined capture.
        return {
          kind: 'CAPTURE_AMBIGUOUS',
          operationId,
          message:
            'PayPal reported a declined capture, but persisting PAYMENT_FAILED failed; ' +
            'the operation remains CAPTURE_EXECUTING — run reconcileCapture()',
        };
      }
      return {
        kind: 'CAPTURE_FAILED',
        operationId,
        message: 'PayPal declined the capture (capture status DECLINED)',
      };
    }

    // Any other capture status (e.g. PENDING) is not a trustworthy conclusion:
    // stay CAPTURE_EXECUTING and reconcile later.
    return {
      kind: 'CAPTURE_AMBIGUOUS',
      operationId,
      message:
        `PayPal reported capture status ${capture.status}; this is not a definitive ` +
        'outcome — the operation remains CAPTURE_EXECUTING — run reconcileCapture()',
    };
  }

  /**
   * Reconciliation triggered from captureApprovedOrder after prior-capture
   * evidence (maps ReconcileOutcome onto CaptureOutcome leaves).
   */
  async #reconcileAfterClaim(operationId: string): Promise<CaptureOutcome> {
    const operation = this.#readCurrent(operationId);
    const decision = operation?.decision;
    const persistedOrderId = operation?.paypalOrder?.paypalOrderId;
    if (operation === undefined || decision === undefined || persistedOrderId === undefined) {
      return {
        kind: 'CAPTURE_AMBIGUOUS',
        operationId,
        message:
          'PayPal indicated a prior capture, but durable state is incomplete; ' +
          'the operation remains CAPTURE_EXECUTING — run reconcileCapture()',
      };
    }
    const reconciliation = await this.#resolveFromOrderRead(
      operationId,
      decision,
      persistedOrderId
    );
    switch (reconciliation.kind) {
      case 'RESOLVED_COMPLETED':
        return {
          kind: 'CAPTURE_COMPLETED',
          operationId,
          paymentResult: reconciliation.paymentResult,
        };
      case 'RESOLVED_FAILED':
        return {
          kind: 'CAPTURE_FAILED',
          operationId,
          message:
            reconciliation.paymentResult.errorMessage ??
            'PayPal capture did not succeed (resolved from PayPal read state)',
        };
      case 'UNRESOLVED':
        return {
          kind: 'CAPTURE_AMBIGUOUS',
          operationId,
          message: reconciliation.message,
        };
      case 'NOT_RECONCILABLE':
        return {
          kind: 'CAPTURE_AMBIGUOUS',
          operationId,
          message: `PayPal indicated a prior capture, but reconciliation is not applicable (${reconciliation.reason}); the operation remains CAPTURE_EXECUTING`,
        };
    }
  }

  /**
   * Shared getOrder()-based resolution: positive evidence only, full
   * integrity checks, persistence failures leave the operation
   * CAPTURE_EXECUTING. Throws when the read itself fails (callers translate
   * that to ambiguity / UNRESOLVED — never FAILED).
   */
  async #resolveFromOrderRead(
    operationId: string,
    decision: CommerceOperation['decision'] & {},
    persistedOrderId: string
  ): Promise<ReconcileOutcome> {
    const read = await this.#paypal.getOrder({ paypalOrderId: persistedOrderId });

    if (read.paypalOrderId !== persistedOrderId) {
      return {
        kind: 'UNRESOLVED',
        operationId,
        message:
          'get-order returned a different PayPal order ID than the persisted order; ' +
          'no trustworthy conclusion — the operation remains CAPTURE_EXECUTING',
      };
    }

    if (read.captures.length === 0) {
      // No capture evidence: NOT sufficient to conclude the capture did not
      // happen (conservative; read models may lag). Stay unresolved.
      return {
        kind: 'UNRESOLVED',
        operationId,
        message:
          `PayPal order status ${read.orderStatus} carries no capture evidence; ` +
          'absence of a capture is not proof the capture did not happen — ' +
          'the operation remains CAPTURE_EXECUTING',
      };
    }
    if (read.captures.length > 1) {
      return {
        kind: 'UNRESOLVED',
        operationId,
        message:
          'PayPal reports multiple captures for this order; this is not a ' +
          'trustworthy single-capture conclusion — the operation remains CAPTURE_EXECUTING',
      };
    }

    const capture = read.captures[0];

    if (capture.status === 'COMPLETED') {
      const paymentResult = buildCompletedPaymentResult(
        read.paypalOrderId,
        capture,
        decision.amount,
        decision.currency
      );
      if (paymentResult === undefined) {
        return {
          kind: 'UNRESOLVED',
          operationId,
          message:
            'A completed capture is reported but its evidence fails integrity checks ' +
            'against the persisted decision (captureId/amount/currency); the operation ' +
            'remains CAPTURE_EXECUTING for human resolution',
        };
      }
      try {
        this.#store.applyOperationEvent(
          operationId,
          { type: 'PAYMENT_COMPLETED', paymentResult },
          this.#now()
        );
      } catch {
        return {
          kind: 'UNRESOLVED',
          operationId,
          message:
            'Capture evidence proves completion, but persisting PAYMENT_COMPLETED failed; ' +
            'the operation remains CAPTURE_EXECUTING — retry reconcileCapture()',
        };
      }
      return { kind: 'RESOLVED_COMPLETED', operationId, paymentResult };
    }

    if (capture.status === 'DECLINED' && capture.captureId.length > 0) {
      // A recorded declined capture is positive evidence funds were NOT
      // captured. Integrity still applies before persisting the failure.
      if (
        capture.amountMinorUnits !== decision.amount ||
        capture.currency !== decision.currency
      ) {
        return {
          kind: 'UNRESOLVED',
          operationId,
          message:
            'A declined capture is reported but its evidence fails integrity checks ' +
            'against the persisted decision (amount/currency); the operation remains ' +
            'CAPTURE_EXECUTING for human resolution',
        };
      }
      const paymentResult: PaymentResult = {
        success: false,
        transactionId: capture.captureId,
        captureId: capture.captureId,
        paypalOrderId: read.paypalOrderId,
        amount: capture.amountMinorUnits,
        currency: capture.currency,
        errorMessage: 'PayPal declined the capture (capture status DECLINED)',
      };
      try {
        this.#store.applyOperationEvent(
          operationId,
          { type: 'PAYMENT_FAILED', paymentResult },
          this.#now()
        );
      } catch {
        return {
          kind: 'UNRESOLVED',
          operationId,
          message:
            'A declined capture proves the capture did not succeed, but persisting ' +
            'PAYMENT_FAILED failed; the operation remains CAPTURE_EXECUTING — retry reconcileCapture()',
        };
      }
      return { kind: 'RESOLVED_FAILED', operationId, paymentResult };
    }

    // PENDING or unrecognized capture status: no trustworthy conclusion.
    return {
      kind: 'UNRESOLVED',
      operationId,
      message:
        `PayPal reports capture status ${capture.status}; this is not a definitive ` +
        'outcome — the operation remains CAPTURE_EXECUTING',
    };
  }

  #notCapturable(
    operationId: string,
    reason: string,
    currentStatus?: CommerceOperationStatus,
    message?: string
  ): CaptureOutcome {
    return {
      kind: 'NOT_CAPTURABLE',
      operationId,
      reason,
      ...(currentStatus !== undefined ? { currentStatus } : {}),
      ...(message !== undefined ? { message } : {}),
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

/**
 * Build the truthful PaymentResult for a COMPLETED capture — or undefined
 * when the evidence fails integrity against the approved decision
 * (captureId empty, amount mismatch, or currency mismatch).
 *
 * Mapping (Task 09 CP4): captureId → transactionId AND captureId;
 * paypalOrderId → paypalOrderId; amountMinorUnits → amount;
 * currency → currency; success → true.
 */
function buildCompletedPaymentResult(
  paypalOrderId: string,
  capture: PayPalCaptureOrderResult['capture'],
  approvedAmount: number,
  approvedCurrency: string
): PaymentResult | undefined {
  if (capture.captureId.length === 0) {
    return undefined;
  }
  if (capture.amountMinorUnits !== approvedAmount) {
    return undefined;
  }
  if (capture.currency !== approvedCurrency) {
    return undefined;
  }
  return {
    success: true,
    transactionId: capture.captureId,
    captureId: capture.captureId,
    paypalOrderId,
    amount: capture.amountMinorUnits,
    currency: capture.currency,
  };
}
