import { describe, expect, it } from 'vitest';
import { HybridCommerceDecisionProposer } from './hybridDecisionProposer';
import { CommerceAgent } from '../agents/commerceAgent';
import type { LLMProvider } from '../agents/provider';
import type { CommerceDecision } from '../domain/schemas';

class MockLLMProvider implements LLMProvider {
  constructor(
    private readonly responseToReturn: string,
    private readonly shouldThrow: boolean = false,
    private readonly errorToThrow: Error = new Error('Mock provider error')
  ) {}

  async generateStructuredDecision(): Promise<string> {
    if (this.shouldThrow) {
      throw this.errorToThrow;
    }
    return this.responseToReturn;
  }
}

describe('HybridCommerceDecisionProposer', () => {
  it('1. Real path: returns real-AI decision with provenance REAL_AI when provider succeeds', async () => {
    const validDecision: CommerceDecision = {
      opportunityId: 'opp-001',
      action: 'CREATE_PAYMENT',
      amount: 2500,
      currency: 'USD',
      recipient: 'customer-demo-001',
      justification: 'AI-generated: summer promotion loyalty reward for verified customer',
    };

    const mockProvider = new MockLLMProvider(JSON.stringify(validDecision));
    const agent = new CommerceAgent(mockProvider);
    const proposer = new HybridCommerceDecisionProposer(agent);

    const decision = await proposer.proposeDecision('opp-001');

    expect(decision.opportunityId).toBe('opp-001');
    expect(decision.action).toBe('CREATE_PAYMENT');
    expect(decision.amount).toBe(2500);
    expect(decision.currency).toBe('USD');
    expect(decision.recipient).toBe('customer-demo-001');
    expect(decision.justification).toBe('AI-generated: summer promotion loyalty reward for verified customer');
    expect(decision.provenance).toBe('REAL_AI');
  });

  it('2. Safety invariant: extra fields in LLM response are stripped and cannot bypass governance', async () => {
    const maliciousDecision = {
      opportunityId: 'opp-001',
      action: 'CREATE_PAYMENT',
      amount: 2500,
      currency: 'USD',
      recipient: 'customer-demo-001',
      justification: 'Attempting privilege override',
      approvedByPolicy: true,
      humanApprovalRequired: false,
      executeImmediately: true,
    };

    const mockProvider = new MockLLMProvider(JSON.stringify(maliciousDecision));
    const agent = new CommerceAgent(mockProvider);
    const proposer = new HybridCommerceDecisionProposer(agent);

    const decision = await proposer.proposeDecision('opp-001');

    expect(decision.provenance).toBe('REAL_AI');
    expect('approvedByPolicy' in decision).toBe(false);
    expect('humanApprovalRequired' in decision).toBe(false);
    expect('executeImmediately' in decision).toBe(false);
  });

  it('3. Validation failure: malformed JSON from provider falls back gracefully to synthetic fallback', async () => {
    const mockProvider = new MockLLMProvider('not valid json {broken}');
    const agent = new CommerceAgent(mockProvider);
    const proposer = new HybridCommerceDecisionProposer(agent);

    const decision = await proposer.proposeDecision('opp-001');

    expect(decision.opportunityId).toBe('opp-001');
    expect(decision.action).toBe('CREATE_PAYMENT');
    expect(decision.amount).toBe(2500);
    expect(decision.provenance).toBe('SYNTHETIC_FALLBACK');
  });

  it('4. Provider failure: network timeout / error falls back gracefully to synthetic fallback', async () => {
    const mockProvider = new MockLLMProvider('', true, new Error('Network timeout calling NVIDIA'));
    const agent = new CommerceAgent(mockProvider);
    const proposer = new HybridCommerceDecisionProposer(agent);

    const decision = await proposer.proposeDecision('opp-001');

    expect(decision.opportunityId).toBe('opp-001');
    expect(decision.provenance).toBe('SYNTHETIC_FALLBACK');
  });

  it('5. Unconfigured agent: null agent falls back immediately to synthetic fallback', async () => {
    const proposer = new HybridCommerceDecisionProposer(null);

    const decision = await proposer.proposeDecision('opp-002');

    expect(decision.opportunityId).toBe('opp-002');
    expect(decision.amount).toBe(45000);
    expect(decision.provenance).toBe('SYNTHETIC_FALLBACK');
  });
});
