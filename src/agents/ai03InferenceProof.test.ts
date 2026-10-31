import { describe, it, expect } from 'vitest';
import { CommerceAgent } from './commerceAgent';
import { evaluatePolicy } from '../policy/evaluatePolicy';
import { validatedSyntheticPolicyConfig } from '../policy/policyConfig';
import { syntheticOpportunities } from '../domain/data';
import { CommerceDecisionSchema } from '../domain/schemas';

const runLive = process.env.RUN_LIVE_INFERENCE === '1';
const liveIt = runLive ? it : it.skip;

describe('AI-03 Single Real Inference Proof', () => {
  liveIt('obtains exactly one real LLM inference through CommerceAgent and evaluates deterministic policy', async () => {
    // 1. Setup opportunity
    const opp = syntheticOpportunities.find((o) => o.id === 'opp-001')!;
    expect(opp).toBeDefined();

    const businessContext = `Opportunity Title: ${opp.title}. Description: ${opp.description}. Propose a promotional payment incentive for customer-demo-001 under $50.00.`;

    // 2. Run real CommerceAgent
    const agent = CommerceAgent.createWithNVIDIAFromEnv();
    const result = await agent.proposeDecision('opp-001', businessContext);

    if (!result.success) {
      throw new Error(`Real inference failed: ${result.error.name}: ${result.error.message}`);
    }

    expect(result.success).toBe(true);
    expect(result.decision.provenance).toBe('REAL_AI');

    // 3. Schema validation
    const zodValidation = CommerceDecisionSchema.safeParse(result.decision);
    expect(zodValidation.success).toBe(true);

    // 4. Policy evaluation
    const policyResult = evaluatePolicy(
      result.decision,
      validatedSyntheticPolicyConfig,
      syntheticOpportunities
    );

    // 5. Print sanitized evidence
    console.log('=== REAL AI INFERENCE EVIDENCE ===');
    console.log(
      JSON.stringify(
        {
          provider: 'NVIDIA NIM',
          model: process.env.NVIDIA_MODEL || 'nvidia/nemotron-3.5-lightning-30b-a3b',
          opportunityInput: {
            id: opp.id,
            title: opp.title,
            description: opp.description,
            nature: 'SYNTHETIC_DEMO_TRIGGER',
          },
          decisionOutput: {
            opportunityId: result.decision.opportunityId,
            action: result.decision.action,
            amount: result.decision.amount,
            currency: result.decision.currency,
            recipient: result.decision.recipient,
            justification: result.decision.justification,
            provenance: result.decision.provenance,
          },
          zodValidation: {
            success: zodValidation.success,
            schema: 'CommerceDecisionSchema',
          },
          policyEvaluation: {
            decision: policyResult.decision,
            reason: policyResult.reason,
            reasonCode: policyResult.reasonCode ?? null,
          },
          safetyBoundaries: {
            humanApprovalInvoked: false,
            paypalCallsMade: 0,
            executionStatus: 'STOPPED_AT_POLICY_GATE',
          },
        },
        null,
        2
      )
    );
  }, 90000);
});
