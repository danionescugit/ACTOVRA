import {
  PayoutBatchSummary,
  PayoutItem,
} from './schemas';
import { aggregatePayoutBatch } from './calculationEngine';
import {
  FinancialMandateConfig,
  FinancialMandateConfigSchema,
  defaultFinancialMandateConfig,
  OperatorExceptionResolution,
  OperatorExceptionResolutionSchema,
  MandateCheckResult,
  FinancialMandateEvaluation,
  FinancialMandateEvaluationSchema,
  FinancialMandateStatus,
  MandateEvaluatedEventPayload,
} from './mandateSchemas';

/**
 * Pure, deterministic Financial Mandate Engine.
 *
 * Implements the core product principle:
 * "AI needs a mandate, not a blank check."
 *
 * Evaluates batch-level and item-level financial governance rules to determine:
 * 1. Is the payout batch financially valid?
 * 2. Which payouts are automatically held by contractual rules?
 * 3. Which payouts require human review / exception resolution?
 * 4. Which payouts violate the financial mandate?
 * 5. Is the batch eligible to be presented for human authorization?
 * 6. Exactly why is it blocked if not?
 */
export function evaluateFinancialMandate(
  batchSummary: PayoutBatchSummary,
  items: PayoutItem[],
  resolutions: OperatorExceptionResolution[] = [],
  configInput: Partial<FinancialMandateConfig> = {}
): FinancialMandateEvaluation {
  // Validate mandate configuration
  const config = FinancialMandateConfigSchema.parse({
    ...defaultFinancialMandateConfig,
    ...configInput,
  });

  // Index operator resolutions by payout item ID
  const resolutionMap = new Map<string, OperatorExceptionResolution>();
  for (const res of resolutions) {
    const validatedRes = OperatorExceptionResolutionSchema.parse(res);
    resolutionMap.set(validatedRes.payoutItemId, validatedRes);
  }

  const batchChecks: MandateCheckResult[] = [];
  const itemChecks: MandateCheckResult[] = [];

  let routineReadyCount = 0;
  let routineReadyAmountCents = 0;

  let hardHeldCount = 0;
  let hardHeldAmountCents = 0;

  let aiExceptionCount = 0;
  let unresolvedExceptionCount = 0;
  let unresolvedExceptionAmountCents = 0;
  let approvedExceptionCount = 0;
  let approvedExceptionAmountCents = 0;
  let operatorHeldExceptionCount = 0;
  let operatorHeldAmountCents = 0;

  let hardHoldLeakDetected = false;

  // Evaluate items
  for (const item of items) {
    // Check currency compatibility for every item
    const currencyAllowed = config.allowedCurrencies.includes(item.currency);
    if (!currencyAllowed) {
      itemChecks.push({
        code: 'UNSUPPORTED_CURRENCY',
        ruleName: 'Supported Currency Verification',
        severity: 'BLOCKING',
        passed: false,
        message: `Item ${item.id} currency '${item.currency}' is not in allowed currencies: ${config.allowedCurrencies.join(', ')}`,
        relatedPayoutItemId: item.id,
      });
    }

    // Check single payout ceiling
    if (item.netPayableCents > config.maxStandardPayoutCents) {
      itemChecks.push({
        code: 'INDIVIDUAL_PAYOUT_CEILING_EXCEEDED',
        ruleName: 'Individual Payout Ceiling',
        severity: 'WARNING',
        passed: false,
        message: `Item ${item.id} net payable ($${(item.netPayableCents / 100).toFixed(2)}) exceeds standard single payout ceiling of $${(config.maxStandardPayoutCents / 100).toFixed(2)}`,
        relatedPayoutItemId: item.id,
      });
    }

    if (item.status === 'READY') {
      routineReadyCount++;
      routineReadyAmountCents += item.netPayableCents;
    } else if (item.status === 'HELD_BELOW_THRESHOLD' || item.status === 'HELD_NON_POSITIVE') {
      hardHeldCount++;
      if (item.netPayableCents > 0) {
        hardHeldAmountCents += item.netPayableCents;
      }

      // Rule: Hard holds can NEVER be overridden by operator resolution into the batch
      const rogueResolution = resolutionMap.get(item.id);
      if (rogueResolution && rogueResolution.resolutionStatus === 'APPROVED_FOR_BATCH') {
        hardHoldLeakDetected = true;
        itemChecks.push({
          code: 'HARD_HOLDS_PRESENT',
          ruleName: 'Hard Hold Invariance',
          severity: 'BLOCKING',
          passed: false,
          message: `Item ${item.id} has deterministic hard hold (${item.status}) and cannot be approved for batch execution`,
          relatedPayoutItemId: item.id,
        });
      }
    } else if (item.status === 'AI_ANALYSIS_REQUIRED') {
      aiExceptionCount++;
      const resolution = resolutionMap.get(item.id);

      if (!resolution) {
        // Item is UNRESOLVED
        unresolvedExceptionCount++;
        unresolvedExceptionAmountCents += item.netPayableCents;

        itemChecks.push({
          code: 'UNRESOLVED_AI_EXCEPTIONS',
          ruleName: 'AI Exception Resolution Required',
          severity: 'WARNING',
          passed: false,
          message: `Exception candidate ${item.id} (${item.recipientName}, $${(item.netPayableCents / 100).toFixed(2)}) requires human operator resolution before batch execution`,
          relatedPayoutItemId: item.id,
        });

        // Specific anomaly warnings if unresolved
        if (item.anomalyCodes.includes('RECENT_DESTINATION_CHANGE')) {
          itemChecks.push({
            code: 'RECENT_DESTINATION_CHANGE_UNRESOLVED',
            ruleName: 'Recent Destination Change Protection',
            severity: 'WARNING',
            passed: false,
            message: `Item ${item.id} has recent destination change (${item.destinationLastChangedDaysAgo} days ago <= ${config.recentDestinationChangeDays} day window) requiring explicit verification`,
            relatedPayoutItemId: item.id,
          });
        }

        if (item.anomalyCodes.includes('DUPLICATE_DESTINATION')) {
          itemChecks.push({
            code: 'DUPLICATE_DESTINATION_UNRESOLVED',
            ruleName: 'Duplicate Destination Audit',
            severity: 'WARNING',
            passed: false,
            message: `Item ${item.id} shares destination email (${item.recipientEmail}) requiring explicit verification`,
            relatedPayoutItemId: item.id,
          });
        }
      } else if (resolution.resolutionStatus === 'APPROVED_FOR_BATCH') {
        approvedExceptionCount++;
        approvedExceptionAmountCents += item.netPayableCents;
      } else if (resolution.resolutionStatus === 'HELD_BY_OPERATOR') {
        operatorHeldExceptionCount++;
        operatorHeldAmountCents += item.netPayableCents;
      }
    }
  }

  // Calculate executable candidate totals
  const eligiblePayoutCount = routineReadyCount + approvedExceptionCount;
  const eligiblePayoutAmountCents = routineReadyAmountCents + approvedExceptionAmountCents;

  const excludedPayoutCount = hardHeldCount + operatorHeldExceptionCount + unresolvedExceptionCount;
  const excludedPayoutAmountCents = hardHeldAmountCents + operatorHeldAmountCents + unresolvedExceptionAmountCents;

  // Batch-level Check 1: AI Execution Prohibited
  const aiExecutionProhibited = config.allowAIExecution === false;
  batchChecks.push({
    code: 'AI_EXECUTION_PROHIBITED',
    ruleName: 'AI Execution Prohibition Gate',
    severity: 'BLOCKING',
    passed: aiExecutionProhibited,
    message: aiExecutionProhibited
      ? 'Deterministic policy confirms AI autonomous execution is strictly prohibited; human authorization required'
      : 'Fatal violation: AI autonomous execution is not permitted by system architecture',
  });

  // Batch-level Check 2: Batch Total Ceiling
  const batchCeilingPassed = eligiblePayoutAmountCents <= config.maxBatchTotalCents;
  batchChecks.push({
    code: 'BATCH_CEILING_EXCEEDED',
    ruleName: 'Batch Total Ceiling',
    severity: 'BLOCKING',
    passed: batchCeilingPassed,
    message: batchCeilingPassed
      ? `Batch net eligible payable ($${(eligiblePayoutAmountCents / 100).toFixed(2)}) is within mandate ceiling of $${(config.maxBatchTotalCents / 100).toFixed(2)}`
      : `Batch net eligible payable ($${(eligiblePayoutAmountCents / 100).toFixed(2)}) exceeds mandate ceiling of $${(config.maxBatchTotalCents / 100).toFixed(2)} by $${((eligiblePayoutAmountCents - config.maxBatchTotalCents) / 100).toFixed(2)}`,
  });

  // Batch-level Check 3: Currency Whitelist
  const currencyCheckPassed = !itemChecks.some(c => c.code === 'UNSUPPORTED_CURRENCY' && !c.passed);
  batchChecks.push({
    code: 'UNSUPPORTED_CURRENCY',
    ruleName: 'Batch Currency Uniformity',
    severity: 'BLOCKING',
    passed: currencyCheckPassed,
    message: currencyCheckPassed
      ? `All ${items.length} items comply with allowed currencies (${config.allowedCurrencies.join(', ')})`
      : 'Batch contains payouts with unsupported currencies',
  });

  // Batch-level Check 4: Hard Holds Excluded
  const hardHoldsClean = !hardHoldLeakDetected;
  batchChecks.push({
    code: 'HARD_HOLDS_PRESENT',
    ruleName: 'Deterministic Hard Hold Enforcement',
    severity: 'BLOCKING',
    passed: hardHoldsClean,
    message: hardHoldsClean
      ? `All ${hardHeldCount} hard-held payouts are strictly quarantined from executable batch`
      : 'Violations detected: hard-held payouts were improperly targeted for batch inclusion',
  });

  // Batch-level Check 5: Unresolved AI Exceptions
  const allExceptionsResolved = unresolvedExceptionCount === 0;
  batchChecks.push({
    code: 'UNRESOLVED_AI_EXCEPTIONS',
    ruleName: 'AI Exception Governance',
    severity: 'WARNING',
    passed: allExceptionsResolved,
    message: allExceptionsResolved
      ? `All ${aiExceptionCount} AI exception candidates have been explicitly resolved by human operator (${approvedExceptionCount} approved, ${operatorHeldExceptionCount} held)`
      : `${unresolvedExceptionCount} of ${aiExceptionCount} AI exception candidates require explicit human operator resolution before batch can be authorized`,
  });

  // Separate all failed checks
  const allChecks = [...batchChecks, ...itemChecks];
  const blockingViolations = allChecks.filter(c => c.severity === 'BLOCKING' && !c.passed);
  const reviewRequirements = allChecks.filter(c => c.severity === 'WARNING' && !c.passed);

  // Determine overall status
  let status: FinancialMandateStatus;
  if (blockingViolations.length > 0) {
    status = 'BLOCKED';
  } else if (reviewRequirements.length > 0) {
    status = 'REVIEW_REQUIRED';
  } else {
    status = 'PASSED';
  }

  // Batch is eligible for human authorization if and only if:
  // 1. Status is PASSED
  // 2. Zero blocking violations
  // 3. Zero unresolved review requirements
  const eligibleForHumanAuthorization = status === 'PASSED' &&
    blockingViolations.length === 0 &&
    reviewRequirements.length === 0;

  const evaluationResult: FinancialMandateEvaluation = {
    status,
    mandateConfig: config,
    batchChecks,
    itemChecks,
    blockingViolations,
    reviewRequirements,
    eligibleForHumanAuthorization,
    summary: {
      totalRecipients: items.length,
      routineReadyCount,
      hardHeldCount,
      aiExceptionCount,
      unresolvedExceptionCount,
      approvedExceptionCount,
      operatorHeldExceptionCount,
      eligiblePayoutCount,
      eligiblePayoutAmountCents,
      excludedPayoutCount,
      excludedPayoutAmountCents,
    },
  };

  return FinancialMandateEvaluationSchema.parse(evaluationResult);
}

/**
 * Checks whether an evaluation allows presenting the batch for human authorization.
 */
export function isBatchEligibleForHumanAuthorization(
  evaluation: FinancialMandateEvaluation
): boolean {
  return evaluation.eligibleForHumanAuthorization;
}

/**
 * Evaluates the clean routine READY payouts as an independent batch (Ready Batch #1).
 *
 * CRITICAL PRODUCT CHANGE (UX-05):
 * Routine payouts are not blocked by the 17 exceptions. They can be reviewed
 * and authorized independently as Ready Batch #1.
 */
export function evaluateReadyPayoutBatch(
  readyItems: PayoutItem[],
  configInput: Partial<FinancialMandateConfig> = {}
): FinancialMandateEvaluation {
  const onlyReady = readyItems.filter((i) => i.status === 'READY');
  const summary = aggregatePayoutBatch(onlyReady);
  return evaluateFinancialMandate(summary, onlyReady, [], configInput);
}

/**
 * Evaluates approved exception payouts as an independent secondary batch (Batch #2).
 */
export function evaluateReviewedExceptionBatch(
  approvedItems: PayoutItem[],
  resolutions: OperatorExceptionResolution[],
  configInput: Partial<FinancialMandateConfig> = {}
): FinancialMandateEvaluation {
  const summary = aggregatePayoutBatch(approvedItems);
  return evaluateFinancialMandate(summary, approvedItems, resolutions, configInput);
}

/**
 * Pure calculation of candidate executable totals from items and resolutions.
 */
export function calculateExecutableBatchTotals(
  items: PayoutItem[],
  resolutions: OperatorExceptionResolution[] = []
): {
  count: number;
  amountCents: number;
  approvedExceptionCount: number;
  operatorHeldExceptionCount: number;
  unresolvedCount: number;
} {
  const resolutionMap = new Map<string, OperatorExceptionResolution>();
  for (const res of resolutions) {
    resolutionMap.set(res.payoutItemId, res);
  }

  let count = 0;
  let amountCents = 0;
  let approvedExceptionCount = 0;
  let operatorHeldExceptionCount = 0;
  let unresolvedCount = 0;

  for (const item of items) {
    if (item.status === 'READY') {
      count++;
      amountCents += item.netPayableCents;
    } else if (item.status === 'AI_ANALYSIS_REQUIRED') {
      const res = resolutionMap.get(item.id);
      if (res && res.resolutionStatus === 'APPROVED_FOR_BATCH') {
        count++;
        amountCents += item.netPayableCents;
        approvedExceptionCount++;
      } else if (res && res.resolutionStatus === 'HELD_BY_OPERATOR') {
        operatorHeldExceptionCount++;
      } else {
        unresolvedCount++;
      }
    }
  }

  return {
    count,
    amountCents,
    approvedExceptionCount,
    operatorHeldExceptionCount,
    unresolvedCount,
  };
}

/**
 * Creates structured audit payload for recording MANDATE_EVALUATED events.
 */
export function createMandateAuditPayload(
  evaluation: FinancialMandateEvaluation,
  batchId?: string
): MandateEvaluatedEventPayload {
  return {
    eventType: 'MANDATE_EVALUATED',
    batchId,
    evaluatedAt: new Date().toISOString(),
    status: evaluation.status,
    eligibleForHumanAuthorization: evaluation.eligibleForHumanAuthorization,
    totalRecipients: evaluation.summary.totalRecipients,
    eligiblePayoutCount: evaluation.summary.eligiblePayoutCount,
    eligiblePayoutAmountCents: evaluation.summary.eligiblePayoutAmountCents,
    blockingViolationCodes: Array.from(new Set(evaluation.blockingViolations.map(v => v.code))),
    reviewRequirementCodes: Array.from(new Set(evaluation.reviewRequirements.map(r => r.code))),
  };
}
