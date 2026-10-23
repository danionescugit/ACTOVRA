import { z } from 'zod';

/**
 * Policy configuration for the deterministic commerce policy engine.
 * All amounts are in cents (integer minor units).
 */
export const PolicyConfigSchema = z.object({
  // Maximum amount (in cents) that can be auto-approved without human review
  automaticMaxAmountCents: z.number().int().positive(),
  // Maximum amount (in cents) that can be approved with human review
  humanMaxAmountCents: z.number().int().positive(),
  // Allowed action types
  allowedActions: z.array(
    z.enum(['CREATE_PAYMENT', 'REFUND', 'UPDATE_SUBSCRIPTION', 'CREATE_INVOICE'])
  ).nonempty(),
  // Allowed currencies
  allowedCurrencies: z.array(
    z.enum(['USD', 'EUR', 'GBP', 'JPY', 'CAD'])
  ).nonempty(),
  // Allowed recipients (optional: if provided, recipient must be in this list; if not provided, any non-empty string is allowed)
  allowedRecipients: z.array(z.string()).optional(),
  // Known opportunities for validation
  knownOpportunities: z.array(
    z.object({
      id: z.string(),
      // We don't need other fields for validation, but we can include them for context
    })
  ).nonempty(),
})
// Ensure humanMax > automaticMax
.refine((data) => data.humanMaxAmountCents > data.automaticMaxAmountCents, {
  message: "humanMaxAmountCents must be greater than automaticMaxAmountCents",
  path: ["humanMaxAmountCents"],
});

export type PolicyConfig = z.input<typeof PolicyConfigSchema>;
export type PolicyConfigOutput = z.output<typeof PolicyConfigSchema>;

/**
 * Synthetic/demo policy configuration for V0.
 * In a real system, this might come from a database or config service.
 * For demo purposes, we restrict allowed currencies to USD and EUR to test currency rejection.
 */
export const syntheticPolicyConfig: PolicyConfigOutput = {
  automaticMaxAmountCents: 5000, // $50.00
  humanMaxAmountCents: 50000,    // $500.00
  allowedActions: ['CREATE_PAYMENT', 'REFUND'],
  allowedCurrencies: ['USD', 'EUR'], // Only USD and EUR allowed for demo
  // For demo, we allow any recipient (non-empty string). We'll leave allowedRecipients undefined.
  allowedRecipients: undefined,
  knownOpportunities: [
    { id: 'opp-001' },
    { id: 'opp-002' },
    { id: 'opp-003' },
  ],
};

// Validate the synthetic config at runtime (optional, but good for demo)
export const validatedSyntheticPolicyConfig = PolicyConfigSchema.parse(syntheticPolicyConfig);