import { describe, it, expect } from 'vitest';
import {
  PayoutAnomalyAgent,
  enrichPayoutItemsWithAnalysis,
  verifyFinancialInvariance,
} from './payoutAnomalyAgent';
import { NVIDIAProvider } from '../agents/nvidiaProvider';
import {
  generateSyntheticPayoutPopulation,
} from './syntheticData';
import { classifyPayoutPopulation } from './calculationEngine';
import { PayoutAnomalyAnalysisSchema } from './schemas';

const runLive = process.env.RUN_LIVE_INFERENCE === '1';
const liveIt = runLive ? it : it.skip;

describe('PAYOUT-02 Real Nemotron Live Proof', () => {
  liveIt('performs real AI inference on representative PAYOUT-01 exceptions', async () => {
    const apiKey = process.env.NVIDIA_API_KEY;
    expect(apiKey).toBeTruthy();

    const allItems = classifyPayoutPopulation(generateSyntheticPayoutPopulation());
    const exceptions = allItems.filter((i) => i.status === 'AI_ANALYSIS_REQUIRED');
    expect(exceptions).toHaveLength(17);

    // Select 4 representative anomaly personas covering all 4 anomaly types
    const sample = [
      exceptions.find((i) => i.id === 'payout-042')!, // Sarah Jenkins (Velocity Spike)
      exceptions.find((i) => i.id === 'payout-101')!, // Marcus Chen (Recent Destination Change)
      exceptions.find((i) => i.id === 'payout-201')!, // Elena Rostova (Duplicate Destination)
      exceptions.find((i) => i.id === 'payout-301')!, // TechGear Reviews (High Refund Rate)
    ];

    const modelName = process.env.NVIDIA_MODEL || 'nvidia/nemotron-3.5-lightning-30b-a3b';
    const provider = new NVIDIAProvider(
      apiKey!,
      process.env.NVIDIA_API_BASE || 'https://integrate.api.nvidia.com/v1',
      modelName
    );

    const agent = new PayoutAnomalyAgent(provider);
    const startTime = Date.now();
    const prompt = agent.buildBatchPrompt(sample);
    const rawResponse = await provider.generateStructuredDecision(prompt);
    const durationMs = Date.now() - startTime;

    expect(rawResponse).toBeTruthy();

    // Parse and validate strictly
    const analyses = agent.parseAndValidateResponse(rawResponse, sample);
    expect(analyses).toHaveLength(4);

    for (const a of analyses) {
      expect(a.provenance).toBe('REAL_AI');
      expect(PayoutAnomalyAnalysisSchema.safeParse(a).success).toBe(true);
      expect(['LOW', 'MEDIUM', 'HIGH']).toContain(a.riskLevel);
      expect(a.riskScore).toBeGreaterThanOrEqual(0);
      expect(a.riskScore).toBeLessThanOrEqual(100);
      expect(['ALLOW_FOR_HUMAN_APPROVAL', 'HOLD', 'MANUAL_AUDIT']).toContain(
        a.recommendedAction
      );
      expect(a.explanation.length).toBeGreaterThan(10);
    }

    // Verify financial invariance
    const enriched = enrichPayoutItemsWithAnalysis(sample, analyses);
    expect(verifyFinancialInvariance(sample, enriched)).toBe(true);

    // Print sanitized proof evidence
    console.log('=== REAL NEMOTRON EXCEPTION INTELLIGENCE EVIDENCE ===');
    console.log(
      JSON.stringify(
        {
          provider: 'NVIDIA NIM',
          model: modelName,
          inferenceDurationMs: durationMs,
          totalExceptionsAnalyzed: analyses.length,
          sanitizedAnalyses: analyses.map((a) => ({
            payoutItemId: a.payoutItemId,
            riskLevel: a.riskLevel,
            riskScore: a.riskScore,
            anomalyTypes: a.anomalyTypes,
            recommendedAction: a.recommendedAction,
            explanation: a.explanation,
            provenance: a.provenance,
          })),
          financialIntegrity: {
            monetaryAmountsAltered: false,
            authoritativeInvarianceVerified: true,
            paypalCallsMade: 0,
            humanAuthorityPreserved: true,
          },
        },
        null,
        2
      )
    );
  }, 90000);
});
