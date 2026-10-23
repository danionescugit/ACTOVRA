import { describe, it, expect, beforeEach } from 'vitest';
import {  transitionOperation,  
  createInitialOperation,
  InvalidTransitionError
} from './stateMachine';
import {  DecisionProposedEvent,
  PolicyApprovedEvent,
  PolicyRejectedEvent,
  PolicyEscalatedEvent,
  RequestHumanApprovalEvent,
  HumanApprovedEvent,
  HumanRejectedEvent,
  ExecutionStartedEvent,
  PayPalPendingEvent,
  PayPalOrderCreatedEvent,
  CaptureStartedEvent,
  PaymentCompletedEvent,
  PaymentFailedEvent,
  OutcomeRecordedEvent
} from './events';
import {  CommerceDecisionSchema,
  PolicyResultSchema,
  PaymentResultSchema,
  PayPalOrderInfoSchema,
  CommerceOperationSchema,
  CommerceOperation
} from './schemas';
import { CommerceOperationEventSchema } from './events';

describe('Commerce Operation State Machine', () => {
  const FIXED_TIMESTAMP = new Date('2026-01-01T00:00:00.000Z');
  const OPPORTUNITY_ID = 'opp-123';
  const OPERATION_ID = 'op-456';

  let baseOpportunity: { id: string };
  let initialOperation: CommerceOperation;

  beforeEach(() => {
    baseOpportunity = { id: OPPORTUNITY_ID };
    initialOperation = createInitialOperation(baseOpportunity, OPERATION_ID, FIXED_TIMESTAMP);
  });

  describe('Happy Path', () => {
    it('should transition through the happy path', () => {
      let operation = initialOperation;

      // OPPORTUNITY → DECISION_PROPOSED
      const decision = CommerceDecisionSchema.parse({
        opportunityId: OPPORTUNITY_ID,
        action: 'CREATE_PAYMENT',
        amount: 1000,
        currency: 'USD',
        recipient: 'customer-123',
        justification: 'Test decision'
      });
      const decisionEvent: DecisionProposedEvent = { type: 'DECISION_PROPOSED', decision };
      operation = transitionOperation(operation, decisionEvent, new Date(FIXED_TIMESTAMP.getTime() + 1000));
      expect(operation.status).toBe('DECISION_PROPOSED');
      expect(operation.decision).toEqual(decision);

      // DECISION_PROPOSED → POLICY_APPROVED
      const policyResult = PolicyResultSchema.parse({
        decision: 'APPROVE',
        reason: 'Looks good'
      });
      const policyEvent: PolicyApprovedEvent = { type: 'POLICY_APPROVED', policyResult };
      operation = transitionOperation(operation, policyEvent, new Date(FIXED_TIMESTAMP.getTime() + 2000));
      expect(operation.status).toBe('POLICY_APPROVED');
      expect(operation.policyResult).toEqual(policyResult);

      // POLICY_APPROVED → AWAITING_HUMAN_APPROVAL
      const requestEvent: RequestHumanApprovalEvent = { type: 'REQUEST_HUMAN_APPROVAL' };
      operation = transitionOperation(operation, requestEvent, new Date(FIXED_TIMESTAMP.getTime() + 3000));
      expect(operation.status).toBe('AWAITING_HUMAN_APPROVAL');

      // AWAITING_HUMAN_APPROVAL → APPROVED
      const humanApprovedEvent: HumanApprovedEvent = { type: 'HUMAN_APPROVED', approvalStatus: 'APPROVED' };
      operation = transitionOperation(operation, humanApprovedEvent, new Date(FIXED_TIMESTAMP.getTime() + 4000));
      expect(operation.status).toBe('APPROVED');
      expect(operation.approvalStatus).toBe('APPROVED');

      // APPROVED → EXECUTING
      const executionEvent: ExecutionStartedEvent = { type: 'EXECUTION_STARTED' };
      operation = transitionOperation(operation, executionEvent, new Date(FIXED_TIMESTAMP.getTime() + 5000));
      expect(operation.status).toBe('EXECUTING');

      // EXECUTING → COMPLETED
      const paymentResult = PaymentResultSchema.parse({
        success: true,
        transactionId: 'txn_123',
        amount: 1000,
        currency: 'USD'
      });
      const paymentCompletedEvent: PaymentCompletedEvent = { type: 'PAYMENT_COMPLETED', paymentResult };
      operation = transitionOperation(operation, paymentCompletedEvent, new Date(FIXED_TIMESTAMP.getTime() + 6000));
      expect(operation.status).toBe('COMPLETED');
      expect(operation.paymentResult).toEqual(paymentResult);

      // COMPLETED → OUTCOME_RECORDED
      const outcomeEvent: OutcomeRecordedEvent = { type: 'OUTCOME_RECORDED' };
      operation = transitionOperation(operation, outcomeEvent, new Date(FIXED_TIMESTAMP.getTime() + 7000));
      expect(operation.status).toBe('OUTCOME_RECORDED');
    });
  });

  describe('Pending Path (via PAYPAL_PENDING)', () => {
    it('should transition through the pending path', () => {
      let operation = initialOperation;

      // Setup to EXECUTING state
      const decision = CommerceDecisionSchema.parse({
        opportunityId: OPPORTUNITY_ID,
        action: 'CREATE_PAYMENT',
        amount: 1000,
        currency: 'USD',
        recipient: 'customer-123',
        justification: 'Test decision'
      });
      const decisionEvent: DecisionProposedEvent = { type: 'DECISION_PROPOSED', decision };
      operation = transitionOperation(operation, decisionEvent, new Date(FIXED_TIMESTAMP.getTime() + 1000));

      const policyResult = PolicyResultSchema.parse({
        decision: 'APPROVE',
        reason: 'Looks good'
      });
      const policyEvent: PolicyApprovedEvent = { type: 'POLICY_APPROVED', policyResult };
      operation = transitionOperation(operation, policyEvent, new Date(FIXED_TIMESTAMP.getTime() + 2000));

      const requestEvent: RequestHumanApprovalEvent = { type: 'REQUEST_HUMAN_APPROVAL' };
      operation = transitionOperation(operation, requestEvent, new Date(FIXED_TIMESTAMP.getTime() + 3000));

      const humanApprovedEvent: HumanApprovedEvent = { type: 'HUMAN_APPROVED', approvalStatus: 'APPROVED' };
      operation = transitionOperation(operation, humanApprovedEvent, new Date(FIXED_TIMESTAMP.getTime() + 4000));

      const executionEvent: ExecutionStartedEvent = { type: 'EXECUTION_STARTED' };
      operation = transitionOperation(operation, executionEvent, new Date(FIXED_TIMESTAMP.getTime() + 5000));

      // EXECUTING → PAYPAL_PENDING
      const payPalPendingEvent: PayPalPendingEvent = { type: 'PAYPAL_PENDING' };
      operation = transitionOperation(operation, payPalPendingEvent, new Date(FIXED_TIMESTAMP.getTime() + 6000));
      expect(operation.status).toBe('PAYPAL_PENDING');

      // PAYPAL_PENDING → COMPLETED
      const paymentResult = PaymentResultSchema.parse({
        success: true,
        transactionId: 'txn_456',
        amount: 1000,
        currency: 'USD'
      });
      const paymentCompletedEvent: PaymentCompletedEvent = { type: 'PAYMENT_COMPLETED', paymentResult };
      operation = transitionOperation(operation, paymentCompletedEvent, new Date(FIXED_TIMESTAMP.getTime() + 7000));
      expect(operation.status).toBe('COMPLETED');
      expect(operation.paymentResult).toEqual(paymentResult);

      // COMPLETED → OUTCOME_RECORDED
      const outcomeEvent: OutcomeRecordedEvent = { type: 'OUTCOME_RECORDED' };
      operation = transitionOperation(operation, outcomeEvent, new Date(FIXED_TIMESTAMP.getTime() + 8000));
      expect(operation.status).toBe('OUTCOME_RECORDED');
    });
  });

  describe('Payment Failed Path', () => {
    it('should transition EXECUTING → PAYMENT_FAILED → FAILED → OUTCOME_RECORDED and preserve PaymentResult', () => {
      let operation = initialOperation;

      // Setup to EXECUTING state
      const decision = CommerceDecisionSchema.parse({
        opportunityId: OPPORTUNITY_ID,
        action: 'CREATE_PAYMENT',
        amount: 1000,
        currency: 'USD',
        recipient: 'customer-123',
        justification: 'Test decision'
      });
      const decisionEvent: DecisionProposedEvent = { type: 'DECISION_PROPOSED', decision };
      operation = transitionOperation(operation, decisionEvent, new Date(FIXED_TIMESTAMP.getTime() + 1000));

      const policyResult = PolicyResultSchema.parse({
        decision: 'APPROVE',
        reason: 'Looks good'
      });
      const policyEvent: PolicyApprovedEvent = { type: 'POLICY_APPROVED', policyResult };
      operation = transitionOperation(operation, policyEvent, new Date(FIXED_TIMESTAMP.getTime() + 2000));

      const requestEvent: RequestHumanApprovalEvent = { type: 'REQUEST_HUMAN_APPROVAL' };
      operation = transitionOperation(operation, requestEvent, new Date(FIXED_TIMESTAMP.getTime() + 3000));

      const humanApprovedEvent: HumanApprovedEvent = { type: 'HUMAN_APPROVED', approvalStatus: 'APPROVED' };
      operation = transitionOperation(operation, humanApprovedEvent, new Date(FIXED_TIMESTAMP.getTime() + 4000));

      const executionEvent: ExecutionStartedEvent = { type: 'EXECUTION_STARTED' };
      operation = transitionOperation(operation, executionEvent, new Date(FIXED_TIMESTAMP.getTime() + 5000));
      expect(operation.status).toBe('EXECUTING');

      // EXECUTING → PAYMENT_FAILED
      const paymentResult = PaymentResultSchema.parse({
        success: false,
        transactionId: 'txn_failed',
        amount: 1000,
        currency: 'USD'
      });
      const paymentFailedEvent: PaymentFailedEvent = { type: 'PAYMENT_FAILED', paymentResult };
      operation = transitionOperation(operation, paymentFailedEvent, new Date(FIXED_TIMESTAMP.getTime() + 6000));
      expect(operation.status).toBe('FAILED');
      expect(operation.paymentResult).toEqual(paymentResult);

      // FAILED → OUTCOME_RECORDED
      const outcomeEvent: OutcomeRecordedEvent = { type: 'OUTCOME_RECORDED' };
      operation = transitionOperation(operation, outcomeEvent, new Date(FIXED_TIMESTAMP.getTime() + 7000));
      expect(operation.status).toBe('OUTCOME_RECORDED');
      expect(operation.paymentResult).toEqual(paymentResult); // PaymentResult should be preserved
    });
  });

  describe('Policy Escalation Path', () => {
    it('should transition through policy escalation', () => {
      let operation = initialOperation;

      // OPPORTUNITY → DECISION_PROPOSED
      const decision = CommerceDecisionSchema.parse({
        opportunityId: OPPORTUNITY_ID,
        action: 'CREATE_PAYMENT',
        amount: 1000,
        currency: 'USD',
        recipient: 'customer-123',
        justification: 'Test decision'
      });
      const decisionEvent: DecisionProposedEvent = { type: 'DECISION_PROPOSED', decision };
      operation = transitionOperation(operation, decisionEvent, new Date(FIXED_TIMESTAMP.getTime() + 1000));

      // DECISION_PROPOSED → POLICY_ESCALATED
      const policyResult = PolicyResultSchema.parse({
        decision: 'ESCALATE',
        reason: 'Needs human review'
      });
      const policyEvent: PolicyEscalatedEvent = { type: 'POLICY_ESCALATED', policyResult };
      operation = transitionOperation(operation, policyEvent, new Date(FIXED_TIMESTAMP.getTime() + 2000));
      expect(operation.status).toBe('POLICY_ESCALATED');
      expect(operation.policyResult).toEqual(policyResult);

      // POLICY_ESCALATED → AWAITING_HUMAN_APPROVAL
      const requestEvent: RequestHumanApprovalEvent = { type: 'REQUEST_HUMAN_APPROVAL' };
      operation = transitionOperation(operation, requestEvent, new Date(FIXED_TIMESTAMP.getTime() + 3000));
      expect(operation.status).toBe('AWAITING_HUMAN_APPROVAL');

      // Continue to execution
      const humanApprovedEvent: HumanApprovedEvent = { type: 'HUMAN_APPROVED', approvalStatus: 'APPROVED' };
      operation = transitionOperation(operation, humanApprovedEvent, new Date(FIXED_TIMESTAMP.getTime() + 4000));
      expect(operation.status).toBe('APPROVED');

      const executionEvent: ExecutionStartedEvent = { type: 'EXECUTION_STARTED' };
      operation = transitionOperation(operation, executionEvent, new Date(FIXED_TIMESTAMP.getTime() + 5000));
      expect(operation.status).toBe('EXECUTING');
    });
  });

  describe('Policy Rejection (Terminal)', () => {
    it('should not allow transitions from POLICY_REJECTED', () => {
      let operation = initialOperation;

      // Get to POLICY_REJECTED
      const decision = CommerceDecisionSchema.parse({
        opportunityId: OPPORTUNITY_ID,
        action: 'CREATE_PAYMENT',
        amount: 1000,
        currency: 'USD',
        recipient: 'customer-123',
        justification: 'Test decision'
      });
      const decisionEvent: DecisionProposedEvent = { type: 'DECISION_PROPOSED', decision };
      operation = transitionOperation(operation, decisionEvent, new Date(FIXED_TIMESTAMP.getTime() + 1000));

      const policyResult = PolicyResultSchema.parse({
        decision: 'REJECT',
        reason: 'Too risky'
      });
      const policyEvent: PolicyRejectedEvent = { type: 'POLICY_REJECTED', policyResult };
      operation = transitionOperation(operation, policyEvent, new Date(FIXED_TIMESTAMP.getTime() + 2000));
      expect(operation.status).toBe('POLICY_REJECTED');

      // Try to transition to REQUEST_HUMAN_APPROVAL (should fail)
      const requestEvent: RequestHumanApprovalEvent = { type: 'REQUEST_HUMAN_APPROVAL' };
      expect(() => transitionOperation(operation, requestEvent, new Date(FIXED_TIMESTAMP.getTime() + 3000)))
        .toThrow(InvalidTransitionError);

      // Try to transition to EXECUTION_STARTED (should fail)
      const executionEvent: ExecutionStartedEvent = { type: 'EXECUTION_STARTED' };
      expect(() => transitionOperation(operation, executionEvent, new Date(FIXED_TIMESTAMP.getTime() + 3000)))
        .toThrow(InvalidTransitionError);
    });
  });

  describe('Human Rejection (Terminal to execution)', () => {
    it('should not allow transitions from REJECTED_BY_HUMAN to execution', () => {
      let operation = initialOperation;

      // Get to REJECTED_BY_HUMAN
      const decision = CommerceDecisionSchema.parse({
        opportunityId: OPPORTUNITY_ID,
        action: 'CREATE_PAYMENT',
        amount: 1000,
        currency: 'USD',
        recipient: 'customer-123',
        justification: 'Test decision'
      });
      const decisionEvent: DecisionProposedEvent = { type: 'DECISION_PROPOSED', decision };
      operation = transitionOperation(operation, decisionEvent, new Date(FIXED_TIMESTAMP.getTime() + 1000));

      const policyResult = PolicyResultSchema.parse({
        decision: 'APPROVE',
        reason: 'Looks good'
      });
      const policyEvent: PolicyApprovedEvent = { type: 'POLICY_APPROVED', policyResult };
      operation = transitionOperation(operation, policyEvent, new Date(FIXED_TIMESTAMP.getTime() + 2000));

      const requestEvent: RequestHumanApprovalEvent = { type: 'REQUEST_HUMAN_APPROVAL' };
      operation = transitionOperation(operation, requestEvent, new Date(FIXED_TIMESTAMP.getTime() + 3000));

      const humanRejectedEvent: HumanRejectedEvent = { type: 'HUMAN_REJECTED', approvalStatus: 'REJECTED' };
      operation = transitionOperation(operation, humanRejectedEvent, new Date(FIXED_TIMESTAMP.getTime() + 4000));
      expect(operation.status).toBe('REJECTED_BY_HUMAN');
      expect(operation.approvalStatus).toBe('REJECTED');

      // Try to transition to EXECUTION_STARTED (should fail)
      const executionEvent: ExecutionStartedEvent = { type: 'EXECUTION_STARTED' };
      expect(() => transitionOperation(operation, executionEvent, new Date(FIXED_TIMESTAMP.getTime() + 5000)))
        .toThrow(InvalidTransitionError);
    });
  });

  describe('Illegal Bypass Attempts', () => {
    it('should reject DECISION_PROPOSED → EXECUTING bypass', () => {
      let operation = initialOperation;

      // Get to DECISION_PROPOSED
      const decision = CommerceDecisionSchema.parse({
        opportunityId: OPPORTUNITY_ID,
        action: 'CREATE_PAYMENT',
        amount: 1000,
        currency: 'USD',
        recipient: 'customer-123',
        justification: 'Test decision'
      });
      const decisionEvent: DecisionProposedEvent = { type: 'DECISION_PROPOSED', decision };
      operation = transitionOperation(operation, decisionEvent, new Date(FIXED_TIMESTAMP.getTime() + 1000));
      expect(operation.status).toBe('DECISION_PROPOSED');

      // Try to go directly to EXECUTING (should fail)
      const executionEvent: ExecutionStartedEvent = { type: 'EXECUTION_STARTED' };
      expect(() => transitionOperation(operation, executionEvent, new Date(FIXED_TIMESTAMP.getTime() + 2000)))
        .toThrow(InvalidTransitionError);
    });

    it('should reject POLICY_APPROVED → EXECUTING bypass', () => {
      let operation = initialOperation;

      // Get to POLICY_APPROVED
      const decision = CommerceDecisionSchema.parse({
        opportunityId: OPPORTUNITY_ID,
        action: 'CREATE_PAYMENT',
        amount: 1000,
        currency: 'USD',
        recipient: 'customer-123',
        justification: 'Test decision'
      });
      const decisionEvent: DecisionProposedEvent = { type: 'DECISION_PROPOSED', decision };
      operation = transitionOperation(operation, decisionEvent, new Date(FIXED_TIMESTAMP.getTime() + 1000));

      const policyResult = PolicyResultSchema.parse({
        decision: 'APPROVE',
        reason: 'Looks good'
      });
      const policyEvent: PolicyApprovedEvent = { type: 'POLICY_APPROVED', policyResult };
      operation = transitionOperation(operation, policyEvent, new Date(FIXED_TIMESTAMP.getTime() + 2000));
      expect(operation.status).toBe('POLICY_APPROVED');

      // Try to go directly to EXECUTING (should fail)
      const executionEvent: ExecutionStartedEvent = { type: 'EXECUTION_STARTED' };
      expect(() => transitionOperation(operation, executionEvent, new Date(FIXED_TIMESTAMP.getTime() + 3000)))
        .toThrow(InvalidTransitionError);
    });

    it('should reject AWAITING_HUMAN_APPROVAL → EXECUTING bypass', () => {
      let operation = initialOperation;

      // Get to AWAITING_HUMAN_APPROVAL
      const decision = CommerceDecisionSchema.parse({
        opportunityId: OPPORTUNITY_ID,
        action: 'CREATE_PAYMENT',
        amount: 1000,
        currency: 'USD',
        recipient: 'customer-123',
        justification: 'Test decision'
      });
      const decisionEvent: DecisionProposedEvent = { type: 'DECISION_PROPOSED', decision };
      operation = transitionOperation(operation, decisionEvent, new Date(FIXED_TIMESTAMP.getTime() + 1000));

      const policyResult = PolicyResultSchema.parse({
        decision: 'APPROVE',
        reason: 'Looks good'
      });
      const policyEvent: PolicyApprovedEvent = { type: 'POLICY_APPROVED', policyResult };
      operation = transitionOperation(operation, policyEvent, new Date(FIXED_TIMESTAMP.getTime() + 2000));

      const requestEvent: RequestHumanApprovalEvent = { type: 'REQUEST_HUMAN_APPROVAL' };
      operation = transitionOperation(operation, requestEvent, new Date(FIXED_TIMESTAMP.getTime() + 3000));
      expect(operation.status).toBe('AWAITING_HUMAN_APPROVAL');

      // Try to go directly to EXECUTING (should fail)
      const executionEvent: ExecutionStartedEvent = { type: 'EXECUTION_STARTED' };
      expect(() => transitionOperation(operation, executionEvent, new Date(FIXED_TIMESTAMP.getTime() + 4000)))
        .toThrow(InvalidTransitionError);
    });

    it('should reject OPPORTUNITY → COMPLETED bypass', () => {
      // Try to go directly from OPPORTUNITY to COMPLETED (should fail)
      const paymentResult = PaymentResultSchema.parse({
        success: true,
        transactionId: 'txn_123',
        amount: 1000,
        currency: 'USD'
      });
      const paymentCompletedEvent: PaymentCompletedEvent = { type: 'PAYMENT_COMPLETED', paymentResult };
      expect(() => transitionOperation(initialOperation, paymentCompletedEvent, new Date(FIXED_TIMESTAMP.getTime() + 1000)))
        .toThrow(InvalidTransitionError);
    });
  });

  describe('Data Consistency', () => {
    it('should reject mismatched decision opportunityId', () => {
      const decision = CommerceDecisionSchema.parse({
        opportunityId: 'different-opp-id', // Doesn't match operation opportunityId
        action: 'CREATE_PAYMENT',
        amount: 1000,
        currency: 'USD',
        recipient: 'customer-123',
        justification: 'Test decision'
      });
      const decisionEvent: DecisionProposedEvent = { type: 'DECISION_PROPOSED', decision };
      expect(() => transitionOperation(initialOperation, decisionEvent, new Date(FIXED_TIMESTAMP.getTime() + 1000)))
        .toThrow(InvalidTransitionError);
    });

    it('should accept valid decision opportunityId match', () => {
      const decision = CommerceDecisionSchema.parse({
        opportunityId: OPPORTUNITY_ID, // Matches operation opportunityId
        action: 'CREATE_PAYMENT',
        amount: 1000,
        currency: 'USD',
        recipient: 'customer-123',
        justification: 'Test decision'
      });
      const decisionEvent: DecisionProposedEvent = { type: 'DECISION_PROPOSED', decision };
      // This should not throw
      expect(() => transitionOperation(initialOperation, decisionEvent, new Date(FIXED_TIMESTAMP.getTime() + 1000))).not.toThrow();
    });
  });

  describe('Immutability', () => {
    it('should not mutate the original operation', () => {
      const originalOperation = { ...initialOperation };
      const decision = CommerceDecisionSchema.parse({
        opportunityId: OPPORTUNITY_ID,
        action: 'CREATE_PAYMENT',
        amount: 1000,
        currency: 'USD',
        recipient: 'customer-123',
        justification: 'Test decision'
      });
      const decisionEvent: DecisionProposedEvent = { type: 'DECISION_PROPOSED', decision };
      const timestamp = new Date(FIXED_TIMESTAMP.getTime() + 1000);

      transitionOperation(initialOperation, decisionEvent, timestamp);

      // Original operation should be unchanged
      expect(initialOperation).toEqual(originalOperation);
    });
  });

  describe('Determinism', () => {
    it('should produce identical output for identical input', () => {
      const decision = CommerceDecisionSchema.parse({
        opportunityId: OPPORTUNITY_ID,
        action: 'CREATE_PAYMENT',
        amount: 1000,
        currency: 'USD',
        recipient: 'customer-123',
        justification: 'Test decision'
      });
      const decisionEvent: DecisionProposedEvent = { type: 'DECISION_PROPOSED', decision };
      const timestamp = new Date(FIXED_TIMESTAMP.getTime() + 1000);

      const result1 = transitionOperation(initialOperation, decisionEvent, timestamp);
      const result2 = transitionOperation(initialOperation, decisionEvent, timestamp);

      expect(result1).toEqual(result2);
    });
  });

  describe('Timestamp Handling', () => {
    it('should use explicit timestamp for updatedAt', () => {
      const customTimestamp = new Date('2026-06-15T12:30:45.000Z');
      const decision = CommerceDecisionSchema.parse({
        opportunityId: OPPORTUNITY_ID,
        action: 'CREATE_PAYMENT',
        amount: 1000,
        currency: 'USD',
        recipient: 'customer-123',
        justification: 'Test decision'
      });
      const decisionEvent: DecisionProposedEvent = { type: 'DECISION_PROPOSED', decision };

      const result = transitionOperation(initialOperation, decisionEvent, customTimestamp);
      expect(result.updatedAt).toEqual(customTimestamp);
      // createdAt should remain unchanged
      expect(result.createdAt).toEqual(initialOperation.createdAt);
    });
  });

  describe('Security Invariant', () => {
    it('should not allow EXECUTING without POLICY_APPROVED/ESCALATED and APPROVED', () => {
      // Test various paths that should not reach EXECUTING
      
      // Path 1: Direct from DECISION_PROPOSED (missing policy and human approval)
      let operation1 = initialOperation;
      const decision = CommerceDecisionSchema.parse({
        opportunityId: OPPORTUNITY_ID,
        action: 'CREATE_PAYMENT',
        amount: 1000,
        currency: 'USD',
        recipient: 'customer-123',
        justification: 'Test decision'
      });
      const decisionEvent: DecisionProposedEvent = { type: 'DECISION_PROPOSED', decision };
      operation1 = transitionOperation(operation1, decisionEvent, new Date(FIXED_TIMESTAMP.getTime() + 1000));
      
      const executionEvent: ExecutionStartedEvent = { type: 'EXECUTION_STARTED' };
      expect(() => transitionOperation(operation1, executionEvent, new Date(FIXED_TIMESTAMP.getTime() + 2000)))
        .toThrow(InvalidTransitionError);

      // Path 2: From POLICY_APPROVED without human approval
      let operation2 = initialOperation;
      operation2 = transitionOperation(operation2, decisionEvent, new Date(FIXED_TIMESTAMP.getTime() + 1000));
      
      const policyResult = PolicyResultSchema.parse({
        decision: 'APPROVE',
        reason: 'Looks good'
      });
      const policyEvent: PolicyApprovedEvent = { type: 'POLICY_APPROVED', policyResult };
      operation2 = transitionOperation(operation2, policyEvent, new Date(FIXED_TIMESTAMP.getTime() + 2000));
      
      expect(() => transitionOperation(operation2, executionEvent, new Date(FIXED_TIMESTAMP.getTime() + 3000)))
        .toThrow(InvalidTransitionError);

      // Path 3: From AWAITING_HUMAN_APPROVAL without actual approval
      let operation3 = initialOperation;
      operation3 = transitionOperation(operation3, decisionEvent, new Date(FIXED_TIMESTAMP.getTime() + 1000));
      operation3 = transitionOperation(operation3, policyEvent, new Date(FIXED_TIMESTAMP.getTime() + 2000));
      
      const requestEvent: RequestHumanApprovalEvent = { type: 'REQUEST_HUMAN_APPROVAL' };
      operation3 = transitionOperation(operation3, requestEvent, new Date(FIXED_TIMESTAMP.getTime() + 3000));
      
      // Still in AWAITING_HUMAN_APPROVAL, not APPROVED yet
      expect(() => transitionOperation(operation3, executionEvent, new Date(FIXED_TIMESTAMP.getTime() + 4000)))
        .toThrow(InvalidTransitionError);
    });

    it('should require both policy approval/escalation AND human approval to reach EXECUTING', () => {
      // This path should succeed: OPPORTUNITY → DECISION_PROPOSED → POLICY_APPROVED → AWAITING_HUMAN_APPROVAL → APPROVED → EXECUTING
      let operation = initialOperation;
      
      // OPPORTUNITY → DECISION_PROPOSED
      const decision = CommerceDecisionSchema.parse({
        opportunityId: OPPORTUNITY_ID,
        action: 'CREATE_PAYMENT',
        amount: 1000,
        currency: 'USD',
        recipient: 'customer-123',
        justification: 'Test decision'
      });
      const decisionEvent: DecisionProposedEvent = { type: 'DECISION_PROPOSED', decision };
      operation = transitionOperation(operation, decisionEvent, new Date(FIXED_TIMESTAMP.getTime() + 1000));
      
      // DECISION_PROPOSED → POLICY_APPROVED
      const policyResult = PolicyResultSchema.parse({
        decision: 'APPROVE',
        reason: 'Looks good'
      });
      const policyEvent: PolicyApprovedEvent = { type: 'POLICY_APPROVED', policyResult };
      operation = transitionOperation(operation, policyEvent, new Date(FIXED_TIMESTAMP.getTime() + 2000));
      
      // POLICY_APPROVED → AWAITING_HUMAN_APPROVAL
      const requestEvent: RequestHumanApprovalEvent = { type: 'REQUEST_HUMAN_APPROVAL' };
      operation = transitionOperation(operation, requestEvent, new Date(FIXED_TIMESTAMP.getTime() + 3000));
      
      // AWAITING_HUMAN_APPROVAL → APPROVED (human approval)
      const humanApprovedEvent: HumanApprovedEvent = { type: 'HUMAN_APPROVED', approvalStatus: 'APPROVED' };
      operation = transitionOperation(operation, humanApprovedEvent, new Date(FIXED_TIMESTAMP.getTime() + 4000));
      
      // APPROVED → EXECUTING (should now work)
      const executionEvent: ExecutionStartedEvent = { type: 'EXECUTION_STARTED' };
      // This should not throw
      expect(() => transitionOperation(operation, executionEvent, new Date(FIXED_TIMESTAMP.getTime() + 5000))).not.toThrow();
      
      const result = transitionOperation(operation, executionEvent, new Date(FIXED_TIMESTAMP.getTime() + 5000));
      expect(result.status).toBe('EXECUTING');
    });
  });

  describe('PayPal Order Created Path (Task 08 CP2)', () => {
    const paypalOrderInfo = PayPalOrderInfoSchema.parse({
      paypalOrderId: 'pp-order-789',
      paypalStatus: 'CREATED',
      requestId: 'exec-op-456',
      approveUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=pp-order-789',
    });

    /** Helper: drive an operation from OPPORTUNITY to EXECUTING (full approval path). */
    function driveToExecuting(): CommerceOperation {
      let operation = initialOperation;
      const decision = CommerceDecisionSchema.parse({
        opportunityId: OPPORTUNITY_ID,
        action: 'CREATE_PAYMENT',
        amount: 1000,
        currency: 'USD',
        recipient: 'customer-123',
        justification: 'Test decision'
      });
      operation = transitionOperation(operation, { type: 'DECISION_PROPOSED', decision }, new Date(FIXED_TIMESTAMP.getTime() + 1000));
      const policyResult = PolicyResultSchema.parse({ decision: 'APPROVE', reason: 'Looks good' });
      operation = transitionOperation(operation, { type: 'POLICY_APPROVED', policyResult }, new Date(FIXED_TIMESTAMP.getTime() + 2000));
      operation = transitionOperation(operation, { type: 'REQUEST_HUMAN_APPROVAL' }, new Date(FIXED_TIMESTAMP.getTime() + 3000));
      operation = transitionOperation(operation, { type: 'HUMAN_APPROVED', approvalStatus: 'APPROVED' }, new Date(FIXED_TIMESTAMP.getTime() + 4000));
      operation = transitionOperation(operation, { type: 'EXECUTION_STARTED' }, new Date(FIXED_TIMESTAMP.getTime() + 5000));
      return operation;
    }

    /** Helper: EXECUTING + PAYPAL_ORDER_CREATED → PAYPAL_ORDER_CREATED. */
    function driveToOrderCreated(): CommerceOperation {
      const executing = driveToExecuting();
      return transitionOperation(
        executing,
        { type: 'PAYPAL_ORDER_CREATED', paypalOrder: paypalOrderInfo },
        new Date(FIXED_TIMESTAMP.getTime() + 6000)
      );
    }

    /** Helper: PAYPAL_ORDER_CREATED + CAPTURE_STARTED → CAPTURE_EXECUTING. */
    function driveToCaptureExecuting(): CommerceOperation {
      const orderCreated = driveToOrderCreated();
      return transitionOperation(
        orderCreated,
        { type: 'CAPTURE_STARTED' },
        new Date(FIXED_TIMESTAMP.getTime() + 6500)
      );
    }

    /** Successful capture result: carries full truthful capture evidence. */
    function successfulCaptureResult(): ReturnType<typeof PaymentResultSchema.parse> {
      return PaymentResultSchema.parse({
        success: true,
        transactionId: 'cap-123',
        captureId: 'cap-123',
        paypalOrderId: 'pp-order-789',
        amount: 1000,
        currency: 'USD',
      });
    }

    it('should transition EXECUTING + PAYPAL_ORDER_CREATED → PAYPAL_ORDER_CREATED', () => {
      const executing = driveToExecuting();
      expect(executing.status).toBe('EXECUTING');

      const orderCreatedEvent: PayPalOrderCreatedEvent = {
        type: 'PAYPAL_ORDER_CREATED',
        paypalOrder: paypalOrderInfo,
      };
      const result = transitionOperation(executing, orderCreatedEvent, new Date(FIXED_TIMESTAMP.getTime() + 6000));

      expect(result.status).toBe('PAYPAL_ORDER_CREATED');
      // No payment result: an order being created is NOT a completed payment.
      expect(result.paymentResult).toBeUndefined();
      expect(result.updatedAt).toEqual(new Date(FIXED_TIMESTAMP.getTime() + 6000));
    });

    it('should preserve paypalOrder data exactly on the resulting operation', () => {
      const executing = driveToExecuting();
      const orderCreatedEvent: PayPalOrderCreatedEvent = {
        type: 'PAYPAL_ORDER_CREATED',
        paypalOrder: paypalOrderInfo,
      };
      const result = transitionOperation(executing, orderCreatedEvent, new Date(FIXED_TIMESTAMP.getTime() + 6000));

      expect(result.paypalOrder).toEqual(paypalOrderInfo);
      expect(result.paypalOrder?.paypalOrderId).toBe('pp-order-789');
      expect(result.paypalOrder?.paypalStatus).toBe('CREATED');
      expect(result.paypalOrder?.requestId).toBe('exec-op-456');
      expect(result.paypalOrder?.approveUrl).toBe('https://www.sandbox.paypal.com/checkoutnow?token=pp-order-789');
      // Immutable: original executing operation is unchanged.
      expect(executing.paypalOrder).toBeUndefined();
    });

    it('should parse a PayPalOrderCreatedEvent through the event schema union', () => {
      const orderCreatedEvent = {
        type: 'PAYPAL_ORDER_CREATED',
        paypalOrder: paypalOrderInfo,
      };
      const result = CommerceOperationEventSchema.safeParse(orderCreatedEvent);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe('PAYPAL_ORDER_CREATED');
        expect(result.data).toEqual(orderCreatedEvent);
      }
    });

    it('should transition PAYPAL_ORDER_CREATED + CAPTURE_STARTED → CAPTURE_EXECUTING (capture claim)', () => {
      const orderCreated = driveToOrderCreated();
      expect(orderCreated.status).toBe('PAYPAL_ORDER_CREATED');

      const captureStartedEvent: CaptureStartedEvent = { type: 'CAPTURE_STARTED' };
      const result = transitionOperation(
        orderCreated,
        captureStartedEvent,
        new Date(FIXED_TIMESTAMP.getTime() + 6500)
      );
      expect(result.status).toBe('CAPTURE_EXECUTING');
      // The claim mutates nothing else: no payment result, order data intact.
      expect(result.paymentResult).toBeUndefined();
      expect(result.paypalOrder).toEqual(paypalOrderInfo);
      expect(result.updatedAt).toEqual(new Date(FIXED_TIMESTAMP.getTime() + 6500));
      // Immutable: original order-created operation unchanged.
      expect(orderCreated.status).toBe('PAYPAL_ORDER_CREATED');
    });

    it('should transition CAPTURE_EXECUTING + PAYMENT_COMPLETED (with capture evidence) → COMPLETED', () => {
      const captureExecuting = driveToCaptureExecuting();
      expect(captureExecuting.status).toBe('CAPTURE_EXECUTING');

      const result = transitionOperation(
        captureExecuting,
        { type: 'PAYMENT_COMPLETED', paymentResult: successfulCaptureResult() },
        new Date(FIXED_TIMESTAMP.getTime() + 7000)
      );
      expect(result.status).toBe('COMPLETED');
      expect(result.paymentResult).toEqual(successfulCaptureResult());
      expect(result.paymentResult?.transactionId).toBe('cap-123');
      expect(result.paymentResult?.captureId).toBe('cap-123');
      expect(result.paymentResult?.paypalOrderId).toBe('pp-order-789');
      // PayPal order data is retained alongside the final outcome.
      expect(result.paypalOrder).toEqual(paypalOrderInfo);
    });

    it('should transition CAPTURE_EXECUTING + PAYMENT_FAILED (with order evidence) → FAILED', () => {
      const captureExecuting = driveToCaptureExecuting();
      const failedCaptureResult = PaymentResultSchema.parse({
        success: false,
        transactionId: 'cap-declined',
        paypalOrderId: 'pp-order-789',
        amount: 1000,
        currency: 'USD',
        errorMessage: 'Capture declined (simulated)',
      });
      const result = transitionOperation(
        captureExecuting,
        { type: 'PAYMENT_FAILED', paymentResult: failedCaptureResult },
        new Date(FIXED_TIMESTAMP.getTime() + 7000)
      );
      expect(result.status).toBe('FAILED');
      expect(result.paymentResult).toEqual(failedCaptureResult);
      expect(result.paypalOrder).toEqual(paypalOrderInfo);
    });

    it('should reject direct PAYMENT_COMPLETED from PAYPAL_ORDER_CREATED (claim first — Task 09)', () => {
      const orderCreated = driveToOrderCreated();
      const paymentResult = PaymentResultSchema.parse({
        success: true,
        transactionId: 'txn_after_order',
        amount: 1000,
        currency: 'USD',
      });
      expect(() =>
        transitionOperation(
          orderCreated,
          { type: 'PAYMENT_COMPLETED', paymentResult },
          new Date(FIXED_TIMESTAMP.getTime() + 7000)
        )
      ).toThrow(InvalidTransitionError);
    });

    it('should reject direct PAYMENT_FAILED from PAYPAL_ORDER_CREATED (claim first — Task 09)', () => {
      const orderCreated = driveToOrderCreated();
      const paymentResult = PaymentResultSchema.parse({
        success: false,
        amount: 1000,
        currency: 'USD',
        errorMessage: 'Capture failed (simulated)',
      });
      expect(() =>
        transitionOperation(
          orderCreated,
          { type: 'PAYMENT_FAILED', paymentResult },
          new Date(FIXED_TIMESTAMP.getTime() + 7000)
        )
      ).toThrow(InvalidTransitionError);
    });

    it('should reject PAYPAL_ORDER_CREATED event from non-EXECUTING states', () => {
      // From APPROVED (before EXECUTION_STARTED) — bypass must be rejected.
      let operation = initialOperation;
      const decision = CommerceDecisionSchema.parse({
        opportunityId: OPPORTUNITY_ID,
        action: 'CREATE_PAYMENT',
        amount: 1000,
        currency: 'USD',
        recipient: 'customer-123',
        justification: 'Test decision'
      });
      operation = transitionOperation(operation, { type: 'DECISION_PROPOSED', decision }, new Date(FIXED_TIMESTAMP.getTime() + 1000));
      const policyResult = PolicyResultSchema.parse({ decision: 'APPROVE', reason: 'Looks good' });
      operation = transitionOperation(operation, { type: 'POLICY_APPROVED', policyResult }, new Date(FIXED_TIMESTAMP.getTime() + 2000));
      operation = transitionOperation(operation, { type: 'REQUEST_HUMAN_APPROVAL' }, new Date(FIXED_TIMESTAMP.getTime() + 3000));
      operation = transitionOperation(operation, { type: 'HUMAN_APPROVED', approvalStatus: 'APPROVED' }, new Date(FIXED_TIMESTAMP.getTime() + 4000));

      const orderCreatedEvent: PayPalOrderCreatedEvent = {
        type: 'PAYPAL_ORDER_CREATED',
        paypalOrder: paypalOrderInfo,
      };
      expect(() => transitionOperation(operation, orderCreatedEvent, new Date(FIXED_TIMESTAMP.getTime() + 5000)))
        .toThrow(InvalidTransitionError);

      // From initial OPPORTUNITY state.
      expect(() => transitionOperation(initialOperation, orderCreatedEvent, new Date(FIXED_TIMESTAMP.getTime() + 1000)))
        .toThrow(InvalidTransitionError);
    });

    it('should reject invalid events from PAYPAL_ORDER_CREATED state', () => {
      const executing = driveToExecuting();
      const orderCreatedEvent: PayPalOrderCreatedEvent = {
        type: 'PAYPAL_ORDER_CREATED',
        paypalOrder: paypalOrderInfo,
      };
      const orderCreated = transitionOperation(executing, orderCreatedEvent, new Date(FIXED_TIMESTAMP.getTime() + 6000));

      // Re-emitting PAYPAL_ORDER_CREATED is illegal.
      expect(() => transitionOperation(orderCreated, orderCreatedEvent, new Date(FIXED_TIMESTAMP.getTime() + 7000)))
        .toThrow(InvalidTransitionError);

      // EXECUTION_STARTED is not allowed once the PayPal order exists.
      expect(() => transitionOperation(orderCreated, { type: 'EXECUTION_STARTED' }, new Date(FIXED_TIMESTAMP.getTime() + 7000)))
        .toThrow(InvalidTransitionError);

      // PAYPAL_PENDING is not allowed once the PayPal order exists.
      expect(() => transitionOperation(orderCreated, { type: 'PAYPAL_PENDING' }, new Date(FIXED_TIMESTAMP.getTime() + 7000)))
        .toThrow(InvalidTransitionError);

      // OUTCOME_RECORDED must still go through COMPLETED/FAILED first.
      expect(() => transitionOperation(orderCreated, { type: 'OUTCOME_RECORDED' }, new Date(FIXED_TIMESTAMP.getTime() + 7000)))
        .toThrow(InvalidTransitionError);
    });

    it('should keep the existing EXECUTING → PAYMENT_COMPLETED transition intact (Task 08 CP1 decision)', () => {
      const executing = driveToExecuting();
      const paymentResult = PaymentResultSchema.parse({
        success: true,
        transactionId: 'txn_direct',
        amount: 1000,
        currency: 'USD'
      });
      const result = transitionOperation(
        executing,
        { type: 'PAYMENT_COMPLETED', paymentResult },
        new Date(FIXED_TIMESTAMP.getTime() + 6000)
      );
      expect(result.status).toBe('COMPLETED');
    });

    it('should accept a legacy persisted snapshot without paypalOrder (backward compatibility)', () => {
      // Simulates a snapshot persisted before Task 08 CP2, after the store's
      // ISO-8601 → Date revival (the exact input CommerceOperationSchema.parse
      // receives from CommerceOperationStore). No paypalOrder field at all.
      const legacySnapshot = {
        id: OPERATION_ID,
        opportunityId: OPPORTUNITY_ID,
        status: 'COMPLETED',
        decision: {
          opportunityId: OPPORTUNITY_ID,
          action: 'CREATE_PAYMENT',
          amount: 1000,
          currency: 'USD',
          recipient: 'customer-123',
          justification: 'Test decision'
        },
        policyResult: { decision: 'APPROVE', reason: 'Looks good' },
        approvalStatus: 'APPROVED',
        paymentResult: { success: true, transactionId: 'txn_legacy', amount: 1000, currency: 'USD' },
        createdAt: FIXED_TIMESTAMP,
        updatedAt: FIXED_TIMESTAMP,
      };
      const result = CommerceOperationSchema.safeParse(legacySnapshot);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.paypalOrder).toBeUndefined();
        expect(result.data.paymentResult?.transactionId).toBe('txn_legacy');
      }

      // Also verify the raw JSON form (as stored on disk) parses once the
      // store revives its date fields — i.e. the store round-trip path.
      const legacySnapshotJson = JSON.stringify({
        ...legacySnapshot,
        createdAt: FIXED_TIMESTAMP.toISOString(),
        updatedAt: FIXED_TIMESTAMP.toISOString(),
      });
      const revived = JSON.parse(legacySnapshotJson);
      revived.createdAt = new Date(revived.createdAt);
      revived.updatedAt = new Date(revived.updatedAt);
      const result2 = CommerceOperationSchema.safeParse(revived);
      expect(result2.success).toBe(true);
      if (result2.success) {
        expect(result2.data.paypalOrder).toBeUndefined();
      }
    });
  });

  describe('Capture Executing Path (Task 09 CP2)', () => {
    const paypalOrderInfo = PayPalOrderInfoSchema.parse({
      paypalOrderId: 'pp-order-789',
      paypalStatus: 'CREATED',
      requestId: 'exec-op-456',
      approveUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=pp-order-789',
    });

    /** Helper: drive an operation to CAPTURE_EXECUTING (full path + claim). */
    function driveToCaptureExecuting(): CommerceOperation {
      let operation = initialOperation;
      const decision = CommerceDecisionSchema.parse({
        opportunityId: OPPORTUNITY_ID,
        action: 'CREATE_PAYMENT',
        amount: 1000,
        currency: 'USD',
        recipient: 'customer-123',
        justification: 'Test decision'
      });
      operation = transitionOperation(operation, { type: 'DECISION_PROPOSED', decision }, new Date(FIXED_TIMESTAMP.getTime() + 1000));
      const policyResult = PolicyResultSchema.parse({ decision: 'APPROVE', reason: 'Looks good' });
      operation = transitionOperation(operation, { type: 'POLICY_APPROVED', policyResult }, new Date(FIXED_TIMESTAMP.getTime() + 2000));
      operation = transitionOperation(operation, { type: 'REQUEST_HUMAN_APPROVAL' }, new Date(FIXED_TIMESTAMP.getTime() + 3000));
      operation = transitionOperation(operation, { type: 'HUMAN_APPROVED', approvalStatus: 'APPROVED' }, new Date(FIXED_TIMESTAMP.getTime() + 4000));
      operation = transitionOperation(operation, { type: 'EXECUTION_STARTED' }, new Date(FIXED_TIMESTAMP.getTime() + 5000));
      operation = transitionOperation(operation, { type: 'PAYPAL_ORDER_CREATED', paypalOrder: paypalOrderInfo }, new Date(FIXED_TIMESTAMP.getTime() + 6000));
      operation = transitionOperation(operation, { type: 'CAPTURE_STARTED' }, new Date(FIXED_TIMESTAMP.getTime() + 6500));
      return operation;
    }

    /** Successful capture result with full truthful capture evidence. */
    function captureEvidence(overrides: Record<string, unknown> = {}): ReturnType<typeof PaymentResultSchema.parse> {
      return PaymentResultSchema.parse({
        success: true,
        transactionId: 'cap-123',
        captureId: 'cap-123',
        paypalOrderId: 'pp-order-789',
        amount: 1000,
        currency: 'USD',
        ...overrides,
      });
    }

    it('should complete the full capture lifecycle through the claim', () => {
      const captureExecuting = driveToCaptureExecuting();
      expect(captureExecuting.status).toBe('CAPTURE_EXECUTING');

      const completed = transitionOperation(
        captureExecuting,
        { type: 'PAYMENT_COMPLETED', paymentResult: captureEvidence() },
        new Date(FIXED_TIMESTAMP.getTime() + 7000)
      );
      expect(completed.status).toBe('COMPLETED');
      expect(completed.paymentResult?.captureId).toBe('cap-123');
      expect(completed.paymentResult?.paypalOrderId).toBe('pp-order-789');

      const recorded = transitionOperation(completed, { type: 'OUTCOME_RECORDED' }, new Date(FIXED_TIMESTAMP.getTime() + 8000));
      expect(recorded.status).toBe('OUTCOME_RECORDED');
    });

    it('should reject a second CAPTURE_STARTED while CAPTURE_EXECUTING (single-flight claim)', () => {
      const captureExecuting = driveToCaptureExecuting();
      expect(() =>
        transitionOperation(captureExecuting, { type: 'CAPTURE_STARTED' }, new Date(FIXED_TIMESTAMP.getTime() + 7000))
      ).toThrow(InvalidTransitionError);
    });

    it('should reject a capture outcome without a capture ID (transactionId required)', () => {
      const captureExecuting = driveToCaptureExecuting();
      const noCaptureId = PaymentResultSchema.parse({
        success: true,
        amount: 1000,
        currency: 'USD',
        paypalOrderId: 'pp-order-789',
      });
      expect(() =>
        transitionOperation(
          captureExecuting,
          { type: 'PAYMENT_COMPLETED', paymentResult: noCaptureId },
          new Date(FIXED_TIMESTAMP.getTime() + 7000)
        )
      ).toThrow(InvalidTransitionError);
    });

    it('should reject a capture outcome without paypalOrderId evidence', () => {
      const captureExecuting = driveToCaptureExecuting();
      const noOrderEvidence = PaymentResultSchema.parse({
        success: true,
        transactionId: 'cap-123',
        amount: 1000,
        currency: 'USD',
      });
      expect(() =>
        transitionOperation(
          captureExecuting,
          { type: 'PAYMENT_COMPLETED', paymentResult: noOrderEvidence },
          new Date(FIXED_TIMESTAMP.getTime() + 7000)
        )
      ).toThrow(InvalidTransitionError);
    });

    it('should reject a capture outcome tied to a DIFFERENT PayPal order (integrity invariant)', () => {
      const captureExecuting = driveToCaptureExecuting();
      const foreignOrderEvidence = captureEvidence({ paypalOrderId: 'pp-FOREIGN-order' });
      expect(() =>
        transitionOperation(
          captureExecuting,
          { type: 'PAYMENT_COMPLETED', paymentResult: foreignOrderEvidence },
          new Date(FIXED_TIMESTAMP.getTime() + 7000)
        )
      ).toThrow(/does not match the operation's persisted order/);
      expect(() =>
        transitionOperation(
          captureExecuting,
          { type: 'PAYMENT_FAILED', paymentResult: foreignOrderEvidence },
          new Date(FIXED_TIMESTAMP.getTime() + 7000)
        )
      ).toThrow(/does not match the operation's persisted order/);
    });

    it('should reject capture outcomes from PAYPAL_ORDER_CREATED state without a claim', () => {
      let operation = initialOperation;
      const decision = CommerceDecisionSchema.parse({
        opportunityId: OPPORTUNITY_ID,
        action: 'CREATE_PAYMENT',
        amount: 1000,
        currency: 'USD',
        recipient: 'customer-123',
        justification: 'Test decision'
      });
      operation = transitionOperation(operation, { type: 'DECISION_PROPOSED', decision }, new Date(FIXED_TIMESTAMP.getTime() + 1000));
      operation = transitionOperation(operation, { type: 'POLICY_APPROVED', policyResult: PolicyResultSchema.parse({ decision: 'APPROVE', reason: 'Looks good' }) }, new Date(FIXED_TIMESTAMP.getTime() + 2000));
      operation = transitionOperation(operation, { type: 'REQUEST_HUMAN_APPROVAL' }, new Date(FIXED_TIMESTAMP.getTime() + 3000));
      operation = transitionOperation(operation, { type: 'HUMAN_APPROVED', approvalStatus: 'APPROVED' }, new Date(FIXED_TIMESTAMP.getTime() + 4000));
      operation = transitionOperation(operation, { type: 'EXECUTION_STARTED' }, new Date(FIXED_TIMESTAMP.getTime() + 5000));
      const orderCreated = transitionOperation(operation, { type: 'PAYPAL_ORDER_CREATED', paypalOrder: paypalOrderInfo }, new Date(FIXED_TIMESTAMP.getTime() + 6000));

      // Capture evidence from PAYPAL_ORDER_CREATED (no CAPTURE_STARTED claim)
      // must be rejected: outcomes are only valid from CAPTURE_EXECUTING.
      expect(() =>
        transitionOperation(
          orderCreated,
          { type: 'PAYMENT_COMPLETED', paymentResult: captureEvidence() },
          new Date(FIXED_TIMESTAMP.getTime() + 7000)
        )
      ).toThrow(InvalidTransitionError);
    });

    it('should parse a CaptureStartedEvent through the event schema union', () => {
      const result = CommerceOperationEventSchema.safeParse({ type: 'CAPTURE_STARTED' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe('CAPTURE_STARTED');
        expect(result.data).toEqual({ type: 'CAPTURE_STARTED' });
      }
      // The event is payload-free: unknown extra keys are stripped (Zod
      // default), so the persisted audit payload is always exactly
      // { type: 'CAPTURE_STARTED' } — deterministic JSON for the store.
      const withExtra = CommerceOperationEventSchema.safeParse({
        type: 'CAPTURE_STARTED',
        bogus: true,
      });
      expect(withExtra.success).toBe(true);
      if (withExtra.success) {
        expect(withExtra.data).toEqual({ type: 'CAPTURE_STARTED' });
      }
      // Unknown event types still fail.
      expect(CommerceOperationEventSchema.safeParse({ type: 'CAPTURE_RESUMED' }).success).toBe(false);
    });
  });
});