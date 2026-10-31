import { describe, it, expect } from 'vitest';
import {
  generateSyntheticPayoutPopulation,
  getSarahJenkinsDemoRecord,
  getJohnDoeDemoRecord,
} from './syntheticData';
import {
  classifyPayoutPopulation,
  aggregatePayoutBatch,
} from './calculationEngine';

describe('Synthetic Payout Dataset (1,000 Affiliates)', () => {
  it('generates exactly 1,000 records deterministically', () => {
    const run1 = generateSyntheticPayoutPopulation();
    const run2 = generateSyntheticPayoutPopulation();

    expect(run1).toHaveLength(1000);
    expect(run2).toHaveLength(1000);
    expect(run1).toEqual(run2);
  });

  it('classifies the 1,000 population into the exact 917 / 66 / 17 distribution', () => {
    const raw = generateSyntheticPayoutPopulation();
    const evaluated = classifyPayoutPopulation(raw);

    const readyItems = evaluated.filter((i) => i.status === 'READY');
    const heldItems = evaluated.filter(
      (i) => i.status === 'HELD_BELOW_THRESHOLD' || i.status === 'HELD_NON_POSITIVE'
    );
    const reviewItems = evaluated.filter((i) => i.status === 'AI_ANALYSIS_REQUIRED');

    expect(evaluated).toHaveLength(1000);
    expect(readyItems).toHaveLength(917);
    expect(heldItems).toHaveLength(66);
    expect(reviewItems).toHaveLength(17);

    // Sum invariant
    expect(readyItems.length + heldItems.length + reviewItems.length).toBe(1000);
  });

  it('computes exact 98.3% Exception Compression Rate in batch summary', () => {
    const raw = generateSyntheticPayoutPopulation();
    const evaluated = classifyPayoutPopulation(raw);
    const summary = aggregatePayoutBatch(evaluated);

    expect(summary.totalRecipients).toBe(1000);
    expect(summary.readyCount).toBe(917);
    expect(summary.heldCount).toBe(66);
    expect(summary.analysisRequiredCount).toBe(17);

    expect(summary.compression.routineCount).toBe(983);
    expect(summary.compression.manualReviewCount).toBe(17);
    expect(summary.compression.formattedCompressionPercentage).toBe('98.3%');

    // Monetary amounts must be positive integer cents
    expect(summary.totalGrossCents).toBeGreaterThan(7000000); // > $70k
    expect(summary.totalNetPayableCents).toBeGreaterThan(7000000);
    expect(summary.readyAmountCents).toBeGreaterThan(6000000);
    expect(summary.analysisRequiredAmountCents).toBeGreaterThan(200000);
  });

  it('contains Sarah Jenkins hero demo item (payout-042) with Velocity Spike', () => {
    const sarahRaw = getSarahJenkinsDemoRecord();
    expect(sarahRaw.id).toBe('payout-042');
    expect(sarahRaw.recipientName).toBe('Sarah Jenkins');

    const raw = generateSyntheticPayoutPopulation();
    const evaluated = classifyPayoutPopulation(raw);
    const sarah = evaluated.find((i) => i.id === 'payout-042')!;

    expect(sarah).toBeDefined();
    expect(sarah.netPayableCents).toBe(42870); // $428.70
    expect(sarah.historicalAverageCents).toBe(11000); // $110.00
    expect(sarah.status).toBe('AI_ANALYSIS_REQUIRED');
    expect(sarah.anomalyCodes).toContain('VELOCITY_SPIKE');
  });

  it('contains John Doe demo item (payout-067) held below $50 threshold', () => {
    const johnRaw = getJohnDoeDemoRecord();
    expect(johnRaw.id).toBe('payout-067');
    expect(johnRaw.recipientName).toBe('John Doe');

    const raw = generateSyntheticPayoutPopulation();
    const evaluated = classifyPayoutPopulation(raw);
    const john = evaluated.find((i) => i.id === 'payout-067')!;

    expect(john).toBeDefined();
    expect(john.netPayableCents).toBe(4216); // $42.16
    expect(john.status).toBe('HELD_BELOW_THRESHOLD');
    expect(john.anomalyCodes).toContain('BELOW_MINIMUM_THRESHOLD');
  });

  it('contains Marcus Chen (payout-101) with recent destination change', () => {
    const raw = generateSyntheticPayoutPopulation();
    const evaluated = classifyPayoutPopulation(raw);
    const marcus = evaluated.find((i) => i.id === 'payout-101')!;

    expect(marcus).toBeDefined();
    expect(marcus.recipientName).toBe('Marcus Chen');
    expect(marcus.destinationLastChangedDaysAgo).toBe(1);
    expect(marcus.status).toBe('AI_ANALYSIS_REQUIRED');
    expect(marcus.anomalyCodes).toContain('RECENT_DESTINATION_CHANGE');
  });

  it('contains Elena Rostova and Alex Vance sharing duplicate destination email', () => {
    const raw = generateSyntheticPayoutPopulation();
    const evaluated = classifyPayoutPopulation(raw);

    const elena = evaluated.find((i) => i.id === 'payout-201')!;
    const alex = evaluated.find((i) => i.id === 'payout-202')!;

    expect(elena).toBeDefined();
    expect(alex).toBeDefined();
    expect(elena.recipientEmail).toBe('shared-payout@creativestudio.io');
    expect(alex.recipientEmail).toBe('shared-payout@creativestudio.io');

    expect(elena.status).toBe('AI_ANALYSIS_REQUIRED');
    expect(elena.anomalyCodes).toContain('DUPLICATE_DESTINATION');
    expect(alex.status).toBe('AI_ANALYSIS_REQUIRED');
    expect(alex.anomalyCodes).toContain('DUPLICATE_DESTINATION');
  });

  it('contains inactive affiliate (payout-401) held with negative balance', () => {
    const raw = generateSyntheticPayoutPopulation();
    const evaluated = classifyPayoutPopulation(raw);
    const inactive = evaluated.find((i) => i.id === 'payout-401')!;

    expect(inactive).toBeDefined();
    expect(inactive.netPayableCents).toBe(-2500); // -$25.00
    expect(inactive.status).toBe('HELD_NON_POSITIVE');
    expect(inactive.anomalyCodes).toContain('NON_POSITIVE_BALANCE');
  });
});
