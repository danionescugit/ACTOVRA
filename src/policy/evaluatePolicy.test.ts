import { describe, it, expect } from 'vitest';
import { evaluatePolicy } from './evaluatePolicy';
import { validatedSyntheticPolicyConfig } from './policyConfig';
import { CommerceDecisionSchema } from '../domain/schemas';
import type { CommerceDecision } from '../domain/schemas';
import { syntheticOpportunities } from '../domain/data';

// Helper to create a base valid decision
function baseDecision(overrides: Partial<CommerceDecision> = {}): CommerceDecision {
  return {
    opportunityId: 'opp-001',
    action: 'CREATE_PAYMENT',
    amount: 1000, // $10.00 in cents
    currency: 'USD',
    recipient: 'customer-123',
    justification: 'Test justification',
    ...overrides,
  };
}

describe('evaluatePolicy', () => {
  const config = validatedSyntheticPolicyConfig;
  const opportunities = syntheticOpportunities;

  describe('APPROVE cases', () => {
    it('should approve a valid decision below automatic threshold', () => {
      const decision = baseDecision({ amount: 4000 }); // $40.00 < $50.00 automatic max
      const result = evaluatePolicy(decision, config, opportunities);
      expect(result.decision).toBe('APPROVE');
      expect(result.reasonCode).toBeUndefined();
    });

    it('should approve exactly at automatic threshold', () => {
      const decision = baseDecision({ amount: 5000 }); // $50.00 == automatic max
      const result = evaluatePolicy(decision, config, opportunities);
      expect(result.decision).toBe('APPROVE');
    });
  });

  describe('ESCALATE cases', () => {
    it('should escalate when amount exceeds automatic threshold but within human max', () => {
      const decision = baseDecision({ amount: 5001 }); // $50.01 > $50.00
      const result = evaluatePolicy(decision, config, opportunities);
      expect(result.decision).toBe('ESCALATE');
      expect(result.reasonCode).toBe('AMOUNT_EXCEEDS_AUTOMATIC_MAX');
    });

    it('should escalate at one minor unit above automatic threshold', () => {
      const decision = baseDecision({ amount: 5000 + 1 });
      const result = evaluatePolicy(decision, config, opportunities);
      expect(result.decision).toBe('ESCALATE');
    });

    it('should escalate when amount is below human max but above automatic', () => {
      const decision = baseDecision({ amount: 25000 }); // $250.00
      const result = evaluatePolicy(decision, config, opportunities);
      expect(result.decision).toBe('ESCALATE');
    });

    // At human max exactly, we still escalate because REJECT only happens when amount > humanMax
    it('should escalate at human max amount', () => {
      const decision = baseDecision({ amount: 50000 }); // $500.00 == human max
      const result = evaluatePolicy(decision, config, opportunities);
      expect(result.decision).toBe('ESCALATE');
      expect(result.reasonCode).toBe('AMOUNT_EXCEEDS_AUTOMATIC_MAX');
    });
  });

  describe('REJECT cases', () => {
    it('should reject when amount exceeds human maximum', () => {
      const decision = baseDecision({ amount: 50001 }); // $500.01 > $500.00
      const result = evaluatePolicy(decision, config, opportunities);
      expect(result.decision).toBe('REJECT');
      expect(result.reasonCode).toBe('AMOUNT_EXCEEDS_HUMAN_MAX');
    });

    it('should reject at one minor unit above human maximum', () => {
      const decision = baseDecision({ amount: 50000 + 1 });
      const result = evaluatePolicy(decision, config, opportunities);
      expect(result.decision).toBe('REJECT');
    });

    it('should reject disallowed action', () => {
      const decision = baseDecision({ action: 'UPDATE_SUBSCRIPTION' }); // not in allowedActions
      const result = evaluatePolicy(decision, config, opportunities);
      expect(result.decision).toBe('REJECT');
      expect(result.reasonCode).toBe('ACTION_NOT_ALLOWED');
    });

    it('should reject unsupported currency', () => {
      // Using GBP which is not in allowedCurrencies (we restricted to USD, EUR)
      const decision = baseDecision({ currency: 'GBP' });
      const result = evaluatePolicy(decision, config, opportunities);
      expect(result.decision).toBe('REJECT');
      expect(result.reasonCode).toBe('CURRENCY_NOT_ALLOWED');
    });

    it('should reject missing/empty recipient', () => {
      const decision = baseDecision({ recipient: '' });
      const result = evaluatePolicy(decision, config, opportunities);
      expect(result.decision).toBe('REJECT');
      expect(result.reasonCode).toBe('RECIPIENT_NOT_ALLOWED');
    });

    it('should reject missing/blank justification', () => {
      const decision = baseDecision({ justification: '   ' });
      const result = evaluatePolicy(decision, config, opportunities);
      expect(result.decision).toBe('REJECT');
      expect(result.reasonCode).toBe('JUSTIFICATION_MISSING');
    });

    it('should reject unknown opportunity', () => {
      const decision = baseDecision({ opportunityId: 'unknown-opp' });
      const result = evaluatePolicy(decision, config, opportunities);
      expect(result.decision).toBe('REJECT');
      expect(result.reasonCode).toBe('OPPORTUNITY_NOT_FOUND');
    });
  });

  describe('Rule precedence', () => {
    it('should reject when both escalation and hard rejection conditions exist (disallowed recipient + high amount)', () => {
      const decision = baseDecision({
        recipient: 'bad-actor',
        amount: 60000, // above human max
      });
      // Create a custom config with allowedRecipients list to test recipient rejection
      const configWithRecipients = {
        ...config,
        allowedRecipients: ['good-customer'],
      };
      const result = evaluatePolicy(decision, configWithRecipients, opportunities);
      expect(result.decision).toBe('REJECT');
      // Since recipient is not in allowed list, it should be REJECT with RECIPIENT_NOT_ALLOWED
      expect(result.reasonCode).toBe('RECIPIENT_NOT_ALLOWED');
    });

    it('should reject unsupported currency even if amount is low', () => {
      const decision = baseDecision({ currency: 'GBP', amount: 1000 }); // GBP not allowed
      const result = evaluatePolicy(decision, config, opportunities);
      expect(result.decision).toBe('REJECT');
      expect(result.reasonCode).toBe('CURRENCY_NOT_ALLOWED');
    });
  });

  describe('Boundary tests', () => {
    it('should approve at automatic max - 1 cent', () => {
      const decision = baseDecision({ amount: 4999 }); // $49.99
      const result = evaluatePolicy(decision, config, opportunities);
      expect(result.decision).toBe('APPROVE');
    });

    it('should approve at automatic max', () => {
      const decision = baseDecision({ amount: 5000 });
      const result = evaluatePolicy(decision, config, opportunities);
      expect(result.decision).toBe('APPROVE');
    });

    it('should escalate at automatic max + 1 cent', () => {
      const decision = baseDecision({ amount: 5001 });
      const result = evaluatePolicy(decision, config, opportunities);
      expect(result.decision).toBe('ESCALATE');
    });

    it('should escalate at human max - 1 cent', () => {
      const decision = baseDecision({ amount: 49999 }); // $499.99
      const result = evaluatePolicy(decision, config, opportunities);
      expect(result.decision).toBe('ESCALATE');
    });

    it('should escalate at human max', () => {
      const decision = baseDecision({ amount: 50000 });
      const result = evaluatePolicy(decision, config, opportunities);
      expect(result.decision).toBe('ESCALATE');
    });

    it('should reject at human max + 1 cent', () => {
      const decision = baseDecision({ amount: 50001 });
      const result = evaluatePolicy(decision, config, opportunities);
      expect(result.decision).toBe('REJECT');
    });
  });

  describe('Determinism', () => {
    it('should produce identical output for repeated identical input', () => {
      const decision = baseDecision({ amount: 7500 });
      const result1 = evaluatePolicy(decision, config, opportunities);
      const result2 = evaluatePolicy(decision, config, opportunities);
      expect(result1).toEqual(result2);
    });
  });

  describe('Security test: extra fields should not influence policy', () => {
    it('should ignore extra fields in decision object', () => {
      // Create a decision with extra fields, then parse it through the schema to get a clean decision
      const dirtyDecision = {
        opportunityId: 'opp-001',
        action: 'CREATE_PAYMENT',
        amount: 1000,
        currency: 'USD',
        recipient: 'customer-123',
        justification: 'Test justification',
        // Extra fields that might be malicious - these will be stripped by Zod parsing
        maliciousField: 'delete_all_data',
        anotherBadField: true,
      };
      // Parse it with the schema to get a clean decision (this is what would happen in the agent flow)
      const cleanDecision = CommerceDecisionSchema.parse(dirtyDecision);
      // Now evaluate
      const result = evaluatePolicy(cleanDecision, config, opportunities);
      // The extra field should not affect the outcome; we expect APPROVE because the core fields are valid and below threshold.
      expect(result.decision).toBe('APPROVE');
    });
  });
});