import { describe, it, expect } from 'vitest';
import { generateSyntheticPayoutPopulation } from './syntheticData';
import { classifyPayoutPopulation, aggregatePayoutBatch } from './calculationEngine';

describe('DATA-01: Financial Reconciliation Audit & Invariant Enforcement', () => {
  const rawRecords = generateSyntheticPayoutPopulation();
  const classifiedItems = classifyPayoutPopulation(rawRecords);
  const batchSummary = aggregatePayoutBatch(classifiedItems);

  // 1. The 1,000-recipient population
  it('enforces exact 1,000-recipient population integrity', () => {
    expect(rawRecords).toHaveLength(1000);
    expect(classifiedItems).toHaveLength(1000);
    expect(batchSummary.totalRecipients).toBe(1000);
  });

  // 2. Population segmentation: 917 Ready, 17 Review, 66 Held
  it('enforces exact segmentation counts: 917 Ready + 17 Review + 66 Held = 1,000 Total', () => {
    const readyItems = classifiedItems.filter((i) => i.status === 'READY');
    const reviewItems = classifiedItems.filter((i) => i.status === 'AI_ANALYSIS_REQUIRED');
    const heldItems = classifiedItems.filter(
      (i) => i.status === 'HELD_BELOW_THRESHOLD' || i.status === 'HELD_NON_POSITIVE'
    );

    expect(readyItems).toHaveLength(917);
    expect(reviewItems).toHaveLength(17);
    expect(heldItems).toHaveLength(66);

    expect(batchSummary.readyCount).toBe(917);
    expect(batchSummary.analysisRequiredCount).toBe(17);
    expect(batchSummary.heldCount).toBe(66);

    // Count invariant
    expect(readyItems.length + reviewItems.length + heldItems.length).toBe(1000);
    expect(batchSummary.readyCount + batchSummary.analysisRequiredCount + batchSummary.heldCount).toBe(
      batchSummary.totalRecipients
    );
  });

  // 3. Sub-segmentation of Held items: 64 below threshold + 2 non-positive
  it('enforces exact held sub-segmentation: 64 below threshold + 2 non-positive', () => {
    const heldBelowThreshold = classifiedItems.filter((i) => i.status === 'HELD_BELOW_THRESHOLD');
    const heldNonPositive = classifiedItems.filter((i) => i.status === 'HELD_NON_POSITIVE');

    expect(heldBelowThreshold).toHaveLength(64);
    expect(heldNonPositive).toHaveLength(2);
    expect(heldBelowThreshold.length + heldNonPositive.length).toBe(66);
  });

  // 4. payout-401 negative $25.00 scenario
  it('verifies payout-401 (Inactive Affiliate Delta) deterministic -$25.00 calculation', () => {
    const delta = classifiedItems.find((i) => i.id === 'payout-401');
    expect(delta).toBeDefined();
    if (!delta) throw new Error('payout-401 not found');

    expect(delta.recipientName).toBe('Inactive Affiliate Delta');
    expect(delta.grossCommissionsCents).toBe(1000); // $10.00
    expect(delta.refundDeductionsCents).toBe(1500); // -$15.00
    expect(delta.chargebackDeductionsCents).toBe(2000); // -$20.00
    expect(delta.priorAdjustmentCents).toBe(0);
    expect(delta.bonusCents).toBe(0);

    // Exact integer cent calculation: 1000 - 1500 - 2000 = -2500 cents (-$25.00)
    expect(delta.netPayableCents).toBe(-2500);
    expect(delta.status).toBe('HELD_NON_POSITIVE');
    expect(delta.anomalyCodes).toContain('NON_POSITIVE_BALANCE');
  });

  // 5. payout-402 zero-balance scenario
  it('verifies payout-402 (Dormant Partner Epsilon) exact $0.00 balance calculation', () => {
    const epsilon = classifiedItems.find((i) => i.id === 'payout-402');
    expect(epsilon).toBeDefined();
    if (!epsilon) throw new Error('payout-402 not found');

    expect(epsilon.recipientName).toBe('Dormant Partner Epsilon');
    expect(epsilon.grossCommissionsCents).toBe(0);
    expect(epsilon.refundDeductionsCents).toBe(0);
    expect(epsilon.chargebackDeductionsCents).toBe(0);
    expect(epsilon.netPayableCents).toBe(0);
    expect(epsilon.status).toBe('HELD_NON_POSITIVE');
  });

  // 6. Negative balance treatment: excluded from positive held disbursement totals
  it('enforces negative balance safety: excluded from executable/held cash totals', () => {
    const heldItems = classifiedItems.filter(
      (i) => i.status === 'HELD_BELOW_THRESHOLD' || i.status === 'HELD_NON_POSITIVE'
    );

    // Positive held cash (only items > 0)
    const positiveHeldCents = heldItems
      .filter((i) => i.netPayableCents > 0)
      .reduce((sum, i) => sum + i.netPayableCents, 0);

    // Raw ledger sum (including negative balances)
    const rawLedgerHeldCents = heldItems.reduce((sum, i) => sum + i.netPayableCents, 0);

    expect(positiveHeldCents).toBe(183420); // $1,834.20
    expect(rawLedgerHeldCents).toBe(180920); // $1,809.20 ($1,834.20 - $25.00)

    // The calculation engine heldAmountCents MUST equal positiveHeldCents
    // so negative balances never reduce positive money owed to other payees
    expect(batchSummary.heldAmountCents).toBe(positiveHeldCents);
    expect(batchSummary.heldAmountCents).toBe(183420);
    expect(batchSummary.heldAmountCents).not.toBe(rawLedgerHeldCents);
  });

  // 7. Overview headline total and card amounts
  it('verifies exact Overview displayed amounts derived from integer-cent records', () => {
    // Card 1: Ready Batch #1 ($140,594.47)
    expect(batchSummary.readyAmountCents).toBe(14059447);

    // Card 2: Needs Attention ($5,527.08)
    expect(batchSummary.analysisRequiredAmountCents).toBe(552708);

    // Card 3: Rule-Held Payouts ($1,834.20)
    expect(batchSummary.heldAmountCents).toBe(183420);

    // Headline: Total Net Settlement / Net Payable ($147,930.75)
    expect(batchSummary.totalNetPayableCents).toBe(14793075);
    expect(batchSummary.totalGrossCents).toBe(15168305); // $151,683.05
  });

  // 8. Aggregate reconciliation & mathematical explanation of the $25.00 difference
  it('mathematically reconciles positive cash ($147,955.75) vs net ledger ($147,930.75) by exact $25.00', () => {
    const readyCents = batchSummary.readyAmountCents;
    const reviewCents = batchSummary.analysisRequiredAmountCents;
    const heldPositiveCents = batchSummary.heldAmountCents;
    const netLedgerTotalCents = batchSummary.totalNetPayableCents;

    // Sum of the three category cards (Positive Payable Cash)
    const sumOfCategoryCardsCents = readyCents + reviewCents + heldPositiveCents;
    expect(sumOfCategoryCardsCents).toBe(14795575); // $147,955.75

    // Headline Total (Net Ledger Liability across all 1,000 accounts)
    expect(netLedgerTotalCents).toBe(14793075); // $147,930.75

    // Exact difference
    const differenceCents = sumOfCategoryCardsCents - netLedgerTotalCents;
    expect(differenceCents).toBe(2500); // Exactly $25.00!

    // Trace difference to payout-401
    const delta = classifiedItems.find((i) => i.id === 'payout-401')!;
    expect(Math.abs(delta.netPayableCents)).toBe(differenceCents);

    // Full algebraic reconciliation
    const allHeldNetCents = classifiedItems
      .filter((i) => i.status === 'HELD_BELOW_THRESHOLD' || i.status === 'HELD_NON_POSITIVE')
      .reduce((sum, i) => sum + i.netPayableCents, 0);

    expect(readyCents + reviewCents + allHeldNetCents).toBe(netLedgerTotalCents);
    expect(14059447 + 552708 + 180920).toBe(14793075);
  });

  // 9. No hardcoded aggregate drift
  it('proves zero hardcoded drift: all totals are dynamically derived from item-level data', () => {
    let manualGross = 0;
    let manualNet = 0;
    let manualReady = 0;
    let manualReview = 0;
    let manualHeldPositive = 0;

    for (const item of classifiedItems) {
      manualGross += item.grossCommissionsCents;
      manualNet += item.netPayableCents;
      if (item.status === 'READY') manualReady += item.netPayableCents;
      if (item.status === 'AI_ANALYSIS_REQUIRED') manualReview += item.netPayableCents;
      if (
        (item.status === 'HELD_BELOW_THRESHOLD' || item.status === 'HELD_NON_POSITIVE') &&
        item.netPayableCents > 0
      ) {
        manualHeldPositive += item.netPayableCents;
      }
    }

    expect(batchSummary.totalGrossCents).toBe(manualGross);
    expect(batchSummary.totalNetPayableCents).toBe(manualNet);
    expect(batchSummary.readyAmountCents).toBe(manualReady);
    expect(batchSummary.analysisRequiredAmountCents).toBe(manualReview);
    expect(batchSummary.heldAmountCents).toBe(manualHeldPositive);
  });
});
