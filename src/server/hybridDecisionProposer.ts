import type { CommerceDecision } from '../domain/schemas';
import {
  type DecisionProposer,
  SyntheticDecisionProposer,
  listSyntheticOpportunities,
} from './syntheticDecisionProposer';
import { CommerceAgent } from '../agents/commerceAgent';

/**
 * Hybrid decision proposer (ACTOVRA AI-02).
 *
 * Primary path: calls the real CommerceAgent backed by NVIDIAProvider
 * (nvidia/nemotron-3.5-lightning-30b-a3b) to generate a schema-validated
 * CommerceDecision with provenance 'REAL_AI'.
 *
 * Fallback path: gracefully falls back to SyntheticDecisionProposer with
 * provenance 'SYNTHETIC_FALLBACK' if the AI provider is unavailable,
 * unconfigured, or returns an error.
 */
export class HybridCommerceDecisionProposer implements DecisionProposer {
  readonly #agent: CommerceAgent | null;
  readonly #fallbackProposer: SyntheticDecisionProposer;

  constructor(
    agent?: CommerceAgent | null,
    fallbackProposer?: SyntheticDecisionProposer
  ) {
    this.#agent = agent ?? null;
    this.#fallbackProposer = fallbackProposer ?? new SyntheticDecisionProposer();
  }

  async proposeDecision(opportunityId: string): Promise<CommerceDecision> {
    if (this.#agent !== null) {
      try {
        const opp = listSyntheticOpportunities().find((o) => o.id === opportunityId);
        const businessContext = opp
          ? `Opportunity Title: ${opp.title}. Description: ${opp.description ?? 'Commercial promotion'}. Target customer account: customer-demo-001.`
          : 'Standard commercial promotion for customer-demo-001.';

        const result = await this.#agent.proposeDecision(opportunityId, businessContext);
        if (result.success) {
          return {
            ...result.decision,
            provenance: 'REAL_AI',
          };
        }
        console.warn(
          `[ACTOVRA AI] Real model inference failed (${result.error.name}: ${result.error.message}). Activating synthetic fallback.`
        );
      } catch (error) {
        console.warn(
          '[ACTOVRA AI] Unexpected error during real model inference. Activating synthetic fallback:',
          error instanceof Error ? error.message : error
        );
      }
    }

    const fallbackDecision = await this.#fallbackProposer.proposeDecision(opportunityId);
    return {
      ...fallbackDecision,
      provenance: 'SYNTHETIC_FALLBACK',
    };
  }
}
