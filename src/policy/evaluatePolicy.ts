import type { CommerceDecision, PolicyResult } from '../domain/schemas';
import { PolicyConfigOutput } from './policyConfig';

/**
 * Evaluates a commerce decision against the deterministic policy configuration.
 * Returns a PolicyResult with decision and reason.
 * This function is pure: same inputs always produce same output.
 */
export function evaluatePolicy(
  decision: CommerceDecision,
  config: PolicyConfigOutput,
  knownOpportunities: { id: string }[] = config.knownOpportunities
): PolicyResult {
  // Helper to find opportunity by id
  const opportunityExists = knownOpportunities.some(opp => opp.id === decision.opportunityId);

  // Rule 1: Opportunity reference must exist
  if (!opportunityExists) {
    return {
      decision: 'REJECT',
      reason: `Opportunity with id '${decision.opportunityId}' not found`,
      reasonCode: 'OPPORTUNITY_NOT_FOUND',
    };
  }

  // Rule 2: Action must be allowed
  if (!config.allowedActions.includes(decision.action)) {
    return {
      decision: 'REJECT',
      reason: `Action '${decision.action}' is not allowed`,
      reasonCode: 'ACTION_NOT_ALLOWED',
    };
  }

  // Rule 3: Currency must be allowed
  if (!config.allowedCurrencies.includes(decision.currency)) {
    return {
      decision: 'REJECT',
      reason: `Currency '${decision.currency}' is not allowed`,
      reasonCode: 'CURRENCY_NOT_ALLOWED',
    };
  }

  // Rule 4: Recipient must be non-empty string
  if (!decision.recipient || decision.recipient.trim() === '') {
    return {
      decision: 'REJECT',
      reason: 'Recipient is required',
      reasonCode: 'RECIPIENT_NOT_ALLOWED',
    };
  }

  // If allowedRecipients list is provided, recipient must be in that list
  if (config.allowedRecipients && !config.allowedRecipients.includes(decision.recipient)) {
    return {
      decision: 'REJECT',
      reason: `Recipient '${decision.recipient}' is not allowed`,
      reasonCode: 'RECIPIENT_NOT_ALLOWED',
    };
  }

  // Rule 5: Justification must be non-empty string
  if (!decision.justification || decision.justification.trim() === '') {
    return {
      decision: 'REJECT',
      reason: 'Justification is required',
      reasonCode: 'JUSTIFICATION_MISSING',
    };
  }

  // Rule 6: Amount checks (in cents)
  const amount = decision.amount;

  // Hard rejection: amount exceeds human maximum
  if (amount > config.humanMaxAmountCents) {
    return {
      decision: 'REJECT',
      reason: `Amount ${amount} cents exceeds human approval maximum of ${config.humanMaxAmountCents} cents`,
      reasonCode: 'AMOUNT_EXCEEDS_HUMAN_MAX',
    };
  }

  // Escalation: amount exceeds automatic maximum but within human maximum
  if (amount > config.automaticMaxAmountCents) {
    return {
      decision: 'ESCALATE',
      reason: `Amount ${amount} cents exceeds automatic threshold of ${config.automaticMaxAmountCents} cents, requires human review`,
      reasonCode: 'AMOUNT_EXCEEDS_AUTOMATIC_MAX',
    };
  }

  // Otherwise, approve
  return {
    decision: 'APPROVE',
    reason: 'Decision satisfies all policy requirements',
    reasonCode: undefined, // APPROVE doesn't need a reasonCode, but we can omit it
  };
}