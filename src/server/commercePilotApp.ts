/**
 * CommercePilot application-service boundary (Task 10, CP2-E).
 *
 * The SINGLE write-orchestration boundary between the future route handlers
 * (CP3/CP4) and the domain/orchestrators. The invariant it establishes:
 *
 *   ROUTES MUST NOT APPLY ARBITRARY DOMAIN EVENTS DIRECTLY.
 *
 * Every durable state change flows through named, intention-revealing use
 * cases here; each one applies exactly the domain events that use case owns,
 * via CommerceOperationStore.applyOperationEvent() — the only write path.
 * Route handlers will receive this application (or a narrow slice of it) from
 * the composition root and MUST NOT construct or apply raw events themselves.
 *
 * Read operations are pass-throughs to the store (no caching, no reshaping).
 *
 * No policy logic, no state-machine logic, no direct PayPal calls here: the
 * policy engine, the state machine, and the orchestrators remain the sole
 * authorities for their concerns.
 */

import type { CommerceDecision, CommerceOperation } from '../domain/schemas';
import type {
  OperationAuditEntry,
  AppliedOperationEvent,
  CommerceOperationStore,
} from '../store';
import type {
  CommerceExecutionOutcome,
  CaptureOutcome,
  ReconcileOutcome,
} from '../orchestrator';
import { evaluatePolicy } from '../policy/evaluatePolicy';
import { validatedSyntheticPolicyConfig } from '../policy/policyConfig';
import {
  SyntheticDecisionProposer,
  SyntheticDecisionProposerError,
  type DecisionProposer,
} from './syntheticDecisionProposer';

/** Error raised when an application use case cannot proceed. */
export class CommercePilotApplicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommercePilotApplicationError';
  }
}

/** Minimal store surface this application depends on (structural, testable). */
export interface CommercePilotStoreLike {
  createOperation(
    operationId: string,
    opportunityId: string,
    timestamp: Date
  ): CommerceOperation;
  getOperation(operationId: string): CommerceOperation | undefined;
  listOperations(): CommerceOperation[];
  getAuditTrail(operationId: string): OperationAuditEntry[];
  applyOperationEvent(
    operationId: string,
    event: Parameters<CommerceOperationStore['applyOperationEvent']>[1],
    timestamp: Date
  ): AppliedOperationEvent;
}

/**
 * Execution boundary (CommerceExecutionOrchestrator or a test fake).
 * Optional: injected when execution/capture use cases are needed. When
 * absent, the corresponding use cases fail with a clear configuration error
 * rather than attempting direct event application.
 */
export interface ExecutionExecutorLike {
  executeApprovedOperation(operationId: string): Promise<CommerceExecutionOutcome>;
}

/** Capture boundary (CaptureOrchestrator or a test fake). */
export interface CaptureExecutorLike {
  captureApprovedOrder(operationId: string): Promise<CaptureOutcome>;
  reconcileCapture(operationId: string): Promise<ReconcileOutcome>;
}

/** Dependencies for CommercePilotApplication (all injectable for tests). */
export interface CommercePilotApplicationOptions {
  readonly store: CommercePilotStoreLike;
  /** Decision-proposal boundary (synthetic by default; LLM-backed later). */
  readonly decisionProposer?: DecisionProposer;
  /** Execution orchestrator for the execute use case (optional). */
  readonly execution?: ExecutionExecutorLike;
  /** Capture orchestrator for the capture/reconcile use cases (optional). */
  readonly capture?: CaptureExecutorLike;
  /** Injectable clock for deterministic tests. Defaults to () => new Date(). */
  readonly now?: () => Date;
  /** Override the generated operation ID (deterministic tests only). */
  readonly generateOperationId?: () => string;
}

/** Result of createOperationAwaitingApproval(). */
export type CreateOperationOutcome =
  | {
      readonly kind: 'AWAITING_HUMAN_APPROVAL';
      readonly operationId: string;
      readonly decision: CommerceDecision;
      readonly policyDecision: 'APPROVE' | 'ESCALATE';
    }
  | {
      readonly kind: 'POLICY_REJECTED';
      readonly operationId: string;
      readonly decision: CommerceDecision;
    };

/** Result of approveOperation()/rejectOperation(). */
export type HumanApprovalOutcome =
  | { readonly kind: 'APPROVED'; readonly operationId: string }
  | { readonly kind: 'REJECTED'; readonly operationId: string };

const DEFAULT_NOW = (): Date => new Date();
const DEFAULT_OPERATION_ID_PREFIX = 'op-';

function defaultGenerateOperationId(): string {
  return `${DEFAULT_OPERATION_ID_PREFIX}${crypto.randomUUID()}`;
}

/**
 * The application-service boundary. One method per named use case; every
 * write is a specific domain event (or a use-case-owned sequence) applied
 * through the store — never a raw ad-hoc event from a caller.
 */
export class CommercePilotApplication {
  readonly #store: CommercePilotStoreLike;
  readonly #decisionProposer: DecisionProposer;
  readonly #execution: ExecutionExecutorLike | undefined;
  readonly #capture: CaptureExecutorLike | undefined;
  readonly #now: () => Date;
  readonly #generateOperationId: () => string;

  constructor(options: CommercePilotApplicationOptions) {
    this.#store = options.store;
    this.#decisionProposer =
      options.decisionProposer ?? new SyntheticDecisionProposer();
    this.#execution = options.execution;
    this.#capture = options.capture;
    this.#now = options.now ?? DEFAULT_NOW;
    this.#generateOperationId =
      options.generateOperationId ?? defaultGenerateOperationId;
  }

  /* ---------------------------------------------------------------- */
  /* Use case: create operation → AI-propose → policy → human request */
  /* ---------------------------------------------------------------- */

  /**
   * Create a new operation for the opportunity and advance it through
   * decision proposal and policy evaluation:
   *
   *   OPPORTUNITY
   *     → DECISION_PROPOSED             (proposer's decision)
   *     → POLICY_APPROVED | POLICY_REJECTED | POLICY_ESCALATED
   *     → REQUEST_HUMAN_APPROVAL        (only when APPROVE or ESCALATE)
   *
   * The proposer is consulted BEFORE any durable state exists, so a proposer
   * failure for an unknown opportunity leaves nothing half-created.
   * Policy evaluation happens exactly once per operation, deterministically,
   * before any event is applied; the same PolicyResult is persisted.
   */
  async createOperationAwaitingApproval(
    opportunityId: string
  ): Promise<CreateOperationOutcome> {
    let decision: CommerceDecision;
    try {
      decision = await this.#decisionProposer.proposeDecision(opportunityId);
    } catch (error) {
      if (error instanceof SyntheticDecisionProposerError) {
        throw error;
      }
      throw new CommercePilotApplicationError(
        `Decision proposal failed for opportunity '${opportunityId}': ` +
          (error instanceof Error ? error.message : 'unknown proposer error')
      );
    }

    // Pure, deterministic policy evaluation (AI proposes → policy decides).
    const policyResult = evaluatePolicy(
      decision,
      validatedSyntheticPolicyConfig
    );

    const operationId = this.#generateOperationId();
    const now = this.#now();

    // Use-case-owned event sequence — the ONLY writes this use case makes.
    this.#store.createOperation(operationId, opportunityId, now);
    this.#store.applyOperationEvent(
      operationId,
      { type: 'DECISION_PROPOSED', decision },
      now
    );
    switch (policyResult.decision) {
      case 'APPROVE':
        this.#store.applyOperationEvent(
          operationId,
          { type: 'POLICY_APPROVED', policyResult },
          now
        );
        this.#store.applyOperationEvent(
          operationId,
          { type: 'REQUEST_HUMAN_APPROVAL' },
          now
        );
        return {
          kind: 'AWAITING_HUMAN_APPROVAL',
          operationId,
          decision,
          policyDecision: 'APPROVE',
        };
      case 'ESCALATE':
        this.#store.applyOperationEvent(
          operationId,
          { type: 'POLICY_ESCALATED', policyResult },
          now
        );
        this.#store.applyOperationEvent(
          operationId,
          { type: 'REQUEST_HUMAN_APPROVAL' },
          now
        );
        return {
          kind: 'AWAITING_HUMAN_APPROVAL',
          operationId,
          decision,
          policyDecision: 'ESCALATE',
        };
      case 'REJECT':
        // Terminal: NO REQUEST_HUMAN_APPROVAL ever follows a rejection.
        this.#store.applyOperationEvent(
          operationId,
          { type: 'POLICY_REJECTED', policyResult },
          now
        );
        return { kind: 'POLICY_REJECTED', operationId, decision };
      default: {
        const exhaustive: never = policyResult.decision;
        throw new CommercePilotApplicationError(
          `Policy engine returned an unrecognized decision: ${String(exhaustive)}`
        );
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Use case: human approval decisions                               */
  /* ---------------------------------------------------------------- */

  /** Record a human approval (HUMAN_APPROVED) on an awaiting operation. */
  approveOperation(operationId: string): HumanApprovalOutcome {
    this.#store.applyOperationEvent(
      operationId,
      { type: 'HUMAN_APPROVED', approvalStatus: 'APPROVED' },
      this.#now()
    );
    return { kind: 'APPROVED', operationId };
  }

  /** Record a human rejection (HUMAN_REJECTED) on an awaiting operation. */
  rejectOperation(operationId: string): HumanApprovalOutcome {
    this.#store.applyOperationEvent(
      operationId,
      { type: 'HUMAN_REJECTED', approvalStatus: 'REJECTED' },
      this.#now()
    );
    return { kind: 'REJECTED', operationId };
  }

  /* ---------------------------------------------------------------- */
  /* Use cases: execution + capture (delegating to orchestrators)     */
  /* ---------------------------------------------------------------- */

  /**
   * Execute an approved operation (durable claim → PayPal createOrder →
   * PAYPAL_ORDER_CREATED). Delegates ENTIRELY to the execution orchestrator;
   * this method applies no domain events itself.
   *
   * @throws CommercePilotApplicationError when no execution orchestrator
   *   was injected (use case unavailable in this composition).
   */
  async executeOperation(operationId: string): Promise<CommerceExecutionOutcome> {
    if (this.#execution === undefined) {
      throw new CommercePilotApplicationError(
        'executeOperation is unavailable: no execution orchestrator was provided to CommercePilotApplication'
      );
    }
    return this.#execution.executeApprovedOperation(operationId);
  }

  /**
   * Capture the funds of an operation with a persisted PayPal order.
   * Delegates ENTIRELY to the capture orchestrator; applies no events here.
   *
   * @throws CommercePilotApplicationError when no capture orchestrator
   *   was injected.
   */
  async captureOperation(operationId: string): Promise<CaptureOutcome> {
    if (this.#capture === undefined) {
      throw new CommercePilotApplicationError(
        'captureOperation is unavailable: no capture orchestrator was provided to CommercePilotApplication'
      );
    }
    return this.#capture.captureApprovedOrder(operationId);
  }

  /**
   * Reconcile an ambiguous capture from provider evidence. Delegates to the
   * capture orchestrator; applies no events here.
   *
   * @throws CommercePilotApplicationError when no capture orchestrator
   *   was injected.
   */
  async reconcileOperation(operationId: string): Promise<ReconcileOutcome> {
    if (this.#capture === undefined) {
      throw new CommercePilotApplicationError(
        'reconcileOperation is unavailable: no capture orchestrator was provided to CommercePilotApplication'
      );
    }
    return this.#capture.reconcileCapture(operationId);
  }

  /* ---------------------------------------------------------------- */
  /* Read pass-throughs (no caching, no reshaping)                    */
  /* ---------------------------------------------------------------- */

  /** Read one operation durably, or undefined when it does not exist. */
  getOperation(operationId: string): CommerceOperation | undefined {
    return this.#store.getOperation(operationId);
  }

  /** List all operations durably. */
  listOperations(): CommerceOperation[] {
    return this.#store.listOperations();
  }

  /** Demo-scale correlation only. Ambiguous matches fail closed. */
  findOperationByPayPalOrderId(paypalOrderId: string): CommerceOperation | undefined {
    if (!paypalOrderId) return undefined;
    const matches = this.#store.listOperations().filter(
      operation => operation.paypalOrder?.paypalOrderId === paypalOrderId
    );
    return matches.length === 1 ? matches[0] : undefined;
  }

  /** Read the append-only audit trail of one operation. */
  getAuditTrail(operationId: string): OperationAuditEntry[] {
    return this.#store.getAuditTrail(operationId);
  }
}
