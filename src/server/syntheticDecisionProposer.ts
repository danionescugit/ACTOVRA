/**
 * Deterministic synthetic decision proposer (Task 10, CP2-E).
 *
 * The application boundary needs an agent to propose commerce decisions, but
 * CP2 runs fully offline: no LLM provider (NVIDIA) is wired into the
 * composition yet. This proposer replaces the LLM with a fixed, deterministic
 * proposal per known opportunity — same input, same output, no network.
 *
 * Architectural role (AI proposes → policy decides): identical to the real
 * agent; only the mechanism differs. When CP6/CP7 wires the NVIDIA-backed
 * agent, it will satisfy this same DecisionProposer interface.
 *
 * No policy logic here: this module NEVER decides whether a proposal is
 * allowed — evaluation is exclusively the deterministic policy engine's job.
 */

import type { CommerceDecision, Opportunity } from '../domain/schemas';
import { syntheticOpportunities } from '../domain/data';

/**
 * The application-level decision-proposal boundary. Mirrors the semantic of
 * CommerceAgent.proposeDecision (AI proposes, never decides) without the
 * businessContext parameter — opportunities are synthetic in CP2.
 */
export interface DecisionProposer {
  /** Propose a validated CommerceDecision for the given opportunity. */
  proposeDecision(opportunityId: string): Promise<CommerceDecision>;
}

/** Error raised when the proposer cannot produce a decision. */
export class SyntheticDecisionProposerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyntheticDecisionProposerError';
  }
}

/**
 * Fixed synthetic decisions per known opportunity ID. Deterministic, offline,
 * policy-respectful by construction for the happy path (CREATE_PAYMENT,
 * USD 2500 = $25.00 ≤ $50 automatic maximum) and deliberately ESCALATable via
 * opp-002 for demonstrating the human-approval path.
 */
const SYNTHETIC_DECISIONS: ReadonlyMap<string, Omit<CommerceDecision, 'opportunityId'>> =
  new Map([
    [
      'opp-001',
      {
        action: 'CREATE_PAYMENT',
        amount: 2500,
        currency: 'USD',
        recipient: 'customer-demo-001',
        justification: 'Synthetic proposal: execute the summer promotion payment',
      },
    ],
    [
      'opp-002',
      {
        action: 'CREATE_PAYMENT',
        amount: 45000,
        currency: 'USD',
        recipient: 'customer-demo-001',
        justification: 'Synthetic proposal: bulk purchase rebate exceeding the automatic threshold',
      },
    ],
    [
      'opp-003',
      {
        action: 'CREATE_PAYMENT',
        amount: 2500,
        currency: 'USD',
        recipient: 'customer-demo-001',
        justification: 'Synthetic proposal: new customer welcome credit payment',
      },
    ],
  ]);

/**
 * Deterministic synthetic proposer for known opportunities. Throws
 * SyntheticDecisionProposerError for unknown opportunity IDs (the caller
 * surfaces it; nothing is invented).
 */
export class SyntheticDecisionProposer implements DecisionProposer {
  async proposeDecision(opportunityId: string): Promise<CommerceDecision> {
    if (typeof opportunityId !== 'string' || opportunityId.trim().length === 0) {
      throw new SyntheticDecisionProposerError(
        'opportunityId must be a non-empty string'
      );
    }
    const template = SYNTHETIC_DECISIONS.get(opportunityId);
    if (template === undefined) {
      throw new SyntheticDecisionProposerError(
        `No synthetic decision exists for opportunity ID '${opportunityId}' (known: opp-001, opp-002, opp-003)`
      );
    }
    return {
      opportunityId,
      ...template,
    };
  }
}

/** Synthetic opportunity catalog accessor (read-only passthrough). */
export function listSyntheticOpportunities(): readonly Opportunity[] {
  return syntheticOpportunities;
}
