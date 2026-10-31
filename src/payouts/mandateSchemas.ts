import { z } from 'zod';

export const MandateCurrencySchema = z.enum(['USD', 'EUR', 'GBP']);
export type MandateCurrency = z.infer<typeof MandateCurrencySchema>;

/**
 * Strict schema for Financial Mandate Configuration.
 * Turn the principle "AI needs a mandate, not a blank check" into enforceable code.
 */
export const FinancialMandateConfigSchema = z.object({
  // Minimum individual payout threshold in cents (contractual rule, default $50.00)
  minimumPayoutCents: z.number().int().positive().default(5000),

  // Maximum single payout before individual escalation is required in cents (default $2,500.00)
  maxStandardPayoutCents: z.number().int().positive().default(250000),

  // Maximum batch total payable in cents (default $200,000.00 = 20,000,000 cents, allows $147,930.75 hero batch)
  maxBatchTotalCents: z.number().int().positive().default(20000000),

  // Payout currencies allowed in the batch (default USD)
  allowedCurrencies: z.array(MandateCurrencySchema).nonempty().default(['USD']),

  // Security window in days: recent destination changes <= this require explicit human resolution
  recentDestinationChangeDays: z.number().int().nonnegative().default(3),

  // Human review strictly required for AI exception candidates
  requireHumanReviewForAIExceptions: z.literal(true).default(true),

  // Strict architectural boundary: AI execution is NEVER permitted
  allowAIExecution: z.literal(false).default(false),
});
export type FinancialMandateConfig = z.infer<typeof FinancialMandateConfigSchema>;

/**
 * Default production/demo Financial Mandate configuration.
 * Chosen carefully:
 * - maxBatchTotalCents = 20,000,000 ($200,000.00) allows the $147,930.75 hero batch to proceed.
 * - maxStandardPayoutCents = 250,000 ($2,500.00) protects against outlier single disbursements.
 * - allowAIExecution = false enforces absolute human-in-the-loop governance.
 */
export const defaultFinancialMandateConfig: FinancialMandateConfig = {
  minimumPayoutCents: 5000,
  maxStandardPayoutCents: 250000,
  maxBatchTotalCents: 20000000,
  allowedCurrencies: ['USD'],
  recentDestinationChangeDays: 3,
  requireHumanReviewForAIExceptions: true,
  allowAIExecution: false,
};

/**
 * Deterministic status codes for individual exception resolutions.
 */
export const ExceptionResolutionStatusSchema = z.enum([
  'UNRESOLVED',
  'APPROVED_FOR_BATCH',
  'HELD_BY_OPERATOR',
]);
export type ExceptionResolutionStatus = z.infer<typeof ExceptionResolutionStatusSchema>;

/**
 * Strict schema for human operator exception resolution.
 * AI or automated systems are explicitly forbidden from resolving exceptions.
 */
export const OperatorExceptionResolutionSchema = z.object({
  payoutItemId: z.string().min(1),
  resolutionStatus: z.enum(['APPROVED_FOR_BATCH', 'HELD_BY_OPERATOR']),
  resolvedBy: z.string().min(1).refine(val => {
    const lower = val.toLowerCase().trim();
    const forbidden = ['ai', 'nemotron', 'system', 'bot', 'llm', 'automated', 'nvidia'];
    return !forbidden.some(f =>
      lower === f ||
      lower.startsWith(`${f} `) ||
      lower.includes(`${f}_`) ||
      lower.includes(`${f}-`) ||
      lower.includes(`(${f})`)
    );
  }, {
    message: "Exception resolution must be performed by an authorized human operator, not AI or automated systems."
  }),
  resolvedAt: z.string().datetime(),
  resolutionNote: z.string().min(3, "A meaningful resolution rationale note is required for auditability"),
});
export type OperatorExceptionResolution = z.infer<typeof OperatorExceptionResolutionSchema>;

/**
 * Rule check codes for Financial Mandate Evaluation.
 */
export const MandateCheckCodeSchema = z.enum([
  'AI_EXECUTION_PROHIBITED',
  'BATCH_CEILING_EXCEEDED',
  'INDIVIDUAL_PAYOUT_CEILING_EXCEEDED',
  'UNSUPPORTED_CURRENCY',
  'HARD_HOLDS_PRESENT',
  'UNRESOLVED_AI_EXCEPTIONS',
  'RECENT_DESTINATION_CHANGE_UNRESOLVED',
  'DUPLICATE_DESTINATION_UNRESOLVED',
]);
export type MandateCheckCode = z.infer<typeof MandateCheckCodeSchema>;

export const MandateSeveritySchema = z.enum(['BLOCKING', 'WARNING']);
export type MandateSeverity = z.infer<typeof MandateSeveritySchema>;

export const MandateCheckResultSchema = z.object({
  code: MandateCheckCodeSchema,
  ruleName: z.string().min(1),
  severity: MandateSeveritySchema,
  passed: z.boolean(),
  message: z.string().min(1),
  relatedPayoutItemId: z.string().optional(),
});
export type MandateCheckResult = z.infer<typeof MandateCheckResultSchema>;

export const FinancialMandateStatusSchema = z.enum([
  'PASSED',
  'REVIEW_REQUIRED',
  'BLOCKED',
]);
export type FinancialMandateStatus = z.infer<typeof FinancialMandateStatusSchema>;

export const FinancialMandateSummarySchema = z.object({
  totalRecipients: z.number().int().nonnegative(),
  routineReadyCount: z.number().int().nonnegative(),
  hardHeldCount: z.number().int().nonnegative(),
  aiExceptionCount: z.number().int().nonnegative(),
  unresolvedExceptionCount: z.number().int().nonnegative(),
  approvedExceptionCount: z.number().int().nonnegative(),
  operatorHeldExceptionCount: z.number().int().nonnegative(),
  eligiblePayoutCount: z.number().int().nonnegative(),
  eligiblePayoutAmountCents: z.number().int().nonnegative(),
  excludedPayoutCount: z.number().int().nonnegative(),
  excludedPayoutAmountCents: z.number().int().nonnegative(),
});
export type FinancialMandateSummary = z.infer<typeof FinancialMandateSummarySchema>;

export const FinancialMandateEvaluationSchema = z.object({
  status: FinancialMandateStatusSchema,
  mandateConfig: FinancialMandateConfigSchema,
  batchChecks: z.array(MandateCheckResultSchema),
  itemChecks: z.array(MandateCheckResultSchema),
  blockingViolations: z.array(MandateCheckResultSchema),
  reviewRequirements: z.array(MandateCheckResultSchema),
  eligibleForHumanAuthorization: z.boolean(),
  summary: FinancialMandateSummarySchema,
});
export type FinancialMandateEvaluation = z.infer<typeof FinancialMandateEvaluationSchema>;

/**
 * Structured audit payload for financial mandate evaluations.
 */
export interface MandateEvaluatedEventPayload {
  eventType: 'MANDATE_EVALUATED';
  batchId?: string;
  evaluatedAt: string;
  status: FinancialMandateStatus;
  eligibleForHumanAuthorization: boolean;
  totalRecipients: number;
  eligiblePayoutCount: number;
  eligiblePayoutAmountCents: number;
  blockingViolationCodes: MandateCheckCode[];
  reviewRequirementCodes: MandateCheckCode[];
}
