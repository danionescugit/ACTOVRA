import { CommerceOperation, PayPalOrderInfo } from './schemas';
import {
  CommerceOperationEvent,
  DecisionProposedEvent,
  PolicyApprovedEvent,
  PolicyRejectedEvent,
  PolicyEscalatedEvent,
  HumanApprovedEvent,
  HumanRejectedEvent,
  PayPalOrderCreatedEvent,
  PaymentCompletedEvent,
  PaymentFailedEvent
} from './events';

/**
 * Durable record of the PayPal order captured for a completed/failed payment.
 * Captured from the operation's persisted `paypalOrder` at capture time;
 * still required after outcome persistence so recovery paths can always
 * identify the remotely-existing order.
 */
export type CapturedPayPalOrder = PayPalOrderInfo;

/**
 * Error thrown when an illegal state transition is attempted
 */
export class InvalidTransitionError extends Error {
  constructor(
    public readonly operation: CommerceOperation,
    public readonly event: CommerceOperationEvent,
    public readonly reason: string
  ) {
    super(`Invalid transition from ${operation.status} with event ${event.type}: ${reason}`);
    this.name = 'InvalidTransitionError';
  }
}

/**
 * Creates an initial CommerceOperation from an Opportunity
 * @param opportunity The opportunity to base the operation on
 * @param id Unique identifier for the operation (should be deterministic in tests)
 * @param timestamp Creation timestamp (should be deterministic in tests)
 * @returns A new CommerceOperation in OPPORTUNITY status
 */
export function createInitialOperation(
  opportunity: { id: string }, 
  id: string, 
  timestamp: Date
): CommerceOperation {
  return {
    id,
    opportunityId: opportunity.id,
    status: 'OPPORTUNITY',
    decision: undefined,
    policyResult: undefined,
    approvalStatus: undefined,
    paymentResult: undefined,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/**
 * Pure deterministic state transition function
 * @param operation Current commerce operation
 * @param event Event to process
 * @param timestamp Timestamp for updatedAt (must be provided for determinism)
 * @returns New commerce operation after applying the event
 * @throws InvalidTransitionError if the transition is illegal
 */
export function transitionOperation(
  operation: CommerceOperation,
  event: CommerceOperationEvent,
  timestamp: Date
): CommerceOperation {
  // Validate that the event is consistent with the operation where required
  validateEventConsistency(operation, event);

  // Perform the transition based on current status and event type
  switch (operation.status) {
    case 'OPPORTUNITY':
      return handleOpportunityState(operation, event, timestamp);
    case 'DECISION_PROPOSED':
      return handleDecisionProposedState(operation, event, timestamp);
    case 'POLICY_APPROVED':
      return handlePolicyApprovedState(operation, event, timestamp);
    case 'POLICY_REJECTED':
      return handlePolicyRejectedState(operation, event, timestamp);
    case 'POLICY_ESCALATED':
      return handlePolicyEscalatedState(operation, event, timestamp);
    case 'AWAITING_HUMAN_APPROVAL':
      return handleAwaitingHumanApprovalState(operation, event, timestamp);
    case 'APPROVED':
      return handleApprovedState(operation, event, timestamp);
    case 'REJECTED_BY_HUMAN':
      return handleRejectedByHumanState(operation, event, timestamp);
    case 'EXECUTING':
      return handleExecutingState(operation, event, timestamp);
    case 'CAPTURE_EXECUTING':
      return handleCaptureExecutingState(operation, event, timestamp);
    case 'PAYPAL_ORDER_CREATED':
      return handlePayPalOrderCreatedState(operation, event, timestamp);
    case 'PAYPAL_PENDING':
      return handlePayPalPendingState(operation, event, timestamp);
    case 'COMPLETED':
      return handleCompletedState(operation, event, timestamp);
    case 'FAILED':
      return handleFailedState(operation, event, timestamp);
    case 'OUTCOME_RECORDED':
      return handleOutcomeRecordedState(operation, event, timestamp);
    default:
      throw new InvalidTransitionError(
        operation,
        event,
        `Unhandled state: ${operation.status}`
      );
  }
}

/**
 * Validate that event payload is consistent with the operation where required
 */
function validateEventConsistency(
  operation: CommerceOperation,
  event: CommerceOperationEvent
): void {
  switch (event.type) {
    case 'DECISION_PROPOSED':
      const decisionProposedEvent = event as DecisionProposedEvent;
      if (decisionProposedEvent.decision.opportunityId !== operation.opportunityId) {
        throw new InvalidTransitionError(
          operation,
          event,
          'Decision opportunityId must match operation opportunityId'
        );
      }
      break;
    case 'POLICY_APPROVED':
    case 'POLICY_REJECTED':
    case 'POLICY_ESCALATED':
      // Policy events don't require additional consistency checks beyond being valid
      break;
    case 'HUMAN_APPROVED':
    case 'HUMAN_REJECTED':
      // Human approval events don't require additional consistency checks
      break;
    case 'PAYMENT_COMPLETED':
    case 'PAYMENT_FAILED':
      const paymentEvent = event as PaymentCompletedEvent | PaymentFailedEvent;
      if (paymentEvent.paymentResult.amount !== undefined && 
          paymentEvent.paymentResult.currency !== undefined) {
        // Additional validation could be added here if needed
      }
      // Capture integrity (Task 09): a capture outcome must carry evidence
      // identifying the persisted order it belongs to, and that order must be
      // the operation's own persisted paypalOrder — never a foreign one.
      if (operation.status === 'CAPTURE_EXECUTING') {
        requireCapturedOrder(operation, event, paymentEvent.paymentResult);
      }
      break;
    default:
      // Other events don't require consistency checks
      break;
  }
}

/**
 * Capture integrity (Task 09): a capture outcome persisted while
 * CAPTURE_EXECUTING must (a) carry the capture ID in `transactionId`,
 * (b) carry `paypalOrderId` evidence, and (c) that evidence must identify
 * the operation's OWN durably persisted paypalOrder — a capture result tied
 * to any other order is refused, so a foreign order can never mark this
 * operation COMPLETED or FAILED.
 *
 * The check runs during validateEventConsistency (before any transition is
 * returned), so a violating event causes the store to roll back with no
 * snapshot or audit write.
 */
function requireCapturedOrder(
  operation: CommerceOperation,
  event: CommerceOperationEvent,
  paymentResult: PaymentCompletedEvent['paymentResult']
): void {
  const order = operation.paypalOrder;
  if (order === undefined) {
    throw new InvalidTransitionError(
      operation,
      event,
      'Capture outcome in CAPTURE_EXECUTING requires a persisted paypalOrder (integrity fault)'
    );
  }
  const captureId = paymentResult.transactionId;
  if (typeof captureId !== 'string' || captureId.length === 0) {
    throw new InvalidTransitionError(
      operation,
      event,
      'Capture outcome in CAPTURE_EXECUTING requires transactionId to carry the capture ID'
    );
  }
  const evidencedOrderId = paymentResult.paypalOrderId;
  if (typeof evidencedOrderId !== 'string' || evidencedOrderId.length === 0) {
    throw new InvalidTransitionError(
      operation,
      event,
      'Capture outcome in CAPTURE_EXECUTING requires paypalOrderId capture evidence'
    );
  }
  if (evidencedOrderId !== order.paypalOrderId) {
    throw new InvalidTransitionError(
      operation,
      event,
      `Capture evidence paypalOrderId "${evidencedOrderId}" does not match the operation's persisted order "${order.paypalOrderId}"`
    );
  }
}

/**
 * State handler for OPPORTUNITY state
 */
function handleOpportunityState(
  operation: CommerceOperation,
  event: CommerceOperationEvent,
  timestamp: Date
): CommerceOperation {
  if (event.type === 'DECISION_PROPOSED') {
    const decisionProposedEvent = event as DecisionProposedEvent;
    return {
      ...operation,
      status: 'DECISION_PROPOSED',
      decision: decisionProposedEvent.decision,
      updatedAt: timestamp,
    };
  }
  throw new InvalidTransitionError(
    operation,
    event,
    `Only DECISION_PROPOSED event is allowed from OPPORTUNITY state`
  );
}

/**
 * State handler for DECISION_PROPOSED state
 */
function handleDecisionProposedState(
  operation: CommerceOperation,
  event: CommerceOperationEvent,
  timestamp: Date
): CommerceOperation {
  switch (event.type) {
    case 'POLICY_APPROVED':
      const policyApprovedEvent = event as PolicyApprovedEvent;
      return {
        ...operation,
        status: 'POLICY_APPROVED',
        policyResult: policyApprovedEvent.policyResult,
        updatedAt: timestamp,
      };
    case 'POLICY_REJECTED':
      const policyRejectedEvent = event as PolicyRejectedEvent;
      return {
        ...operation,
        status: 'POLICY_REJECTED',
        policyResult: policyRejectedEvent.policyResult,
        updatedAt: timestamp,
      };
    case 'POLICY_ESCALATED':
      const policyEscalatedEvent = event as PolicyEscalatedEvent;
      return {
        ...operation,
        status: 'POLICY_ESCALATED',
        policyResult: policyEscalatedEvent.policyResult,
        updatedAt: timestamp,
      };
    default:
      throw new InvalidTransitionError(
        operation,
        event,
        `Only POLICY_APPROVED, POLICY_REJECTED, or POLICY_ESCALATED events are allowed from DECISION_PROPOSED state`
      );
  }
}

/**
 * State handler for POLICY_APPROVED state
 */
function handlePolicyApprovedState(
  operation: CommerceOperation,
  event: CommerceOperationEvent,
  timestamp: Date
): CommerceOperation {
  if (event.type === 'REQUEST_HUMAN_APPROVAL') {
    return {
      ...operation,
      status: 'AWAITING_HUMAN_APPROVAL',
      updatedAt: timestamp,
    };
  }
  throw new InvalidTransitionError(
    operation,
    event,
    `Only REQUEST_HUMAN_APPROVAL event is allowed from POLICY_APPROVED state`
  );
}

/*
 * State handler for POLICY_REJECTED state
 */
function handlePolicyRejectedState(
  operation: CommerceOperation,
  event: CommerceOperationEvent,
  timestamp: Date // eslint-disable-line @typescript-eslint/no-unused-vars
): CommerceOperation {
  // POLICY_REJECTED is terminal for payment execution - no transitions allowed
  throw new InvalidTransitionError(
    operation,
    event,
    `No transitions allowed from POLICY_REJECTED state (terminal for payment execution)`
  );
}

/**
 * State handler for POLICY_ESCALATED state
 */
function handlePolicyEscalatedState(
  operation: CommerceOperation,
  event: CommerceOperationEvent,
  timestamp: Date
): CommerceOperation {
  if (event.type === 'REQUEST_HUMAN_APPROVAL') {
    return {
      ...operation,
      status: 'AWAITING_HUMAN_APPROVAL',
      updatedAt: timestamp,
    };
  }
  throw new InvalidTransitionError(
    operation,
    event,
    `Only REQUEST_HUMAN_APPROVAL event is allowed from POLICY_ESCALATED state`
  );
}

/**
 * State handler for AWAITING_HUMAN_APPROVAL state
 */
function handleAwaitingHumanApprovalState(
  operation: CommerceOperation,
  event: CommerceOperationEvent,
  timestamp: Date
): CommerceOperation {
  switch (event.type) {
    case 'HUMAN_APPROVED':
      const humanApprovedEvent = event as HumanApprovedEvent;
      return {
        ...operation,
        status: 'APPROVED',
        approvalStatus: humanApprovedEvent.approvalStatus,
        updatedAt: timestamp,
      };
    case 'HUMAN_REJECTED':
      const humanRejectedEvent = event as HumanRejectedEvent;
      return {
        ...operation,
        status: 'REJECTED_BY_HUMAN',
        approvalStatus: humanRejectedEvent.approvalStatus,
        updatedAt: timestamp,
      };
    default:
      throw new InvalidTransitionError(
        operation,
        event,
        `Only HUMAN_APPROVED or HUMAN_REJECTED events are allowed from AWAITING_HUMAN_APPROVAL state`
      );
  }
}

/**
 * State handler for APPROVED state
 */
function handleApprovedState(
  operation: CommerceOperation,
  event: CommerceOperationEvent,
  timestamp: Date
): CommerceOperation {
  if (event.type === 'EXECUTION_STARTED') {
    return {
      ...operation,
      status: 'EXECUTING',
      updatedAt: timestamp,
    };
  }
  throw new InvalidTransitionError(
    operation,
    event,
    `Only EXECUTION_STARTED event is allowed from APPROVED state`
  );
}

/**
 * State handler for REJECTED_BY_HUMAN state
 */
function handleRejectedByHumanState(
  operation: CommerceOperation,
  event: CommerceOperationEvent,
  timestamp: Date // eslint-disable-line @typescript-eslint/no-unused-vars
): CommerceOperation {
  // REJECTED_BY_HUMAN is terminal - no transitions to execution allowed
  throw new InvalidTransitionError(
    operation,
    event,
    `No transitions allowed from REJECTED_BY_HUMAN state (cannot proceed to execution)`
  );
}

/**
 * State handler for EXECUTING state
 */
function handleExecutingState(
  operation: CommerceOperation,
  event: CommerceOperationEvent,
  timestamp: Date
): CommerceOperation {
  switch (event.type) {
    case 'PAYPAL_PENDING':
      return {
        ...operation,
        status: 'PAYPAL_PENDING',
        updatedAt: timestamp,
      };
    case 'PAYPAL_ORDER_CREATED':
      const paypalOrderCreatedEvent = event as PayPalOrderCreatedEvent;
      return {
        ...operation,
        status: 'PAYPAL_ORDER_CREATED',
        paypalOrder: paypalOrderCreatedEvent.paypalOrder,
        updatedAt: timestamp,
      };
    case 'PAYMENT_COMPLETED':
      const paymentCompletedEvent = event as PaymentCompletedEvent;
      return {
        ...operation,
        status: 'COMPLETED',
        paymentResult: paymentCompletedEvent.paymentResult,
        updatedAt: timestamp,
      };
    case 'PAYMENT_FAILED':
      const paymentFailedEvent = event as PaymentFailedEvent;
      return {
        ...operation,
        status: 'FAILED',
        paymentResult: paymentFailedEvent.paymentResult,
        updatedAt: timestamp,
      };
    default:
      throw new InvalidTransitionError(
        operation,
        event,
        `Only PAYPAL_PENDING, PAYMENT_COMPLETED, or PAYMENT_FAILED events are allowed from EXECUTING state`
      );
  }
}

/**
 * State handler for PAYPAL_PENDING state
 */
function handlePayPalPendingState(
  operation: CommerceOperation,
  event: CommerceOperationEvent,
  timestamp: Date
): CommerceOperation {
  switch (event.type) {
    case 'PAYMENT_COMPLETED':
      const paymentCompletedEvent = event as PaymentCompletedEvent;
      return {
        ...operation,
        status: 'COMPLETED',
        paymentResult: paymentCompletedEvent.paymentResult,
        updatedAt: timestamp,
      };
    case 'PAYMENT_FAILED':
      const paymentFailedEvent = event as PaymentFailedEvent;
      return {
        ...operation,
        status: 'FAILED',
        paymentResult: paymentFailedEvent.paymentResult,
        updatedAt: timestamp,
      };
    default:
      throw new InvalidTransitionError(
        operation,
        event,
        `Only PAYMENT_COMPLETED or PAYMENT_FAILED events are allowed from PAYPAL_PENDING state`
      );
  }
}

/**
 * State handler for PAYPAL_ORDER_CREATED state
 *
 * Represents the truthful intermediate state: "PayPal order successfully
 * created, buyer has not yet approved, payment has NOT been captured."
 * Reaching this state must never be interpreted as payment completion.
 *
 * The ONLY exit is CAPTURE_STARTED → CAPTURE_EXECUTING (Task 09): capture
 * outcomes must be claimed before the network call so concurrent invocations
 * cannot double-capture, and so ambiguous remote outcomes are durably
 * observable as CAPTURE_EXECUTING instead of being guessed into
 * COMPLETED/FAILED.
 */
function handlePayPalOrderCreatedState(
  operation: CommerceOperation,
  event: CommerceOperationEvent,
  timestamp: Date
): CommerceOperation {
  if (event.type === 'CAPTURE_STARTED') {
    // Integrity guard: a capture claim requires the durable order to target.
    if (operation.paypalOrder === undefined) {
      throw new InvalidTransitionError(
        operation,
        event,
        'CAPTURE_STARTED requires a persisted paypalOrder on the operation (no durable order to capture)'
      );
    }
    return {
      ...operation,
      status: 'CAPTURE_EXECUTING',
      updatedAt: timestamp,
    };
  }
  throw new InvalidTransitionError(
    operation,
    event,
    `Only CAPTURE_STARTED is allowed from PAYPAL_ORDER_CREATED state (capture outcomes must be claimed first; direct PAYMENT_COMPLETED/PAYMENT_FAILED is no longer permitted)`
  );
}

/**
 * State handler for CAPTURE_EXECUTING state (Task 09).
 *
 * Represents the truthful intermediate state: "capture attempt durably
 * claimed against the persisted PayPal order; remote outcome unknown until a
 * result event lands." All other events are illegal — in particular, a
 * second CAPTURE_STARTED is rejected, which makes the durable claim
 * single-flight.
 */
function handleCaptureExecutingState(
  operation: CommerceOperation,
  event: CommerceOperationEvent,
  timestamp: Date
): CommerceOperation {
  switch (event.type) {
    case 'PAYMENT_COMPLETED':
      const paymentCompletedEvent = event as PaymentCompletedEvent;
      return {
        ...operation,
        status: 'COMPLETED',
        paymentResult: paymentCompletedEvent.paymentResult,
        updatedAt: timestamp,
      };
    case 'PAYMENT_FAILED':
      const paymentFailedEvent = event as PaymentFailedEvent;
      return {
        ...operation,
        status: 'FAILED',
        paymentResult: paymentFailedEvent.paymentResult,
        updatedAt: timestamp,
      };
    default:
      throw new InvalidTransitionError(
        operation,
        event,
        `Only PAYMENT_COMPLETED or PAYMENT_FAILED events are allowed from CAPTURE_EXECUTING state`
      );
  }
}

/**
 * State handler for COMPLETED state
 */
function handleCompletedState(
  operation: CommerceOperation,
  event: CommerceOperationEvent,
  timestamp: Date
): CommerceOperation {
  if (event.type === 'OUTCOME_RECORDED') {
    return {
      ...operation,
      status: 'OUTCOME_RECORDED',
      updatedAt: timestamp,
    };
  }
  throw new InvalidTransitionError(
    operation,
    event,
    `Only OUTCOME_RECORDED event is allowed from COMPLETED state`
  );
}

/**
 * State handler for FAILED state
 */
function handleFailedState(
  operation: CommerceOperation,
  event: CommerceOperationEvent,
  timestamp: Date
): CommerceOperation {
  if (event.type === 'OUTCOME_RECORDED') {
    return {
      ...operation,
      status: 'OUTCOME_RECORDED',
      updatedAt: timestamp,
    };
  }
  throw new InvalidTransitionError(
    operation,
    event,
    `Only OUTCOME_RECORDED event is allowed from FAILED state`
  );
}

/**
 * State handler for OUTCOME_RECORDED state
 */
function handleOutcomeRecordedState(
  operation: CommerceOperation,
  event: CommerceOperationEvent,
  timestamp: Date // eslint-disable-line @typescript-eslint/no-unused-vars
): CommerceOperation {
  // OUTCOME_RECORDED is terminal - no transitions allowed
  throw new InvalidTransitionError(
    operation,
    event,
    `No transitions allowed from OUTCOME_RECORDED state (terminal state)`
  );
}