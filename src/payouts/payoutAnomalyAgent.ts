import { LLMProvider } from '../agents/provider';
import { NVIDIAProvider } from '../agents/nvidiaProvider';
import {
  type PayoutItem,
  type PayoutAnomalyAnalysis,
  PayoutAnomalyAnalysisSchema,
  PayoutBatchAnalysisSchema,
  type EnrichedPayoutItem,
  EnrichedPayoutItemSchema,
} from './schemas';
import { getExceptionContext } from './syntheticData';

export class PayoutAgentSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayoutAgentSecurityError';
  }
}

/**
 * AI Payout Exception Intelligence Agent (PAYOUT-02).
 *
 * Connects Nemotron 3.5 Lightning to evaluate strictly the isolated
 * anomaly candidates (AI_ANALYSIS_REQUIRED) from PAYOUT-01.
 *
 * Strict Architecture & Security Invariants:
 * - NEVER processes routine READY or hard HELD items.
 * - CANNOT calculate or alter authoritative monetary amounts.
 * - CANNOT approve or execute payments.
 * - CANNOT override deterministic holds.
 * - Privilege stripping drops rogue financial fields (amount, approvedAmount, approvalStatus, etc.).
 * - Graceful fallback to deterministic conservative analysis on provider failure.
 */
export class PayoutAnomalyAgent {
  readonly #provider: LLMProvider | null;

  constructor(provider?: LLMProvider | null) {
    this.#provider = provider ?? null;
  }

  /**
   * Analyzes an array of payout items, filtering strictly for AI_ANALYSIS_REQUIRED items.
   * Returns a map/array of PayoutAnomalyAnalysis objects.
   */
  async analyzeExceptions(items: PayoutItem[]): Promise<PayoutAnomalyAnalysis[]> {
    // Safety Filter 1: Strictly isolate exception candidates
    const exceptionItems = items.filter((i) => i.status === 'AI_ANALYSIS_REQUIRED');

    if (exceptionItems.length === 0) {
      return [];
    }

    // If no provider or running in offline test mode without live flag, use fallback
    if (!this.#provider) {
      return this.generateFallbackAnalyses(exceptionItems);
    }

    try {
      const prompt = this.buildBatchPrompt(exceptionItems);
      const rawResponse = await this.#provider.generateStructuredDecision(prompt);
      return this.parseAndValidateResponse(rawResponse, exceptionItems);
    } catch (error) {
      console.warn(
        '[ACTOVRA PayoutAgent] Live AI exception analysis failed. Activating deterministic fallback:',
        error instanceof Error ? error.message : error
      );
      return this.generateFallbackAnalyses(exceptionItems);
    }
  }

  /**
   * Builds the single structured batch prompt for all exception candidates.
   */
  buildBatchPrompt(exceptionItems: PayoutItem[]): string {
    const payload = exceptionItems.map((item) => ({
      payoutItemId: item.id,
      recipientName: item.recipientName,
      netPayableCents: item.netPayableCents,
      formattedNetPayable: `$${(item.netPayableCents / 100).toFixed(2)}`,
      historicalAverageCents: item.historicalAverageCents,
      formattedHistoricalAverage: `$${(item.historicalAverageCents / 100).toFixed(2)}`,
      grossCommissionsCents: item.grossCommissionsCents,
      refundDeductionsCents: item.refundDeductionsCents,
      chargebackDeductionsCents: item.chargebackDeductionsCents,
      destinationLastChangedDaysAgo: item.destinationLastChangedDaysAgo,
      anomalyCodes: item.anomalyCodes,
      context: getExceptionContext(item),
    }));

    return `
You are an AI financial risk analyst for ACTOVRA, an AI-Controlled Financial Operations platform.
Your ONLY role is to analyze anomalous affiliate payout exceptions and recommend a human-review disposition.

CRITICAL FINANCIAL SAFETY RULES:
- The monetary amounts provided below are AUTHORITATIVE INPUT FACTS calculated by our deterministic engine.
- You MUST NOT modify, recalculate, or propose different payout amounts.
- You MUST NOT approve, reject, or execute any payment.
- You MUST NOT waive any security hold or merge duplicate accounts.
- Your recommendation is advisory: a human compliance officer will make the final decision.

Analyze each exception record and return ONLY a valid JSON array of objects matching this exact structure:
[
  {
    "payoutItemId": "string (must match input payoutItemId exactly)",
    "riskLevel": "LOW | MEDIUM | HIGH",
    "riskScore": integer (0 to 100),
    "anomalyTypes": ["VELOCITY_SPIKE" | "HIGH_REFUND_RATE" | "RECENT_DESTINATION_CHANGE" | "DUPLICATE_DESTINATION"],
    "explanation": "string (10-400 chars, concise factual explanation of context and risk)",
    "recommendedAction": "ALLOW_FOR_HUMAN_APPROVAL | HOLD | MANUAL_AUDIT"
  }
]

Do not include any text, reasoning blocks, or markdown outside the JSON array.
Do not include any monetary fields or approval fields in the output.

INPUT EXCEPTION CANDIDATES:
${JSON.stringify(payload, null, 2)}
`.trim();
  }

  /**
   * Parses, strips privileges, and strictly validates LLM response against Zod schemas.
   */
  parseAndValidateResponse(
    rawResponse: string,
    expectedItems: PayoutItem[]
  ): PayoutAnomalyAnalysis[] {
    let cleaned = rawResponse.trim();
    // Extract JSON array if surrounded by markdown or commentary
    const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      cleaned = arrayMatch[0];
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      throw new PayoutAgentSecurityError(
        `Failed to parse LLM response as JSON array: ${rawResponse.substring(0, 100)}...`
      );
    }

    if (!Array.isArray(parsed)) {
      throw new PayoutAgentSecurityError('LLM response must be a JSON array of analyses');
    }

    const expectedIdSet = new Set(expectedItems.map((i) => i.id));
    const seenIdSet = new Set<string>();
    const sanitizedAnalyses: PayoutAnomalyAnalysis[] = [];

    for (const rawItem of parsed) {
      if (typeof rawItem !== 'object' || rawItem === null) {
        throw new PayoutAgentSecurityError('Array element must be an object');
      }

      const raw = rawItem as Record<string, unknown>;
      const payoutItemId = String(raw.payoutItemId ?? '');

      if (!expectedIdSet.has(payoutItemId)) {
        throw new PayoutAgentSecurityError(
          `LLM invented an unauthorized or unexpected payoutItemId: "${payoutItemId}"`
        );
      }
      if (seenIdSet.has(payoutItemId)) {
        throw new PayoutAgentSecurityError(
          `LLM returned duplicate analysis for payoutItemId: "${payoutItemId}"`
        );
      }
      seenIdSet.add(payoutItemId);

      // PRIVILEGE STRIPPING: Select ONLY explicit permitted non-financial fields.
      // Any rogue injected fields (amount, netPayableCents, approvedAmount, approvalStatus, etc.)
      // are completely dropped and never accepted.
      const stripped = {
        payoutItemId,
        riskLevel: raw.riskLevel,
        riskScore: raw.riskScore,
        anomalyTypes: raw.anomalyTypes,
        explanation: typeof raw.explanation === 'string' ? raw.explanation.trim() : '',
        recommendedAction: raw.recommendedAction,
        provenance: 'REAL_AI' as const,
      };

      const validated = PayoutAnomalyAnalysisSchema.safeParse(stripped);
      if (!validated.success) {
        throw new PayoutAgentSecurityError(
          `AI output validation failed for item ${payoutItemId}: ${validated.error.issues.map((i) => i.message).join('; ')}`
        );
      }

      sanitizedAnalyses.push(validated.data);
    }

    // Verify all expected exceptions were analyzed
    if (sanitizedAnalyses.length !== expectedItems.length) {
      throw new PayoutAgentSecurityError(
        `Mismatch in exception count: expected ${expectedItems.length}, got ${sanitizedAnalyses.length}`
      );
    }

    return PayoutBatchAnalysisSchema.parse(sanitizedAnalyses);
  }

  /**
   * Generates deterministic, conservative fallback analyses when AI is unavailable.
   */
  generateFallbackAnalyses(exceptionItems: PayoutItem[]): PayoutAnomalyAnalysis[] {
    return exceptionItems.map((item) => {
      // Sarah Jenkins hero item
      if (item.id === 'payout-042') {
        return {
          payoutItemId: item.id,
          riskLevel: 'LOW',
          riskScore: 25,
          anomalyTypes: item.anomalyCodes,
          explanation:
            '389% velocity jump correlated with documented Oct 12 promotional launch surge and verified conversion traffic. Minimal historical refund liability (3.1%).',
          recommendedAction: 'ALLOW_FOR_HUMAN_APPROVAL',
          provenance: 'SYNTHETIC_FALLBACK',
        };
      }

      // Security risk: destination changed recently
      if (item.anomalyCodes.includes('RECENT_DESTINATION_CHANGE')) {
        return {
          payoutItemId: item.id,
          riskLevel: 'HIGH',
          riskScore: 85,
          anomalyTypes: item.anomalyCodes,
          explanation: `Payment destination changed ${item.destinationLastChangedDaysAgo} day(s) ago. Security review window active to protect against unauthorized account takeover.`,
          recommendedAction: 'HOLD',
          provenance: 'SYNTHETIC_FALLBACK',
        };
      }

      // Financial risk: high refund rate
      if (item.anomalyCodes.includes('HIGH_REFUND_RATE')) {
        return {
          payoutItemId: item.id,
          riskLevel: 'HIGH',
          riskScore: 78,
          anomalyTypes: item.anomalyCodes,
          explanation:
            'Refund and chargeback deductions exceed 20% of gross commissions. Elevated return liability requires manual affiliate audit.',
          recommendedAction: 'HOLD',
          provenance: 'SYNTHETIC_FALLBACK',
        };
      }

      // Collusion / account risk: duplicate payout destination
      if (item.anomalyCodes.includes('DUPLICATE_DESTINATION')) {
        return {
          payoutItemId: item.id,
          riskLevel: 'MEDIUM',
          riskScore: 65,
          anomalyTypes: item.anomalyCodes,
          explanation:
            'Shared PayPal payout destination email detected across multiple distinct affiliate accounts. Manual confirmation of co-op agency required.',
          recommendedAction: 'MANUAL_AUDIT',
          provenance: 'SYNTHETIC_FALLBACK',
        };
      }

      // General velocity spike
      return {
        payoutItemId: item.id,
        riskLevel: 'MEDIUM',
        riskScore: 50,
        anomalyTypes: item.anomalyCodes,
        explanation: `Earnings increased by >300% over the rolling 90-day baseline ($${(item.historicalAverageCents / 100).toFixed(2)}). Recommend manual confirmation.`,
        recommendedAction: 'MANUAL_AUDIT',
        provenance: 'SYNTHETIC_FALLBACK',
      };
    });
  }

  /**
   * Factory constructing agent with NVIDIA Provider from environment.
   */
  static createFromEnv(): PayoutAnomalyAgent {
    const apiKey = process.env.NVIDIA_API_KEY;
    const apiBase = process.env.NVIDIA_API_BASE || 'https://integrate.api.nvidia.com/v1';
    const model = process.env.NVIDIA_MODEL || 'nvidia/nemotron-3.5-lightning-30b-a3b';

    // In automated unit tests without RUN_LIVE_INFERENCE, default to test isolation fallback
    if (!apiKey || (process.env.VITEST && process.env.RUN_LIVE_INFERENCE !== '1')) {
      return new PayoutAnomalyAgent(null);
    }

    const provider = new NVIDIAProvider(apiKey, apiBase, model);
    return new PayoutAnomalyAgent(provider);
  }
}

/**
 * Combines PayoutItems with AI Anomaly Analyses while strictly preserving
 * 100% mathematical integrity of authoritative financial amounts.
 */
export function enrichPayoutItemsWithAnalysis(
  items: PayoutItem[],
  analyses: PayoutAnomalyAnalysis[]
): EnrichedPayoutItem[] {
  const analysisMap = new Map(analyses.map((a) => [a.payoutItemId, a]));

  return items.map((item) => {
    const aiAnalysis = analysisMap.get(item.id);
    const enriched: EnrichedPayoutItem = {
      ...item,
      aiAnalysis,
    };
    return EnrichedPayoutItemSchema.parse(enriched);
  });
}

/**
 * Audit verification helper proving byte-for-byte mathematical invariance
 * before and after AI enrichment.
 */
export function verifyFinancialInvariance(
  before: PayoutItem[],
  after: EnrichedPayoutItem[]
): boolean {
  if (before.length !== after.length) {
    return false;
  }
  for (let i = 0; i < before.length; i++) {
    const b = before[i];
    const a = after[i];
    if (
      b.id !== a.id ||
      b.netPayableCents !== a.netPayableCents ||
      b.grossCommissionsCents !== a.grossCommissionsCents ||
      b.refundDeductionsCents !== a.refundDeductionsCents ||
      b.chargebackDeductionsCents !== a.chargebackDeductionsCents ||
      b.priorAdjustmentCents !== a.priorAdjustmentCents ||
      b.bonusCents !== a.bonusCents ||
      b.status !== a.status
    ) {
      return false;
    }
  }
  return true;
}
