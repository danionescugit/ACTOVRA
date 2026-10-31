import { z } from 'zod';

/**
 * Currency whitelist for payout items.
 */
export const PayoutCurrencySchema = z.enum(['USD', 'EUR', 'GBP']);
export type PayoutCurrency = z.infer<typeof PayoutCurrencySchema>;

/**
 * Deterministic status codes for individual payout items.
 */
export const PayoutItemStatusSchema = z.enum([
  'READY',
  'HELD_BELOW_THRESHOLD',
  'HELD_NON_POSITIVE',
  'AI_ANALYSIS_REQUIRED',
]);
export type PayoutItemStatus = z.infer<typeof PayoutItemStatusSchema>;

/**
 * Specific deterministic anomaly / hold reason codes.
 */
export const PayoutAnomalyCodeSchema = z.enum([
  'VELOCITY_SPIKE',
  'HIGH_REFUND_RATE',
  'RECENT_DESTINATION_CHANGE',
  'DUPLICATE_DESTINATION',
  'BELOW_MINIMUM_THRESHOLD',
  'NON_POSITIVE_BALANCE',
]);
export type PayoutAnomalyCode = z.infer<typeof PayoutAnomalyCodeSchema>;

/**
 * Strict schema for raw payout input records before engine processing.
 */
export const PayoutRawRecordSchema = z.object({
  id: z.string().min(1),
  recipientId: z.string().min(1),
  recipientName: z.string().min(1),
  recipientEmail: z.string().email(),
  currency: PayoutCurrencySchema.default('USD'),
  grossCommissionsCents: z.number().int().nonnegative(),
  refundDeductionsCents: z.number().int().nonnegative().default(0),
  chargebackDeductionsCents: z.number().int().nonnegative().default(0),
  priorAdjustmentCents: z.number().int().default(0),
  bonusCents: z.number().int().nonnegative().default(0),
  historicalAverageCents: z.number().int().nonnegative().default(0),
  destinationLastChangedDaysAgo: z.number().int().nonnegative().default(30),
});
export type PayoutRawRecord = z.infer<typeof PayoutRawRecordSchema>;

/**
 * Authoritative schema for an evaluated payout item.
 */
export const PayoutItemSchema = PayoutRawRecordSchema.extend({
  netPayableCents: z.number().int(),
  status: PayoutItemStatusSchema,
  anomalyCodes: z.array(PayoutAnomalyCodeSchema),
  holdReason: z.string().optional(),
});
export type PayoutItem = z.infer<typeof PayoutItemSchema>;

/**
 * Exception compression metric summary.
 */
export const ExceptionCompressionMetricSchema = z.object({
  totalRecipients: z.number().int().positive(),
  routineCount: z.number().int().nonnegative(), // READY + HELD
  manualReviewCount: z.number().int().nonnegative(), // AI_ANALYSIS_REQUIRED
  manualReviewRate: z.number().min(0).max(1),
  reviewReductionRate: z.number().min(0).max(1), // Exception Compression Rate (0.0 to 1.0)
  formattedCompressionPercentage: z.string(), // e.g. "98.3%"
});
export type ExceptionCompressionMetric = z.infer<typeof ExceptionCompressionMetricSchema>;

/**
 * Aggregate summary for an evaluated batch of payout items.
 */
export const PayoutBatchSummarySchema = z.object({
  totalRecipients: z.number().int().nonnegative(),
  readyCount: z.number().int().nonnegative(),
  heldCount: z.number().int().nonnegative(),
  analysisRequiredCount: z.number().int().nonnegative(),
  totalGrossCents: z.number().int().nonnegative(),
  totalNetPayableCents: z.number().int(),
  readyAmountCents: z.number().int().nonnegative(),
  heldAmountCents: z.number().int().nonnegative(),
  analysisRequiredAmountCents: z.number().int().nonnegative(),
  compression: ExceptionCompressionMetricSchema,
});
export type PayoutBatchSummary = z.infer<typeof PayoutBatchSummarySchema>;

/**
 * Itemized waterfall for "Explain My Payout".
 */
export const PayoutWaterfallRowSchema = z.object({
  label: z.string(),
  amountCents: z.number().int(),
  isDeduction: z.boolean().default(false),
});
export type PayoutWaterfallRow = z.infer<typeof PayoutWaterfallRowSchema>;

export const PayoutStatementSchema = z.object({
  itemId: z.string(),
  recipientId: z.string(),
  recipientName: z.string(),
  recipientEmail: z.string(),
  currency: PayoutCurrencySchema,
  status: PayoutItemStatusSchema,
  statusCategory: z.enum(['READY', 'HELD', 'EXCEPTION']),
  anomalyCodes: z.array(PayoutAnomalyCodeSchema),
  explanation: stringExplanationSchema(),
  netPayableCents: z.number().int(),
  waterfall: z.array(PayoutWaterfallRowSchema),
});
export type PayoutStatement = z.infer<typeof PayoutStatementSchema>;

function stringExplanationSchema() {
  return z.string().min(1);
}

/**
 * AI Anomaly Intelligence Schemas (PAYOUT-02)
 */
export const PayoutRiskLevelSchema = z.enum(['LOW', 'MEDIUM', 'HIGH']);
export type PayoutRiskLevel = z.infer<typeof PayoutRiskLevelSchema>;

export const PayoutRecommendedActionSchema = z.enum([
  'ALLOW_FOR_HUMAN_APPROVAL',
  'HOLD',
  'MANUAL_AUDIT',
]);
export type PayoutRecommendedAction = z.infer<typeof PayoutRecommendedActionSchema>;

export const PayoutAnalysisProvenanceSchema = z.enum(['REAL_AI', 'SYNTHETIC_FALLBACK']);
export type PayoutAnalysisProvenance = z.infer<typeof PayoutAnalysisProvenanceSchema>;

/**
 * Authoritative schema for an AI anomaly evaluation.
 * Note: Does NOT contain financial fields (amounts, approval, execution).
 */
export const PayoutAnomalyAnalysisSchema = z.object({
  payoutItemId: z.string().min(1),
  riskLevel: PayoutRiskLevelSchema,
  riskScore: z.number().int().min(0).max(100),
  anomalyTypes: z.array(PayoutAnomalyCodeSchema).nonempty(),
  explanation: z.string().min(10).max(500),
  recommendedAction: PayoutRecommendedActionSchema,
  provenance: PayoutAnalysisProvenanceSchema,
});
export type PayoutAnomalyAnalysis = z.infer<typeof PayoutAnomalyAnalysisSchema>;

export const PayoutBatchAnalysisSchema = z.array(PayoutAnomalyAnalysisSchema);
export type PayoutBatchAnalysis = z.infer<typeof PayoutBatchAnalysisSchema>;

/**
 * Payout item enriched with optional AI analysis.
 * Preserves PayoutItem amounts with 100% mathematical integrity.
 */
export const EnrichedPayoutItemSchema = PayoutItemSchema.extend({
  aiAnalysis: PayoutAnomalyAnalysisSchema.optional(),
});
export type EnrichedPayoutItem = z.infer<typeof EnrichedPayoutItemSchema>;

// Re-export mandate schemas
export * from './mandateSchemas';

