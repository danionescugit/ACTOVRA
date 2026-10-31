import { describe, it, expect } from 'vitest';
import { CommerceAgent } from './commerceAgent';
import { LLMProvider } from './provider';
import { CommerceDecisionSchema } from '../domain/schemas';

// Mock LLM provider for testing
class MockLLMProvider implements LLMProvider {
  private responseToReturn: string;
  private shouldThrowError: boolean;
  private errorToThrow: Error;

  constructor(responseToReturn: string = '', shouldThrowError: boolean = false, errorToThrow: Error = new Error('Mock error')) {
    this.responseToReturn = responseToReturn;
    this.shouldThrowError = shouldThrowError;
    this.errorToThrow = errorToThrow;
  }

  async generateStructuredDecision(prompt: string): Promise<string> {
    void prompt;
    if (this.shouldThrowError) {
      throw this.errorToThrow;
    }
    return this.responseToReturn;
  }
}

describe('CommerceAgent', () => {
  const businessContext = 'Synthetic business context for testing';
  const opportunityId = 'opp-001';

  describe('proposeDecision', () => {
    it('should return a valid CommerceDecision when provider returns valid JSON', async () => {
      const mockDecision = {
        opportunityId: 'opp-001',
        action: 'CREATE_PAYMENT' as const,
        amount: 1000, // $10.00 in cents
        currency: 'USD' as const,
        recipient: 'customer-123',
        justification: 'Test justification',
      };
      const mockProvider = new MockLLMProvider(JSON.stringify(mockDecision));
      const agent = new CommerceAgent(mockProvider);

      const result = await agent.proposeDecision(opportunityId, businessContext);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.decision).toEqual({
          ...mockDecision,
          provenance: 'REAL_AI',
        });
        // Additional validation: ensure it passes Zod schema
        const parsed = CommerceDecisionSchema.safeParse(result.decision);
        expect(parsed.success).toBe(true);
      }
    });

    it('should reject when provider returns malformed JSON', async () => {
      const mockProvider = new MockLLMProvider('{ not valid json');
      const agent = new CommerceAgent(mockProvider);

      const result = await agent.proposeDecision(opportunityId, businessContext);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(Error);
        expect(result.error.name).toBe('ValidationError');
      }
    });

    it('should reject when provider returns missing required field', async () => {
      const invalidDecision = {
        opportunityId: 'opp-001',
        action: 'CREATE_PAYMENT',
        amount: 1000,
        currency: 'USD',
        recipient: 'customer-123',
        // missing justification
      };
      const mockProvider = new MockLLMProvider(JSON.stringify(invalidDecision));
      const agent = new CommerceAgent(mockProvider);

      const result = await agent.proposeDecision(opportunityId, businessContext);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(Error);
        expect(result.error.name).toBe('ValidationError');
      }
    });

    it('should reject when provider returns invalid amount (negative)', async () => {
      const invalidDecision = {
        opportunityId: 'opp-001',
        action: 'CREATE_PAYMENT',
        amount: -100, // negative
        currency: 'USD',
        recipient: 'customer-123',
        justification: 'Test',
      };
      const mockProvider = new MockLLMProvider(JSON.stringify(invalidDecision));
      const agent = new CommerceAgent(mockProvider);

      const result = await agent.proposeDecision(opportunityId, businessContext);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(Error);
        expect(result.error.name).toBe('ValidationError');
      }
    });

    it('should reject when provider returns invalid action', async () => {
      const invalidDecision = {
        opportunityId: 'opp-001',
        action: 'INVALID_ACTION',
        amount: 1000,
        currency: 'USD',
        recipient: 'customer-123',
        justification: 'Test',
      };
      const mockProvider = new MockLLMProvider(JSON.stringify(invalidDecision));
      const agent = new CommerceAgent(mockProvider);

      const result = await agent.proposeDecision(opportunityId, businessContext);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(Error);
        expect(result.error.name).toBe('ValidationError');
      }
    });

    it('should reject when extra fields attempt to set policy/approval state', async () => {
      const decisionWithExtraFields = {
        opportunityId: 'opp-001',
        action: 'CREATE_PAYMENT',
        amount: 1000,
        currency: 'USD',
        recipient: 'customer-123',
        justification: 'Test',
        // These extra fields should be stripped by Zod validation
        approvedByPolicy: true,
        humanApprovalRequired: false,
        paypalExecuteNow: true,
      };
      const mockProvider = new MockLLMProvider(JSON.stringify(decisionWithExtraFields));
      const agent = new CommerceAgent(mockProvider);

      const result = await agent.proposeDecision(opportunityId, businessContext);

      expect(result.success).toBe(true);
      if (result.success) {
        // The extra fields should not be in the validated decision
        expect('approvedByPolicy' in result.decision).toBe(false);
        expect('humanApprovalRequired' in result.decision).toBe(false);
        expect('paypalExecuteNow' in result.decision).toBe(false);
        // Core fields should be present
        expect(result.decision.opportunityId).toBe('opp-001');
        expect(result.decision.action).toBe('CREATE_PAYMENT');
      }
    });

    it('should reject when opportunity ID does not match', async () => {
      const invalidDecision = {
        opportunityId: 'different-opp-id',
        action: 'CREATE_PAYMENT',
        amount: 1000,
        currency: 'USD',
        recipient: 'customer-123',
        justification: 'Test',
      };
      const mockProvider = new MockLLMProvider(JSON.stringify(invalidDecision));
      const agent = new CommerceAgent(mockProvider);

      const result = await agent.proposeDecision(opportunityId, businessContext);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.name).toBe('ValidationError');
      }
    });

    it('should return ProviderError when provider throws network error', async () => {
      const mockProvider = new MockLLMProvider('', true, new Error('Network timeout'));
      const agent = new CommerceAgent(mockProvider);

      const result = await agent.proposeDecision(opportunityId, businessContext);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(Error);
        expect(result.error.name).toBe('ProviderError');
      }
    });

    it('should return ConfigurationError when NVIDIA_API_KEY is missing (via factory method)', () => {
      // Temporarily unset the environment variable for this test
      const originalEnv = process.env.NVIDIA_API_KEY;
      delete process.env.NVIDIA_API_KEY;

      // Test that the factory method throws ConfigurationError
      expect(() => {
        CommerceAgent.createWithNVIDIAFromEnv();
      }).toThrowError(/NVIDIA_API_KEY environment variable is required but not set/);
      
      // Restore environment variable
      if (originalEnv !== undefined) {
        process.env.NVIDIA_API_KEY = originalEnv;
      } else {
        delete process.env.NVIDIA_API_KEY;
      }
    });
  });
});