import { describe, it, expect } from 'vitest';
import {
  calculateNetPayable,
  classifyPayoutItem,
  classifyPayoutPopulation,
  aggregatePayoutBatch,
  calculateCompressionMetrics,
  generatePayoutStatement,
  PayoutCalculationError,
} from './calculationEngine';
import { PayoutRawRecord } from './schemas';

describe('Payout Calculation Engine', () => {
  describe('calculateNetPayable (Authoritative Arithmetic)', () => {
    it('calculates standard payout with gross commissions only', () => {
      const net = calculateNetPayable({
        grossCommissionsCents: 10000,
        refundDeductionsCents: 0,
        chargebackDeductionsCents: 0,
        priorAdjustmentCents: 0,
        bonusCents: 0,
      });
      expect(net).toBe(10000);
    });

    it('deducts refunds correctly', () => {
      const net = calculateNetPayable({
        grossCommissionsCents: 15000,
        refundDeductionsCents: 2500,
        chargebackDeductionsCents: 0,
        priorAdjustmentCents: 0,
        bonusCents: 0,
      });
      expect(net).toBe(12500);
    });

    it('deducts chargebacks correctly', () => {
      const net = calculateNetPayable({
        grossCommissionsCents: 20000,
        refundDeductionsCents: 1000,
        chargebackDeductionsCents: 3000,
        priorAdjustmentCents: 0,
        bonusCents: 0,
      });
      expect(net).toBe(16000);
    });

    it('applies positive prior adjustments', () => {
      const net = calculateNetPayable({
        grossCommissionsCents: 10000,
        refundDeductionsCents: 0,
        chargebackDeductionsCents: 0,
        priorAdjustmentCents: 1500, // +$15.00
        bonusCents: 0,
      });
      expect(net).toBe(11500);
    });

    it('applies negative prior adjustments (clawbacks)', () => {
      const net = calculateNetPayable({
        grossCommissionsCents: 10000,
        refundDeductionsCents: 0,
        chargebackDeductionsCents: 0,
        priorAdjustmentCents: -2000, // -$20.00
        bonusCents: 0,
      });
      expect(net).toBe(8000);
    });

    it('adds performance bonuses', () => {
      const net = calculateNetPayable({
        grossCommissionsCents: 10000,
        refundDeductionsCents: 500,
        chargebackDeductionsCents: 0,
        priorAdjustmentCents: 0,
        bonusCents: 2500, // +$25.00
      });
      expect(net).toBe(12000);
    });

    it('computes exact zero net payout when deductions equal gross', () => {
      const net = calculateNetPayable({
        grossCommissionsCents: 5000,
        refundDeductionsCents: 5000,
        chargebackDeductionsCents: 0,
        priorAdjustmentCents: 0,
        bonusCents: 0,
      });
      expect(net).toBe(0);
    });

    it('computes negative net payout when deductions exceed gross', () => {
      const net = calculateNetPayable({
        grossCommissionsCents: 2000,
        refundDeductionsCents: 3500,
        chargebackDeductionsCents: 1000,
        priorAdjustmentCents: 0,
        bonusCents: 0,
      });
      expect(net).toBe(-2500);
    });

    it('calculates Sarah Jenkins hero scenario accurately', () => {
      // Sarah: Gross $512.40 - Refund $63.70 - Adjustment $20.00 = $428.70
      const net = calculateNetPayable({
        grossCommissionsCents: 51240,
        refundDeductionsCents: 6370,
        chargebackDeductionsCents: 0,
        priorAdjustmentCents: -2000,
        bonusCents: 0,
      });
      expect(net).toBe(42870);
    });
  });

  describe('Validation & Safety Protection', () => {
    it('rejects fractional cents loudly', () => {
      expect(() =>
        calculateNetPayable({
          grossCommissionsCents: 100.5,
          refundDeductionsCents: 0,
          chargebackDeductionsCents: 0,
          priorAdjustmentCents: 0,
          bonusCents: 0,
        })
      ).toThrow(PayoutCalculationError);
    });

    it('rejects unsafe integer values', () => {
      expect(() =>
        calculateNetPayable({
          grossCommissionsCents: Number.MAX_SAFE_INTEGER + 1,
          refundDeductionsCents: 0,
          chargebackDeductionsCents: 0,
          priorAdjustmentCents: 0,
          bonusCents: 0,
        })
      ).toThrow(PayoutCalculationError);
    });

    it('rejects negative gross commissions', () => {
      expect(() =>
        calculateNetPayable({
          grossCommissionsCents: -1000,
          refundDeductionsCents: 0,
          chargebackDeductionsCents: 0,
          priorAdjustmentCents: 0,
          bonusCents: 0,
        })
      ).toThrow(PayoutCalculationError);
    });

    it('rejects negative refund deductions', () => {
      expect(() =>
        calculateNetPayable({
          grossCommissionsCents: 5000,
          refundDeductionsCents: -500,
          chargebackDeductionsCents: 0,
          priorAdjustmentCents: 0,
          bonusCents: 0,
        })
      ).toThrow(PayoutCalculationError);
    });
  });

  describe('Deterministic Classification', () => {
    const baseRecord: PayoutRawRecord = {
      id: 'payout-test-1',
      recipientId: 'aff-test-1',
      recipientName: 'Test Creator',
      recipientEmail: 'creator@example.com',
      currency: 'USD',
      grossCommissionsCents: 10000,
      refundDeductionsCents: 200,
      chargebackDeductionsCents: 0,
      priorAdjustmentCents: 0,
      bonusCents: 0,
      historicalAverageCents: 9500,
      destinationLastChangedDaysAgo: 60,
    };

    it('classifies a clean normal payout as READY', () => {
      const item = classifyPayoutItem(baseRecord);
      expect(item.status).toBe('READY');
      expect(item.netPayableCents).toBe(9800);
      expect(item.anomalyCodes).toEqual([]);
      expect(item.holdReason).toBeUndefined();
    });

    it('classifies payout below $50 as HELD_BELOW_THRESHOLD', () => {
      const belowThresholdRecord: PayoutRawRecord = {
        ...baseRecord,
        grossCommissionsCents: 4500,
        refundDeductionsCents: 284,
        historicalAverageCents: 4000,
      };
      const item = classifyPayoutItem(belowThresholdRecord);
      expect(item.status).toBe('HELD_BELOW_THRESHOLD');
      expect(item.netPayableCents).toBe(4216);
      expect(item.anomalyCodes).toContain('BELOW_MINIMUM_THRESHOLD');
      expect(item.holdReason).toContain('contractual minimum threshold');
    });

    it('classifies non-positive balance as HELD_NON_POSITIVE', () => {
      const negativeRecord: PayoutRawRecord = {
        ...baseRecord,
        grossCommissionsCents: 1000,
        refundDeductionsCents: 2000,
      };
      const item = classifyPayoutItem(negativeRecord);
      expect(item.status).toBe('HELD_NON_POSITIVE');
      expect(item.netPayableCents).toBe(-1000);
      expect(item.anomalyCodes).toContain('NON_POSITIVE_BALANCE');
    });

    it('detects velocity spike when earnings exceed 3x historical average', () => {
      const velocityRecord: PayoutRawRecord = {
        ...baseRecord,
        grossCommissionsCents: 50000,
        historicalAverageCents: 12000, // 50000 > 3 * 12000 (36000)
      };
      const item = classifyPayoutItem(velocityRecord);
      expect(item.status).toBe('AI_ANALYSIS_REQUIRED');
      expect(item.anomalyCodes).toContain('VELOCITY_SPIKE');
      expect(item.holdReason).toContain('VELOCITY_SPIKE');
    });

    it('detects recent destination change within 3 days', () => {
      const recentChangeRecord: PayoutRawRecord = {
        ...baseRecord,
        destinationLastChangedDaysAgo: 2, // <= 3 days
      };
      const item = classifyPayoutItem(recentChangeRecord);
      expect(item.status).toBe('AI_ANALYSIS_REQUIRED');
      expect(item.anomalyCodes).toContain('RECENT_DESTINATION_CHANGE');
    });

    it('detects high refund rate exceeding 20%', () => {
      const highRefundRecord: PayoutRawRecord = {
        ...baseRecord,
        grossCommissionsCents: 10000,
        refundDeductionsCents: 2500, // 25% of gross
      };
      const item = classifyPayoutItem(highRefundRecord);
      expect(item.status).toBe('AI_ANALYSIS_REQUIRED');
      expect(item.anomalyCodes).toContain('HIGH_REFUND_RATE');
    });

    it('detects duplicate destination shared across multiple accounts', () => {
      const duplicates = new Set(['shared@agency.com']);
      const duplicateRecord: PayoutRawRecord = {
        ...baseRecord,
        recipientEmail: 'shared@agency.com',
      };
      const item = classifyPayoutItem(duplicateRecord, duplicates);
      expect(item.status).toBe('AI_ANALYSIS_REQUIRED');
      expect(item.anomalyCodes).toContain('DUPLICATE_DESTINATION');
    });

    it('detects duplicate destinations across a population automatically', () => {
      const records: PayoutRawRecord[] = [
        { ...baseRecord, id: 'item-1', recipientId: 'user-1', recipientEmail: 'shared@agency.com' },
        { ...baseRecord, id: 'item-2', recipientId: 'user-2', recipientEmail: 'shared@agency.com' },
        { ...baseRecord, id: 'item-3', recipientId: 'user-3', recipientEmail: 'unique@agency.com' },
      ];

      const classified = classifyPayoutPopulation(records);
      expect(classified[0].status).toBe('AI_ANALYSIS_REQUIRED');
      expect(classified[0].anomalyCodes).toContain('DUPLICATE_DESTINATION');
      expect(classified[1].status).toBe('AI_ANALYSIS_REQUIRED');
      expect(classified[1].anomalyCodes).toContain('DUPLICATE_DESTINATION');
      expect(classified[2].status).toBe('READY');
    });
  });

  describe('Aggregation & Exception Compression Metrics', () => {
    it('calculates compression metrics mathematically', () => {
      const metrics = calculateCompressionMetrics(1000, 17);
      expect(metrics.totalRecipients).toBe(1000);
      expect(metrics.manualReviewCount).toBe(17);
      expect(metrics.routineCount).toBe(983);
      expect(metrics.manualReviewRate).toBeCloseTo(0.017, 3);
      expect(metrics.reviewReductionRate).toBeCloseTo(0.983, 3);
      expect(metrics.formattedCompressionPercentage).toBe('98.3%');
    });

    it('aggregates batch correctly and reconciles amounts', () => {
      const sampleItems = classifyPayoutPopulation([
        {
          id: '1',
          recipientId: 'r1',
          recipientName: 'Normal',
          recipientEmail: 'r1@test.com',
          currency: 'USD',
          grossCommissionsCents: 10000,
          refundDeductionsCents: 0,
          chargebackDeductionsCents: 0,
          priorAdjustmentCents: 0,
          bonusCents: 0,
          historicalAverageCents: 9000,
          destinationLastChangedDaysAgo: 30,
        },
        {
          id: '2',
          recipientId: 'r2',
          recipientName: 'Below Threshold',
          recipientEmail: 'r2@test.com',
          currency: 'USD',
          grossCommissionsCents: 3000,
          refundDeductionsCents: 0,
          chargebackDeductionsCents: 0,
          priorAdjustmentCents: 0,
          bonusCents: 0,
          historicalAverageCents: 3000,
          destinationLastChangedDaysAgo: 30,
        },
        {
          id: '3',
          recipientId: 'r3',
          recipientName: 'Spike',
          recipientEmail: 'r3@test.com',
          currency: 'USD',
          grossCommissionsCents: 40000,
          refundDeductionsCents: 0,
          chargebackDeductionsCents: 0,
          priorAdjustmentCents: 0,
          bonusCents: 0,
          historicalAverageCents: 5000, // Velocity spike
          destinationLastChangedDaysAgo: 30,
        },
      ]);

      const summary = aggregatePayoutBatch(sampleItems);
      expect(summary.totalRecipients).toBe(3);
      expect(summary.readyCount).toBe(1);
      expect(summary.heldCount).toBe(1);
      expect(summary.analysisRequiredCount).toBe(1);

      expect(summary.readyAmountCents).toBe(10000);
      expect(summary.heldAmountCents).toBe(3000);
      expect(summary.analysisRequiredAmountCents).toBe(40000);
      expect(summary.totalNetPayableCents).toBe(53000);
      expect(summary.compression.formattedCompressionPercentage).toBe('66.7%');
    });
  });

  describe('Explain My Payout Waterfall', () => {
    it('generates itemized statement for Sarah Jenkins', () => {
      const sarah = classifyPayoutItem({
        id: 'payout-042',
        recipientId: 'aff-042',
        recipientName: 'Sarah Jenkins',
        recipientEmail: 'sarah.jenkins@creatorhub.net',
        currency: 'USD',
        grossCommissionsCents: 51240,
        refundDeductionsCents: 6370,
        chargebackDeductionsCents: 0,
        priorAdjustmentCents: -2000,
        bonusCents: 0,
        historicalAverageCents: 11000,
        destinationLastChangedDaysAgo: 180,
      });

      const statement = generatePayoutStatement(sarah);
      expect(statement.recipientName).toBe('Sarah Jenkins');
      expect(statement.netPayableCents).toBe(42870);
      expect(statement.statusCategory).toBe('EXCEPTION');
      expect(statement.waterfall).toEqual([
        { label: 'Gross Commissions', amountCents: 51240, isDeduction: false },
        { label: 'Refund Deductions', amountCents: 6370, isDeduction: true },
        { label: 'Prior Balance Adjustment', amountCents: 2000, isDeduction: true },
      ]);
    });

    it('generates itemized statement for John Doe (held below threshold)', () => {
      const john = classifyPayoutItem({
        id: 'payout-067',
        recipientId: 'aff-067',
        recipientName: 'John Doe',
        recipientEmail: 'john.doe@creatorhub.net',
        currency: 'USD',
        grossCommissionsCents: 4500,
        refundDeductionsCents: 284,
        chargebackDeductionsCents: 0,
        priorAdjustmentCents: 0,
        bonusCents: 0,
        historicalAverageCents: 4000,
        destinationLastChangedDaysAgo: 45,
      });

      const statement = generatePayoutStatement(john);
      expect(statement.recipientName).toBe('John Doe');
      expect(statement.netPayableCents).toBe(4216);
      expect(statement.statusCategory).toBe('HELD');
      expect(statement.explanation).toContain('contractual minimum threshold');
    });
  });
});
