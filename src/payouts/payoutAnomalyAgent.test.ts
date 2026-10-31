import { describe, it, expect, vi } from 'vitest';
import {
  PayoutAnomalyAgent,
  enrichPayoutItemsWithAnalysis,
  verifyFinancialInvariance,
} from './payoutAnomalyAgent';
import { LLMProvider } from '../agents/provider';
import {
  generateSyntheticPayoutPopulation,
} from './syntheticData';
import { classifyPayoutPopulation, classifyPayoutItem } from './calculationEngine';

class MockLLMProvider implements LLMProvider {
  constructor(
    public responseToReturn: string = '[]',
    public shouldThrow: boolean = false,
    public errorToThrow: Error = new Error('Network error')
  ) {}

  async generateStructuredDecision(): Promise<string> {
    if (this.shouldThrow) {
      throw this.errorToThrow;
    }
    return this.responseToReturn;
  }
}

describe('PayoutAnomalyAgent (PAYOUT-02 AI Exception Intelligence)', () => {
  const allItems = classifyPayoutPopulation(generateSyntheticPayoutPopulation());
  const exceptionItems = allItems.filter((i) => i.status === 'AI_ANALYSIS_REQUIRED');

  describe('Exception Filtering Boundary', () => {
    it('isolates strictly the 17 AI_ANALYSIS_REQUIRED exceptions', () => {
      expect(exceptionItems).toHaveLength(17);
    });

    it('never sends READY or HELD items to the LLM', async () => {
      const mockProvider = new MockLLMProvider('[]');
      const spy = vi.spyOn(mockProvider, 'generateStructuredDecision');
      const agent = new PayoutAnomalyAgent(mockProvider);

      // Pass only routine READY and contractual HELD items
      const routineItems = allItems.filter((i) => i.status !== 'AI_ANALYSIS_REQUIRED');
      const result = await agent.analyzeExceptions(routineItems);

      expect(result).toEqual([]);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('Privilege Stripping & Financial Invariance', () => {
    it('strips rogue financial fields injected by LLM and preserves authoritative amounts', async () => {
      const sarah = exceptionItems.find((i) => i.id === 'payout-042')!;
      expect(sarah).toBeDefined();
      expect(sarah.netPayableCents).toBe(42870); // Authoritative $428.70

      // Adversarial LLM response injecting rogue financial and approval fields
      const adversarialResponse = JSON.stringify([
        {
          payoutItemId: 'payout-042',
          riskLevel: 'LOW',
          riskScore: 20,
          anomalyTypes: ['VELOCITY_SPIKE'],
          explanation: 'Viral video on Oct 12 verified. Conversions legitimate.',
          recommendedAction: 'ALLOW_FOR_HUMAN_APPROVAL',
          // INJECTED ROGUE FIELDS:
          netPayableCents: 1, // Attempt to alter payable amount
          amount: 999999, // Attempt to inject dollar amount
          approvedAmount: 500000,
          approvalStatus: 'APPROVED', // Attempt to bypass human approval
          executePayment: true,
          paypalAction: 'DISBURSE_IMMEDIATELY',
          overrideHold: true,
        },
      ]);

      const mockProvider = new MockLLMProvider(adversarialResponse);
      const agent = new PayoutAnomalyAgent(mockProvider);

      const analyses = await agent.analyzeExceptions([sarah]);
      expect(analyses).toHaveLength(1);

      const analysis = analyses[0];
      expect(analysis.payoutItemId).toBe('payout-042');
      expect(analysis.riskLevel).toBe('LOW');
      expect(analysis.provenance).toBe('REAL_AI');

      // Verify rogue fields are NOT present on the analysis object
      expect((analysis as Record<string, unknown>).netPayableCents).toBeUndefined();
      expect((analysis as Record<string, unknown>).approvedAmount).toBeUndefined();
      expect((analysis as Record<string, unknown>).approvalStatus).toBeUndefined();
      expect((analysis as Record<string, unknown>).executePayment).toBeUndefined();

      // Enrich payout items and verify mathematical invariance
      const enriched = enrichPayoutItemsWithAnalysis([sarah], analyses);
      expect(enriched[0].netPayableCents).toBe(42870); // 100% UNCHANGED
      expect(enriched[0].status).toBe('AI_ANALYSIS_REQUIRED'); // Human review STILL required
      expect(verifyFinancialInvariance([sarah], enriched)).toBe(true);
    });

    it('rejects AI output that invents unauthorized payout IDs', async () => {
      const sarah = exceptionItems.find((i) => i.id === 'payout-042')!;
      const invalidResponse = JSON.stringify([
        {
          payoutItemId: 'payout-INVENTED-999', // Unknown ID
          riskLevel: 'LOW',
          riskScore: 10,
          anomalyTypes: ['VELOCITY_SPIKE'],
          explanation: 'Invented record',
          recommendedAction: 'ALLOW_FOR_HUMAN_APPROVAL',
        },
      ]);

      const mockProvider = new MockLLMProvider(invalidResponse);
      const agent = new PayoutAnomalyAgent(mockProvider);

      // When LLM invents IDs, agent gracefully activates conservative fallback
      const analyses = await agent.analyzeExceptions([sarah]);
      expect(analyses).toHaveLength(1);
      expect(analyses[0].payoutItemId).toBe('payout-042');
      expect(analyses[0].provenance).toBe('SYNTHETIC_FALLBACK');
    });

    it('cannot override hard deterministic holds (below threshold / non-positive)', async () => {
      // Create a below-threshold item
      const heldRecord = classifyPayoutItem({
        id: 'payout-067',
        recipientId: 'aff-067',
        recipientName: 'John Doe',
        recipientEmail: 'john.doe@creatorhub.net',
        currency: 'USD',
        grossCommissionsCents: 4500,
        refundDeductionsCents: 284,
        chargebackDeductionsCents: 0,
        priorAdjustmentCents: 0,
        bonusCents: 0,
        historicalAverageCents: 4000,
        destinationLastChangedDaysAgo: 45,
      });
      expect(heldRecord.status).toBe('HELD_BELOW_THRESHOLD');

      const agent = new PayoutAnomalyAgent(new MockLLMProvider('[]'));
      const analyses = await agent.analyzeExceptions([heldRecord]);

      // Held item is not an AI candidate, never analyzed, status never modified
      expect(analyses).toHaveLength(0);
      const enriched = enrichPayoutItemsWithAnalysis([heldRecord], analyses);
      expect(enriched[0].status).toBe('HELD_BELOW_THRESHOLD');
      expect(enriched[0].netPayableCents).toBe(4216);
    });
  });

  describe('Offline & Failure Resilience (Fallback Behavior)', () => {
    it('activates safe deterministic fallback when provider throws an error', async () => {
      const mockProvider = new MockLLMProvider('', true, new Error('NVIDIA 503 Unavailable'));
      const agent = new PayoutAnomalyAgent(mockProvider);

      const analyses = await agent.analyzeExceptions(exceptionItems);
      expect(analyses).toHaveLength(17);

      for (const a of analyses) {
        expect(a.provenance).toBe('SYNTHETIC_FALLBACK');
        expect(['ALLOW_FOR_HUMAN_APPROVAL', 'HOLD', 'MANUAL_AUDIT']).toContain(
          a.recommendedAction
        );
      }
    });

    it('activates safe fallback when LLM returns malformed JSON', async () => {
      const mockProvider = new MockLLMProvider('Not valid JSON [ { broken');
      const agent = new PayoutAnomalyAgent(mockProvider);

      const analyses = await agent.analyzeExceptions(exceptionItems);
      expect(analyses).toHaveLength(17);
      expect(analyses[0].provenance).toBe('SYNTHETIC_FALLBACK');
    });

    it('generates contextual fallback for Sarah Jenkins', () => {
      const agent = new PayoutAnomalyAgent(null);
      const sarah = exceptionItems.find((i) => i.id === 'payout-042')!;
      const analyses = agent.generateFallbackAnalyses([sarah]);

      expect(analyses).toHaveLength(1);
      expect(analyses[0].payoutItemId).toBe('payout-042');
      expect(analyses[0].riskLevel).toBe('LOW');
      expect(analyses[0].riskScore).toBe(25);
      expect(analyses[0].recommendedAction).toBe('ALLOW_FOR_HUMAN_APPROVAL');
      expect(analyses[0].explanation).toContain('389% velocity jump');
    });

    it('generates high risk fallback for recent destination changes', () => {
      const agent = new PayoutAnomalyAgent(null);
      const marcus = exceptionItems.find((i) => i.id === 'payout-101')!; // Marcus Chen (changed 1 day ago)
      const analyses = agent.generateFallbackAnalyses([marcus]);

      expect(analyses).toHaveLength(1);
      expect(analyses[0].riskLevel).toBe('HIGH');
      expect(analyses[0].recommendedAction).toBe('HOLD');
      expect(analyses[0].explanation).toContain('Security review window');
    });

    it('generates manual audit fallback for duplicate destinations', () => {
      const agent = new PayoutAnomalyAgent(null);
      const elena = exceptionItems.find((i) => i.id === 'payout-201')!; // Elena Rostova
      const analyses = agent.generateFallbackAnalyses([elena]);

      expect(analyses).toHaveLength(1);
      expect(analyses[0].riskLevel).toBe('MEDIUM');
      expect(analyses[0].recommendedAction).toBe('MANUAL_AUDIT');
      expect(analyses[0].explanation).toContain('Shared PayPal payout destination');
    });
  });

  describe('Prompt Construction & Batch Invariant', () => {
    it('constructs a single batch prompt containing all 17 exception items', () => {
      const agent = new PayoutAnomalyAgent(null);
      const prompt = agent.buildBatchPrompt(exceptionItems);

      expect(prompt).toContain('You are an AI financial risk analyst for ACTOVRA');
      expect(prompt).toContain('payout-042'); // Sarah Jenkins
      expect(prompt).toContain('payout-101'); // Marcus Chen
      expect(prompt).toContain('payout-201'); // Elena Rostova
      expect(prompt).toContain('Sarah Jenkins');
      expect(prompt).toContain('shared-payout@creativestudio.io');
      expect(prompt).toContain('CRITICAL FINANCIAL SAFETY RULES');
      expect(prompt).toContain('AUTHORITATIVE INPUT FACTS');
    });
  });
});
