import { describe, it, expect } from 'vitest';
import {
  OpportunitySchema,
  CommerceDecisionSchema,
  PolicyResultSchema,
  ApprovalStatusSchema,
  PaymentResultSchema,
  CommerceOperationStatusSchema,
  type Opportunity,
  type CommerceDecision,
} from './schemas';

describe('Domain Schemas', () => {
  describe('OpportunitySchema', () => {
    it('should parse a valid opportunity', () => {
      const validOpportunity: Opportunity = {
        id: 'opp-001',
        title: 'Summer Promotion',
        description: 'Test opportunity',
      };
      const result = OpportunitySchema.safeParse(validOpportunity);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(validOpportunity);
      }
    });

    it('should reject missing required fields', () => {
      const invalidOpportunity = { title: 'Test' }; // missing id
      const result = OpportunitySchema.safeParse(invalidOpportunity);
      expect(result.success).toBe(false);
    });
  });

  describe('CommerceDecisionSchema', () => {
    it('should parse a valid commerce decision (amount in cents)', () => {
      const validDecision: CommerceDecision = {
        opportunityId: 'opp-001',
        action: 'CREATE_PAYMENT',
        amount: 10050, // $100.50 in cents
        currency: 'USD',
        recipient: 'customer-123',
        justification: 'Test justification',
      };
      const result = CommerceDecisionSchema.safeParse(validDecision);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(validDecision);
      }
    });

    it('should reject negative amount', () => {
      const invalidDecision = {
        opportunityId: 'opp-001',
        action: 'CREATE_PAYMENT',
        amount: -10,
        currency: 'USD',
        recipient: 'customer-123',
        justification: 'Test',
      };
      const result = CommerceDecisionSchema.safeParse(invalidDecision);
      expect(result.success).toBe(false);
    });

    it('should reject zero amount', () => {
      const invalidDecision = {
        opportunityId: 'opp-001',
        action: 'CREATE_PAYMENT',
        amount: 0,
        currency: 'USD',
        recipient: 'customer-123',
        justification: 'Test',
      };
      const result = CommerceDecisionSchema.safeParse(invalidDecision);
      expect(result.success).toBe(false);
    });

    it('should reject invalid currency', () => {
      const invalidDecision = {
        opportunityId: 'opp-001',
        action: 'CREATE_PAYMENT',
        amount: 5000, // $50.00
        currency: 'XYZ', // not in enum
        recipient: 'customer-123',
        justification: 'Test',
      };
      const result = CommerceDecisionSchema.safeParse(invalidDecision);
      expect(result.success).toBe(false);
    });

    it('should reject invalid action', () => {
      const invalidDecision = {
        opportunityId: 'opp-001',
        action: 'INVALID_ACTION', // not in enum
        amount: 5000,
        currency: 'USD',
        recipient: 'customer-123',
        justification: 'Test',
      };
      const result = CommerceDecisionSchema.safeParse(invalidDecision);
      expect(result.success).toBe(false);
    });

    it('should require all fields', () => {
      const invalidDecision = {
        opportunityId: 'opp-001',
        action: 'CREATE_PAYMENT',
        // missing amount, currency, recipient, justification
      };
      const result = CommerceDecisionSchema.safeParse(invalidDecision);
      expect(result.success).toBe(false);
    });
  });

  describe('PolicyResultSchema', () => {
    it('should parse valid policy results', () => {
      const validResults = [
        { decision: 'APPROVE', reason: 'All good' },
        { decision: 'REJECT', reason: 'Too risky' },
        { decision: 'ESCALATE', reason: 'Needs review' },
      ];
      for (const result of validResults) {
        const parsed = PolicyResultSchema.safeParse(result);
        expect(parsed.success).toBe(true);
        if (parsed.success) {
          expect(parsed.data).toEqual(result);
        }
      }
    });

    it('should parse valid policy results with reasonCode', () => {
      const validResult = {
        decision: 'APPROVE',
        reason: 'All good',
        reasonCode: 'OTHER',
      };
      const parsed = PolicyResultSchema.safeParse(validResult);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data).toEqual(validResult);
      }
    });

    it('should reject invalid decision', () => {
      const invalidResult = { decision: 'MAYBE', reason: 'Unsure' };
      const result = PolicyResultSchema.safeParse(invalidResult);
      expect(result.success).toBe(false);
    });
  });

  describe('ApprovalStatusSchema', () => {
    it('should parse valid approval statuses', () => {
      const validStatuses = ['PENDING', 'APPROVED', 'REJECTED'];
      for (const status of validStatuses) {
        const result = ApprovalStatusSchema.safeParse(status);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toBe(status);
        }
      }
    });

    it('should reject invalid status', () => {
      const result = ApprovalStatusSchema.safeParse('UNKNOWN');
      expect(result.success).toBe(false);
    });
  });

  describe('PaymentResultSchema', () => {
    it('should parse a successful payment result', () => {
      const validResult = {
        success: true,
        transactionId: 'txn_123',
        amount: 10000, // $100.00 in cents
        currency: 'USD',
      };
      const result = PaymentResultSchema.safeParse(validResult);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(validResult);
      }
    });

    it('should parse a failed payment result', () => {
      const validResult = {
        success: false,
        errorMessage: 'Insufficient funds',
      };
      const result = PaymentResultSchema.safeParse(validResult);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(validResult);
      }
    });

    it('should parse a capture result with full capture evidence (Task 09)', () => {
      const captureResult = {
        success: true,
        transactionId: 'cap-123',
        captureId: 'cap-123',
        paypalOrderId: 'pp-order-789',
        amount: 1000,
        currency: 'USD',
      };
      const result = PaymentResultSchema.safeParse(captureResult);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(captureResult);
      }
    });

    it('should accept a capture result with only the required evidence fields', () => {
      // captureId and paypalOrderId are independently optional; a minimal
      // truthful record may carry just the transactionId (capture ID).
      const minimalResult = {
        success: true,
        transactionId: 'cap-123',
      };
      const result = PaymentResultSchema.safeParse(minimalResult);
      expect(result.success).toBe(true);
    });

    it('should reject invalid currency in payment result', () => {
      const invalidResult = {
        success: true,
        transactionId: 'txn_123',
        amount: 5000, // $50.00
        currency: 'XYZ', // invalid
      };
      const result = PaymentResultSchema.safeParse(invalidResult);
      expect(result.success).toBe(false);
    });

    it('should reject non-string captureId and paypalOrderId', () => {
      expect(
        PaymentResultSchema.safeParse({
          success: true,
          transactionId: 'cap-123',
          captureId: 12345,
        }).success
      ).toBe(false);
      expect(
        PaymentResultSchema.safeParse({
          success: true,
          transactionId: 'cap-123',
          paypalOrderId: { id: 'pp-order-789' },
        }).success
      ).toBe(false);
    });
  });

  describe('CommerceOperationStatusSchema', () => {
    it('should parse all valid operation statuses', () => {
      const validStatuses = [
        'OPPORTUNITY',
        'DECISION_PROPOSED',
        'POLICY_APPROVED',
        'POLICY_REJECTED',
        'POLICY_ESCALATED',
        'AWAITING_HUMAN_APPROVAL',
        'APPROVED',
        'REJECTED_BY_HUMAN',
        'EXECUTING',
        'PAYPAL_PENDING',
        'PAYPAL_ORDER_CREATED',
        'CAPTURE_EXECUTING',
        'COMPLETED',
        'FAILED',
        'OUTCOME_RECORDED',
      ];
      for (const status of validStatuses) {
        const result = CommerceOperationStatusSchema.safeParse(status);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toBe(status);
        }
      }
    });

    it('should reject invalid status', () => {
      const result = CommerceOperationStatusSchema.safeParse('UNKNOWN_STATUS');
      expect(result.success).toBe(false);
    });
  });
});