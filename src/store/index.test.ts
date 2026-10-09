import { describe, test, expect, beforeEach } from 'vitest';
import { 
  DecisionProposedEventSchema,
  PolicyApprovedEventSchema,
  RequestHumanApprovalEventSchema,
  HumanApprovedEventSchema,
  ExecutionStartedEventSchema,
  PayPalPendingEventSchema,
  PaymentCompletedEventSchema,
  OutcomeRecordedEventSchema
} from '../domain/events';
import { commerceStore } from './index';

// Helper functions to create valid events
function createDecisionProposedEvent(overrides: Partial<any> = {}) {
  return DecisionProposedEventSchema.parse({
    type: 'DECISION_PROPOSED',
    decision: {
      opportunityId: 'opp-123',
      action: 'CREATE_PAYMENT',
      amount: 1000,
      currency: 'USD',
      recipient: 'customer@example.com',
      justification: 'Test payment',
      ...overrides.decision
    }
  });
}

function createPolicyApprovedEvent(overrides: Partial<any> = {}) {
  return PolicyApprovedEventSchema.parse({
    type: 'POLICY_APPROVED',
    policyResult: {
      decision: 'APPROVE',
      reason: 'Within limits',
      reasonCode: undefined,
      ...overrides.policyResult
    }
  });
}

function createRequestHumanApprovalEvent() {
  return RequestHumanApprovalEventSchema.parse({
    type: 'REQUEST_HUMAN_APPROVAL'
  });
}

function createHumanApprovedEvent() {
  return HumanApprovedEventSchema.parse({
    type: 'HUMAN_APPROVED',
    approvalStatus: 'APPROVED'
  });
}

function createExecutionStartedEvent() {
  return ExecutionStartedEventSchema.parse({
    type: 'EXECUTION_STARTED'
  });
}

function createPayPalPendingEvent() {
  return PayPalPendingEventSchema.parse({
    type: 'PAYPAL_PENDING'
  });
}

function createPaymentCompletedEvent(overrides: Partial<any> = {}) {
  return PaymentCompletedEventSchema.parse({
    type: 'PAYMENT_COMPLETED',
    paymentResult: {
      success: true,
      transactionId: 'txn_123',
      amount: 1000,
      currency: 'USD',
      errorMessage: undefined,
      ...overrides.paymentResult
    }
  });
}

function createOutcomeRecordedEvent() {
  return OutcomeRecordedEventSchema.parse({
    type: 'OUTCOME_RECORDED'
  });
}

describe('CommerceStore', () => {
  beforeEach(() => {
    // Clear store before each test by removing all operations
    // We don't have a clear method, so we'll create a new store instance for each test
    // But since we're using the exported instance, we need to reset it.
    // For simplicity, we'll remove any operations we know about.
    // In a real test, we might want to mock the store or have a reset method.
    // We'll just remove the operation we use in each test at the end.
  });

  test('should start and track an operation', () => {
    const operationId = 'op-123';
    const opportunityId = 'opp-123';
    const timestamp = new Date('2026-01-01T00:00:00Z');
    
    commerceStore.startOperation(operationId, opportunityId, timestamp);
    
    expect(commerceStore.hasOperation(operationId)).toBe(true);
    
    const state = commerceStore.getOperationState(operationId);
    expect(state).toBeDefined();
    expect(state?.id).toBe(operationId);
    expect(state?.opportunityId).toBe(opportunityId);
    expect(state?.status).toBe('OPPORTUNITY');
    expect(state?.createdAt).toEqual(timestamp);
    expect(state?.updatedAt).toEqual(timestamp);
    
    // Cleanup
    commerceStore.removeOperation(operationId);
  });

  test('should record events and maintain audit trail', () => {
    const operationId = 'op-123';
    const opportunityId = 'opp-123';
    const initialTimestamp = new Date('2026-01-01T00:00:00Z');
    
    commerceStore.startOperation(operationId, opportunityId, initialTimestamp);
    
    // Record a decision proposed event
    const event1Timestamp = new Date('2026-01-01T00:01:00Z');
    const decisionEvent = createDecisionProposedEvent();
    commerceStore.recordEvent(operationId, decisionEvent, event1Timestamp);
    
    // Record a policy approved event
    const event2Timestamp = new Date('2026-01-01T00:02:00Z');
    const policyEvent = createPolicyApprovedEvent();
    commerceStore.recordEvent(operationId, policyEvent, event2Timestamp);
    
    // Check audit trail
    const auditTrail = commerceStore.getAuditTrail(operationId);
    expect(auditTrail).toHaveLength(2);
    expect(auditTrail?.[0].event).toEqual(decisionEvent);
    expect(auditTrail?.[0].timestamp).toEqual(event1Timestamp);
    expect(auditTrail?.[1].event).toEqual(policyEvent);
    expect(auditTrail?.[1].timestamp).toEqual(event2Timestamp);
    
    // Cleanup
    commerceStore.removeOperation(operationId);
  });

  test('should correctly transition operation state through events', () => {
    const operationId = 'op-123';
    const opportunityId = 'opp-123';
    const initialTimestamp = new Date('2026-01-01T00:00:00Z');
    
    commerceStore.startOperation(operationId, opportunityId, initialTimestamp);
    
    // Initial state should be OPPORTUNITY
    let state = commerceStore.getOperationState(operationId);
    expect(state?.status).toBe('OPPORTUNITY');
    
    // After DECISION_PROPOSED event
    commerceStore.recordEvent(operationId, createDecisionProposedEvent(), new Date('2026-01-01T00:01:00Z'));
    state = commerceStore.getOperationState(operationId);
    expect(state?.status).toBe('DECISION_PROPOSED');
    expect(state?.decision).toEqual(createDecisionProposedEvent().decision);
    
    // After POLICY_APPROVED event
    commerceStore.recordEvent(operationId, createPolicyApprovedEvent(), new Date('2026-01-01T00:02:00Z'));
    state = commerceStore.getOperationState(operationId);
    expect(state?.status).toBe('POLICY_APPROVED');
    expect(state?.policyResult).toEqual(createPolicyApprovedEvent().policyResult);
    
    // After REQUEST_HUMAN_APPROVAL event
    commerceStore.recordEvent(operationId, createRequestHumanApprovalEvent(), new Date('2026-01-01T00:03:00Z'));
    state = commerceStore.getOperationState(operationId);
    expect(state?.status).toBe('AWAITING_HUMAN_APPROVAL');
    
    // After HUMAN_APPROVED event
    commerceStore.recordEvent(operationId, createHumanApprovedEvent(), new Date('2026-01-01T00:04:00Z'));
    state = commerceStore.getOperationState(operationId);
    expect(state?.status).toBe('APPROVED');
    expect(state?.approvalStatus).toBe('APPROVED');
    
    // After EXECUTION_STARTED event
    commerceStore.recordEvent(operationId, createExecutionStartedEvent(), new Date('2026-01-01T00:05:00Z'));
    state = commerceStore.getOperationState(operationId);
    expect(state?.status).toBe('EXECUTING');
    
    // After PAYPAL_PENDING event
    commerceStore.recordEvent(operationId, createPayPalPendingEvent(), new Date('2026-01-01T00:06:00Z'));
    state = commerceStore.getOperationState(operationId);
    expect(state?.status).toBe('PAYPAL_PENDING');
    
    // After PAYMENT_COMPLETED event
    commerceStore.recordEvent(operationId, createPaymentCompletedEvent(), new Date('2026-01-01T00:07:00Z'));
    state = commerceStore.getOperationState(operationId);
    expect(state?.status).toBe('COMPLETED');
    expect(state?.paymentResult).toEqual(createPaymentCompletedEvent().paymentResult);
    
    // After OUTCOME_RECORDED event
    commerceStore.recordEvent(operationId, createOutcomeRecordedEvent(), new Date('2026-01-01T00:08:00Z'));
    state = commerceStore.getOperationState(operationId);
    expect(state?.status).toBe('OUTCOME_RECORDED');
    
    // Cleanup
    commerceStore.removeOperation(operationId);
  });

  test('should throw error when recording event for non-existent operation', () => {
    expect(() => {
      commerceStore.recordEvent('non-existent', createDecisionProposedEvent(), new Date());
    }).toThrow('Operation with ID non-existent not found');
  });

  test('should throw error when starting duplicate operation', () => {
    const operationId = 'op-123';
    const opportunityId = 'opp-123';
    const timestamp = new Date('2026-01-01T00:00:00Z');
    
    commerceStore.startOperation(operationId, opportunityId, timestamp);
    
    expect(() => {
      commerceStore.startOperation(operationId, opportunityId, timestamp);
    }).toThrow(`Operation with ID ${operationId} already exists`);
    
    // Cleanup
    commerceStore.removeOperation(operationId);
  });

  test('should return undefined for non-existent operation state', () => {
    const state = commerceStore.getOperationState('non-existent');
    expect(state).toBeUndefined();
  });

  test('should return undefined for non-existent operation audit trail', () => {
    const auditTrail = commerceStore.getAuditTrail('non-existent');
    expect(auditTrail).toBeUndefined();
  });
});