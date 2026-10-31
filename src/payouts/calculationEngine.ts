import {
  type PayoutRawRecord,
  type PayoutItem,
  type PayoutItemStatus,
  type PayoutAnomalyCode,
  type PayoutBatchSummary,
  type ExceptionCompressionMetric,
  type PayoutStatement,
  PayoutItemSchema,
  PayoutBatchSummarySchema,
  PayoutStatementSchema,
} from './schemas';

/**
 * Standard contractual minimum payout threshold: $50.00 (5,000 cents).
 */
export const MINIMUM_PAYOUT_THRESHOLD_CENTS = 5000;

/**
 * Security window for recent payment destination changes (3 days).
 */
export const DESTINATION_CHANGE_SECURITY_WINDOW_DAYS = 3;

/**
 * Velocity multiplier threshold for historical baseline comparison (3x).
 */
export const VELOCITY_SPIKE_MULTIPLIER = 3;

/**
 * High refund/chargeback threshold as percentage of gross earnings (20%).
 */
export const HIGH_REFUND_RATE_PERCENTAGE_THRESHOLD = 20;

export class PayoutCalculationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayoutCalculationError';
  }
}

/**
 * Pure integer arithmetic for net payable calculation.
 *
 * Formula:
 *   Net Payable = Gross Commissions
 *               - Refund Deductions
 *               - Chargeback Deductions
 *               + Prior Adjustment (signed)
 *               + Bonus
 *
 * Guarantees:
 * - Integer-only arithmetic (fractional cents rejected loudly).
 * - Safe integer boundaries strictly enforced.
 * - Negative inputs rejected where illegal (gross, deductions, bonus must be >= 0).
 */
export function calculateNetPayable(input: {
  grossCommissionsCents: number;
  refundDeductionsCents: number;
  chargebackDeductionsCents: number;
  priorAdjustmentCents: number;
  bonusCents: number;
}): number {
  const fields = [
    { name: 'grossCommissionsCents', val: input.grossCommissionsCents, nonNegative: true },
    { name: 'refundDeductionsCents', val: input.refundDeductionsCents, nonNegative: true },
    { name: 'chargebackDeductionsCents', val: input.chargebackDeductionsCents, nonNegative: true },
    { name: 'priorAdjustmentCents', val: input.priorAdjustmentCents, nonNegative: false },
    { name: 'bonusCents', val: input.bonusCents, nonNegative: true },
  ];

  for (const { name, val, nonNegative } of fields) {
    if (!Number.isSafeInteger(val)) {
      throw new PayoutCalculationError(
        `Field "${name}" must be a safe integer in cents. Received: ${val}`
      );
    }
    if (nonNegative && val < 0) {
      throw new PayoutCalculationError(
        `Field "${name}" cannot be negative. Received: ${val}`
      );
    }
  }

  const net =
    input.grossCommissionsCents -
    input.refundDeductionsCents -
    input.chargebackDeductionsCents +
    input.priorAdjustmentCents +
    input.bonusCents;

  if (!Number.isSafeInteger(net)) {
    throw new PayoutCalculationError('Calculated net payable exceeds safe integer range');
  }

  return net;
}

/**
 * Evaluates an individual payout record against deterministic business rules.
 */
export function classifyPayoutItem(
  record: PayoutRawRecord,
  duplicateEmailsSet: ReadonlySet<string> = new Set()
): PayoutItem {
  const netPayableCents = calculateNetPayable({
    grossCommissionsCents: record.grossCommissionsCents,
    refundDeductionsCents: record.refundDeductionsCents,
    chargebackDeductionsCents: record.chargebackDeductionsCents,
    priorAdjustmentCents: record.priorAdjustmentCents,
    bonusCents: record.bonusCents,
  });

  const anomalyCodes: PayoutAnomalyCode[] = [];
  let status: PayoutItemStatus;
  let holdReason: string | undefined;

  // Rule 1 (Hard Deterministic Hold): Non-positive payable balance
  if (netPayableCents <= 0) {
    status = 'HELD_NON_POSITIVE';
    anomalyCodes.push('NON_POSITIVE_BALANCE');
    holdReason = `Net payable balance is non-positive ($${(netPayableCents / 100).toFixed(2)}). Balance cannot be disbursed.`;
  }
  // Rule 2 (Hard Deterministic Hold): Below contractual minimum threshold
  else if (netPayableCents < MINIMUM_PAYOUT_THRESHOLD_CENTS) {
    status = 'HELD_BELOW_THRESHOLD';
    anomalyCodes.push('BELOW_MINIMUM_THRESHOLD');
    const payableFormatted = (netPayableCents / 100).toFixed(2);
    const minFormatted = (MINIMUM_PAYOUT_THRESHOLD_CENTS / 100).toFixed(2);
    holdReason = `Net payable $${payableFormatted} is below the contractual minimum threshold of $${minFormatted}. Balance carries forward to next period.`;
  }
  // Rule 3 (Eligible for Payout): Evaluate anomaly criteria
  else {
    // 3a. Velocity anomaly: net payable exceeds 3x historical 90-day baseline
    if (
      record.historicalAverageCents > 0 &&
      netPayableCents > record.historicalAverageCents * VELOCITY_SPIKE_MULTIPLIER
    ) {
      anomalyCodes.push('VELOCITY_SPIKE');
    }

    // 3b. High refund / chargeback ratio: deductions exceed 20% of gross commissions
    if (record.grossCommissionsCents > 0) {
      const totalDeductions = record.refundDeductionsCents + record.chargebackDeductionsCents;
      if (
        totalDeductions * 100 >
        record.grossCommissionsCents * HIGH_REFUND_RATE_PERCENTAGE_THRESHOLD
      ) {
        anomalyCodes.push('HIGH_REFUND_RATE');
      }
    }

    // 3c. Recent destination change within security window (3 days)
    if (record.destinationLastChangedDaysAgo <= DESTINATION_CHANGE_SECURITY_WINDOW_DAYS) {
      anomalyCodes.push('RECENT_DESTINATION_CHANGE');
    }

    // 3d. Duplicate destination: email shared across distinct recipient accounts
    if (duplicateEmailsSet.has(record.recipientEmail.toLowerCase())) {
      anomalyCodes.push('DUPLICATE_DESTINATION');
    }

    // Determine final status
    if (anomalyCodes.length > 0) {
      status = 'AI_ANALYSIS_REQUIRED';
      holdReason = `Flagged for AI analysis and human review: ${anomalyCodes.join(', ')}.`;
    } else {
      status = 'READY';
      holdReason = undefined;
    }
  }

  const item: PayoutItem = {
    ...record,
    netPayableCents,
    status,
    anomalyCodes,
    holdReason,
  };

  return PayoutItemSchema.parse(item);
}

/**
 * Classifies an entire population of raw payout records, identifying
 * duplicates across the entire set deterministically.
 */
export function classifyPayoutPopulation(records: PayoutRawRecord[]): PayoutItem[] {
  // Pass 1: Identify email duplicates across distinct recipientIds
  const emailToRecipientIds = new Map<string, Set<string>>();
  for (const record of records) {
    const emailNorm = record.recipientEmail.toLowerCase().trim();
    let recipients = emailToRecipientIds.get(emailNorm);
    if (!recipients) {
      recipients = new Set();
      emailToRecipientIds.set(emailNorm, recipients);
    }
    recipients.add(record.recipientId);
  }

  const duplicateEmailsSet = new Set<string>();
  for (const [email, recipients] of emailToRecipientIds.entries()) {
    if (recipients.size > 1) {
      duplicateEmailsSet.add(email);
    }
  }

  // Pass 2: Classify each record
  return records.map((record) => classifyPayoutItem(record, duplicateEmailsSet));
}

/**
 * Calculates the mathematically unambiguous Exception Compression Metric.
 *
 * Formula:
 *   manualReviewRate = manualReviewCount / totalRecipients
 *   reviewReductionRate = (totalRecipients - manualReviewCount) / totalRecipients
 */
export function calculateCompressionMetrics(
  totalRecipients: number,
  manualReviewCount: number
): ExceptionCompressionMetric {
  if (totalRecipients <= 0) {
    throw new PayoutCalculationError('totalRecipients must be greater than zero');
  }
  if (manualReviewCount < 0 || manualReviewCount > totalRecipients) {
    throw new PayoutCalculationError('manualReviewCount must be between 0 and totalRecipients');
  }

  const routineCount = totalRecipients - manualReviewCount;
  const manualReviewRate = manualReviewCount / totalRecipients;
  const reviewReductionRate = routineCount / totalRecipients;
  const formattedCompressionPercentage = `${(reviewReductionRate * 100).toFixed(1)}%`;

  return {
    totalRecipients,
    routineCount,
    manualReviewCount,
    manualReviewRate,
    reviewReductionRate,
    formattedCompressionPercentage,
  };
}

/**
 * Pure aggregation function calculating batch summary and verifying invariants.
 */
export function aggregatePayoutBatch(items: PayoutItem[]): PayoutBatchSummary {
  let readyCount = 0;
  let heldCount = 0;
  let analysisRequiredCount = 0;

  let totalGrossCents = 0;
  let totalNetPayableCents = 0;
  let readyAmountCents = 0;
  let heldAmountCents = 0;
  let analysisRequiredAmountCents = 0;

  for (const item of items) {
    totalGrossCents += item.grossCommissionsCents;
    totalNetPayableCents += item.netPayableCents;

    switch (item.status) {
      case 'READY':
        readyCount += 1;
        readyAmountCents += item.netPayableCents;
        break;
      case 'HELD_BELOW_THRESHOLD':
      case 'HELD_NON_POSITIVE':
        heldCount += 1;
        // Non-positive balances don't contribute positive payable cash
        if (item.netPayableCents > 0) {
          heldAmountCents += item.netPayableCents;
        }
        break;
      case 'AI_ANALYSIS_REQUIRED':
        analysisRequiredCount += 1;
        analysisRequiredAmountCents += item.netPayableCents;
        break;
    }
  }

  const totalRecipients = items.length;

  // Invariant verification
  if (readyCount + heldCount + analysisRequiredCount !== totalRecipients) {
    throw new PayoutCalculationError(
      `Population segmentation count mismatch: ${readyCount} + ${heldCount} + ${analysisRequiredCount} !== ${totalRecipients}`
    );
  }

  const compression = calculateCompressionMetrics(
    totalRecipients > 0 ? totalRecipients : 1,
    analysisRequiredCount
  );

  const summary: PayoutBatchSummary = {
    totalRecipients,
    readyCount,
    heldCount,
    analysisRequiredCount,
    totalGrossCents,
    totalNetPayableCents,
    readyAmountCents,
    heldAmountCents,
    analysisRequiredAmountCents,
    compression,
  };

  return PayoutBatchSummarySchema.parse(summary);
}

/**
 * Builds itemized financial waterfall and explanation for "Explain My Payout".
 */
export function generatePayoutStatement(item: PayoutItem): PayoutStatement {
  const waterfall = [
    { label: 'Gross Commissions', amountCents: item.grossCommissionsCents, isDeduction: false },
  ];

  if (item.refundDeductionsCents > 0) {
    waterfall.push({
      label: 'Refund Deductions',
      amountCents: item.refundDeductionsCents,
      isDeduction: true,
    });
  }

  if (item.chargebackDeductionsCents > 0) {
    waterfall.push({
      label: 'Chargeback Deductions',
      amountCents: item.chargebackDeductionsCents,
      isDeduction: true,
    });
  }

  if (item.priorAdjustmentCents !== 0) {
    waterfall.push({
      label: 'Prior Balance Adjustment',
      amountCents: Math.abs(item.priorAdjustmentCents),
      isDeduction: item.priorAdjustmentCents < 0,
    });
  }

  if (item.bonusCents > 0) {
    waterfall.push({
      label: 'Performance Bonus',
      amountCents: item.bonusCents,
      isDeduction: false,
    });
  }

  let statusCategory: 'READY' | 'HELD' | 'EXCEPTION';
  let explanation: string;

  if (item.status === 'READY') {
    statusCategory = 'READY';
    explanation = 'Verified clean: satisfies all contractual and deterministic policy thresholds.';
  } else if (item.status === 'HELD_BELOW_THRESHOLD' || item.status === 'HELD_NON_POSITIVE') {
    statusCategory = 'HELD';
    explanation = item.holdReason ?? 'Payout held per contractual guidelines.';
  } else {
    statusCategory = 'EXCEPTION';
    explanation = item.holdReason ?? 'Flagged for anomaly evaluation and human review.';
  }

  const statement: PayoutStatement = {
    itemId: item.id,
    recipientId: item.recipientId,
    recipientName: item.recipientName,
    recipientEmail: item.recipientEmail,
    currency: item.currency,
    status: item.status,
    statusCategory,
    anomalyCodes: item.anomalyCodes,
    explanation,
    netPayableCents: item.netPayableCents,
    waterfall,
  };

  return PayoutStatementSchema.parse(statement);
}
