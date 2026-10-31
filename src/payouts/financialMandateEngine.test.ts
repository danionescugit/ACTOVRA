import { describe, it, expect } from 'vitest';
import {
  generateSyntheticPayoutPopulation,
  classifyPayoutPopulation,
  aggregatePayoutBatch,
} from './index';
import {
  defaultFinancialMandateConfig,
  OperatorExceptionResolution,
  evaluateFinancialMandate,
  isBatchEligibleForHumanAuthorization,
  calculateExecutableBatchTotals,
  createMandateAuditPayload,
} from './index';
import { PayoutItem } from './schemas';

describe('Financial Mandate Engine & Exception Control (PAYOUT-03)', () => {
  const ledger = generateSyntheticPayoutPopulation();
  const items = classifyPayoutPopulation(ledger);
  const batchSummary = aggregatePayoutBatch(items);

  it('sanity checks the synthetic 1,000-affiliate batch baseline', () => {
    expect(batchSummary.totalRecipients).toBe(1000);
    expect(batchSummary.readyCount).toBe(917);
    expect(batchSummary.heldCount).toBe(66);
    expect(batchSummary.analysisRequiredCount).toBe(17);
    expect(batchSummary.totalNetPayableCents).toBe(14793075); // $147,930.75
    expect(batchSummary.readyAmountCents).toBe(14059447);      // $140,594.47
    expect(batchSummary.heldAmountCents).toBe(183420);         // $1,834.20
    expect(batchSummary.analysisRequiredAmountCents).toBe(552708); // $5,527.08
  });

  describe('Hero Batch Evaluation Before Exception Resolution', () => {
    it('evaluates normal hero batch as REVIEW_REQUIRED and NOT eligible for authorization', () => {
      const evaluation = evaluateFinancialMandate(batchSummary, items, []);

      expect(evaluation.status).toBe('REVIEW_REQUIRED');
      expect(evaluation.eligibleForHumanAuthorization).toBe(false);
      expect(isBatchEligibleForHumanAuthorization(evaluation)).toBe(false);

      // Check summary
      expect(evaluation.summary.totalRecipients).toBe(1000);
      expect(evaluation.summary.routineReadyCount).toBe(917);
      expect(evaluation.summary.hardHeldCount).toBe(66);
      expect(evaluation.summary.aiExceptionCount).toBe(17);
      expect(evaluation.summary.unresolvedExceptionCount).toBe(17);
      expect(evaluation.summary.approvedExceptionCount).toBe(0);
      expect(evaluation.summary.operatorHeldExceptionCount).toBe(0);

      // Candidate ready amounts
      expect(evaluation.summary.eligiblePayoutCount).toBe(917);
      expect(evaluation.summary.eligiblePayoutAmountCents).toBe(14059447); // $140,594.47
      expect(evaluation.summary.excludedPayoutCount).toBe(83); // 66 hard held + 17 unresolved
      expect(evaluation.summary.excludedPayoutAmountCents).toBe(183420 + 552708); // $7,361.28

      // Zero blocking violations, but review requirements present
      expect(evaluation.blockingViolations.length).toBe(0);
      expect(evaluation.reviewRequirements.length).toBeGreaterThan(0);

      // Specific check codes present
      const unresolvedCheck = evaluation.batchChecks.find(c => c.code === 'UNRESOLVED_AI_EXCEPTIONS');
      expect(unresolvedCheck).toBeDefined();
      expect(unresolvedCheck?.passed).toBe(false);
      expect(unresolvedCheck?.message).toContain('17 of 17 AI exception candidates require explicit human operator resolution');
    });
  });

  describe('Hero Batch After Simulated Human Exception Resolution', () => {
    // Build deterministic human operator resolutions for all 17 exceptions
    const aiItems = items.filter(i => i.status === 'AI_ANALYSIS_REQUIRED');
    expect(aiItems.length).toBe(17);

    // Human operator resolution plan:
    // 10 approved, 7 held by operator
    // Sarah Jenkins (payout-042, $428.70): APPROVED (verified promotional spike)
    // 5 velocity spikes (payout-043 to payout-047): APPROVED (verified)
    // 1 velocity spike (payout-048): HELD_BY_OPERATOR (abnormal referral pattern)
    // 4 high refund cases (payout-301 to payout-304): HELD_BY_OPERATOR (refunds > 25%)
    // 3 recent destination changes (payout-101 to payout-103):
    //   payout-101: APPROVED_FOR_BATCH (creator provided 2FA verification)
    //   payout-102, payout-103: HELD_BY_OPERATOR (unconfirmed account update)
    // 3 duplicate destinations (payout-201 to payout-203):
    //   payout-201, payout-202: APPROVED_FOR_BATCH (verified joint studio entity)
    //   payout-203: HELD_BY_OPERATOR (pending legal affidavit)
    const simulatedResolutions: OperatorExceptionResolution[] = [
      {
        payoutItemId: 'payout-042',
        resolutionStatus: 'APPROVED_FOR_BATCH',
        resolvedBy: 'finance.ops@company.com',
        resolvedAt: '2026-10-31T14:00:00.000Z',
        resolutionNote: 'Verified Sarah Jenkins campaign launch on TikTok; surge is legitimate sales volume.',
      },
      {
        payoutItemId: 'payout-043',
        resolutionStatus: 'APPROVED_FOR_BATCH',
        resolvedBy: 'finance.ops@company.com',
        resolvedAt: '2026-10-31T14:01:00.000Z',
        resolutionNote: 'Reviewed Tyler Ross traffic logs; low refund rate confirmed.',
      },
      {
        payoutItemId: 'payout-044',
        resolutionStatus: 'APPROVED_FOR_BATCH',
        resolvedBy: 'finance.ops@company.com',
        resolvedAt: '2026-10-31T14:02:00.000Z',
        resolutionNote: 'Approved velocity expansion.',
      },
      {
        payoutItemId: 'payout-045',
        resolutionStatus: 'APPROVED_FOR_BATCH',
        resolvedBy: 'finance.ops@company.com',
        resolvedAt: '2026-10-31T14:03:00.000Z',
        resolutionNote: 'Approved velocity expansion.',
      },
      {
        payoutItemId: 'payout-046',
        resolutionStatus: 'APPROVED_FOR_BATCH',
        resolvedBy: 'finance.ops@company.com',
        resolvedAt: '2026-10-31T14:04:00.000Z',
        resolutionNote: 'Approved velocity expansion.',
      },
      {
        payoutItemId: 'payout-047',
        resolutionStatus: 'APPROVED_FOR_BATCH',
        resolvedBy: 'finance.ops@company.com',
        resolvedAt: '2026-10-31T14:05:00.000Z',
        resolutionNote: 'Approved velocity expansion.',
      },
      {
        payoutItemId: 'payout-048',
        resolutionStatus: 'APPROVED_FOR_BATCH',
        resolvedBy: 'finance.ops@company.com',
        resolvedAt: '2026-10-31T14:06:00.000Z',
        resolutionNote: 'Reviewed Zoe Kravitz affiliate campaign traffic; confirmed legitimate conversion.',
      },
      {
        payoutItemId: 'payout-301',
        resolutionStatus: 'HELD_BY_OPERATOR',
        resolvedBy: 'risk.officer@company.com',
        resolvedAt: '2026-10-31T14:07:00.000Z',
        resolutionNote: 'Held: TechGear Reviews refund rate 26% exceeds tolerance.',
      },
      {
        payoutItemId: 'payout-302',
        resolutionStatus: 'HELD_BY_OPERATOR',
        resolvedBy: 'risk.officer@company.com',
        resolvedAt: '2026-10-31T14:08:00.000Z',
        resolutionNote: 'Held: Flash Deals Network refund rate exceeds tolerance.',
      },
      {
        payoutItemId: 'payout-303',
        resolutionStatus: 'HELD_BY_OPERATOR',
        resolvedBy: 'risk.officer@company.com',
        resolvedAt: '2026-10-31T14:09:00.000Z',
        resolutionNote: 'Held: Bargain Hunter Daily refund rate exceeds tolerance.',
      },
      {
        payoutItemId: 'payout-304',
        resolutionStatus: 'HELD_BY_OPERATOR',
        resolvedBy: 'risk.officer@company.com',
        resolvedAt: '2026-10-31T14:10:00.000Z',
        resolutionNote: 'Held: Coupon Matrix Hub refund rate exceeds tolerance.',
      },
      {
        payoutItemId: 'payout-101',
        resolutionStatus: 'APPROVED_FOR_BATCH',
        resolvedBy: 'security.lead@company.com',
        resolvedAt: '2026-10-31T14:11:00.000Z',
        resolutionNote: 'Marcus Chen completed phone and 2FA verification of new PayPal destination.',
      },
      {
        payoutItemId: 'payout-102',
        resolutionStatus: 'HELD_BY_OPERATOR',
        resolvedBy: 'security.lead@company.com',
        resolvedAt: '2026-10-31T14:12:00.000Z',
        resolutionNote: 'Chloe Bennett destination changed 2 days ago; pending outbound callback.',
      },
      {
        payoutItemId: 'payout-103',
        resolutionStatus: 'HELD_BY_OPERATOR',
        resolvedBy: 'security.lead@company.com',
        resolvedAt: '2026-10-31T14:13:00.000Z',
        resolutionNote: 'Liam O\'Connor destination changed today (0 days ago); hold enforced.',
      },
      {
        payoutItemId: 'payout-201',
        resolutionStatus: 'APPROVED_FOR_BATCH',
        resolvedBy: 'legal.compliance@company.com',
        resolvedAt: '2026-10-31T14:14:00.000Z',
        resolutionNote: 'Elena Rostova agency authorization on file for Creative Studio IO.',
      },
      {
        payoutItemId: 'payout-202',
        resolutionStatus: 'APPROVED_FOR_BATCH',
        resolvedBy: 'legal.compliance@company.com',
        resolvedAt: '2026-10-31T14:15:00.000Z',
        resolutionNote: 'Alex Vance agency authorization on file for Creative Studio IO.',
      },
      {
        payoutItemId: 'payout-203',
        resolutionStatus: 'HELD_BY_OPERATOR',
        resolvedBy: 'legal.compliance@company.com',
        resolvedAt: '2026-10-31T14:16:00.000Z',
        resolutionNote: 'Horizon Media Group missing agency contract amendment.',
      },
    ];

    it('transitions batch to PASSED and eligible for human authorization when all 17 exceptions are resolved', () => {
      const evaluation = evaluateFinancialMandate(batchSummary, items, simulatedResolutions);

      expect(evaluation.status).toBe('PASSED');
      expect(evaluation.eligibleForHumanAuthorization).toBe(true);
      expect(isBatchEligibleForHumanAuthorization(evaluation)).toBe(true);

      // Verify counts
      expect(evaluation.summary.totalRecipients).toBe(1000);
      expect(evaluation.summary.routineReadyCount).toBe(917);
      expect(evaluation.summary.hardHeldCount).toBe(66);
      expect(evaluation.summary.aiExceptionCount).toBe(17);
      expect(evaluation.summary.unresolvedExceptionCount).toBe(0);
      expect(evaluation.summary.approvedExceptionCount).toBe(10);
      expect(evaluation.summary.operatorHeldExceptionCount).toBe(7);

      // Final eligible count: 917 ready + 10 approved exceptions = 927
      expect(evaluation.summary.eligiblePayoutCount).toBe(927);
      // Final excluded count: 66 hard held + 7 operator held = 73
      expect(evaluation.summary.excludedPayoutCount).toBe(73);
      expect(evaluation.summary.eligiblePayoutCount + evaluation.summary.excludedPayoutCount).toBe(1000);

      // Exact amounts verified
      expect(evaluation.summary.eligiblePayoutAmountCents).toBe(14432313); // $144,323.13 candidate executable
      expect(evaluation.summary.excludedPayoutAmountCents).toBe(363262);   // $3,632.62 held (hard + operator)

      // Strict conservation of money
      const totalCents = evaluation.summary.eligiblePayoutAmountCents + evaluation.summary.excludedPayoutAmountCents;
      expect(totalCents).toBe(batchSummary.readyAmountCents + batchSummary.heldAmountCents + batchSummary.analysisRequiredAmountCents);
      expect(totalCents).toBe(14795575); // $147,955.75 total positive payable allocations

      // All batch checks passed
      expect(evaluation.batchChecks.every(c => c.passed)).toBe(true);
      expect(evaluation.blockingViolations.length).toBe(0);
      expect(evaluation.reviewRequirements.length).toBe(0);
    });

    it('matches calculateExecutableBatchTotals pure helper', () => {
      const totals = calculateExecutableBatchTotals(items, simulatedResolutions);
      expect(totals.count).toBe(927);
      expect(totals.approvedExceptionCount).toBe(10);
      expect(totals.operatorHeldExceptionCount).toBe(7);
      expect(totals.unresolvedCount).toBe(0);
    });
  });

  describe('Adversarial & Architectural Boundary Tests', () => {
    it('ADVERSARIAL 1: rejects AI autonomous execution attempt at schema level and engine level', () => {
      // 1. Schema forbids allowAIExecution: true
      const invalidConfigAttempt = {
        ...defaultFinancialMandateConfig,
        allowAIExecution: true,
      };
      expect(() => {
        // @ts-expect-error test invalid schema input
        evaluateFinancialMandate(batchSummary, items, [], invalidConfigAttempt);
      }).toThrow();
    });

    it('ADVERSARIAL 2: rejects AI or system attempting to act as operator exception resolver', () => {
      expect(() => {
        evaluateFinancialMandate(batchSummary, items, [
          {
            payoutItemId: 'payout-042',
            resolutionStatus: 'APPROVED_FOR_BATCH',
            resolvedBy: 'AI_Nemotron_3.5',
            resolvedAt: new Date().toISOString(),
            resolutionNote: 'AI approved',
          },
        ]);
      }).toThrow(/Exception resolution must be performed by an authorized human operator/);

      expect(() => {
        evaluateFinancialMandate(batchSummary, items, [
          {
            payoutItemId: 'payout-042',
            resolutionStatus: 'APPROVED_FOR_BATCH',
            resolvedBy: 'system-automated-bot',
            resolvedAt: new Date().toISOString(),
            resolutionNote: 'System approved',
          },
        ]);
      }).toThrow(/Exception resolution must be performed by an authorized human operator/);
    });

    it('ADVERSARIAL 3: AI recommendation alone never resolves an exception; item remains UNRESOLVED without human action', () => {
      // Even if AI gives recommendedAction = 'ALLOW_FOR_HUMAN_APPROVAL', without a human resolution it is unresolved
      const evaluation = evaluateFinancialMandate(batchSummary, items, []);
      expect(evaluation.summary.unresolvedExceptionCount).toBe(17);
      expect(evaluation.eligibleForHumanAuthorization).toBe(false);
    });

    it('ADVERSARIAL 4: blocks batch if batch total exceeds maxBatchTotalCents ceiling', () => {
      // Test ceiling of $100,000.00 (10,000,000 cents) against $140,594.47 batch
      const evaluation = evaluateFinancialMandate(
        batchSummary,
        items,
        [],
        { maxBatchTotalCents: 10000000 }
      );

      expect(evaluation.status).toBe('BLOCKED');
      expect(evaluation.eligibleForHumanAuthorization).toBe(false);

      const batchCeilingViolation = evaluation.blockingViolations.find(v => v.code === 'BATCH_CEILING_EXCEEDED');
      expect(batchCeilingViolation).toBeDefined();
      expect(batchCeilingViolation?.message).toContain('exceeds mandate ceiling of $100000.00');
    });

    it('ADVERSARIAL 5: detects and flags individual payout ceiling exceeded', () => {
      // Standard ceiling is $2,500.00 (250,000 cents)
      const oversizedItem: PayoutItem = {
        ...items[0],
        id: 'payout-oversized-999',
        netPayableCents: 350000, // $3,500.00
      };

      const testItems = [oversizedItem, ...items.slice(1)];
      const evaluation = evaluateFinancialMandate(
        batchSummary,
        testItems,
        [],
        { maxStandardPayoutCents: 250000 }
      );

      const ceilingWarning = evaluation.reviewRequirements.find(
        r => r.code === 'INDIVIDUAL_PAYOUT_CEILING_EXCEEDED' && r.relatedPayoutItemId === 'payout-oversized-999'
      );
      expect(ceilingWarning).toBeDefined();
      expect(ceilingWarning?.message).toContain('exceeds standard single payout ceiling of $2500.00');
    });

    it('ADVERSARIAL 6: blocks batch if an unsupported currency is introduced', () => {
      const foreignItem: PayoutItem = {
        ...items[0],
        id: 'payout-eur-001',
        currency: 'EUR',
      };

      const testItems = [foreignItem, ...items.slice(1)];
      const evaluation = evaluateFinancialMandate(
        batchSummary,
        testItems,
        [],
        { allowedCurrencies: ['USD'] }
      );

      expect(evaluation.status).toBe('BLOCKED');
      expect(evaluation.eligibleForHumanAuthorization).toBe(false);

      const currencyViolation = evaluation.blockingViolations.find(v => v.code === 'UNSUPPORTED_CURRENCY');
      expect(currencyViolation).toBeDefined();
      const itemViolation = evaluation.itemChecks.find(c => c.code === 'UNSUPPORTED_CURRENCY');
      expect(itemViolation?.message).toContain("currency 'EUR' is not in allowed currencies: USD");
    });

    it('ADVERSARIAL 7: prevents hard-held payout from ever entering executable batch', () => {
      // Find a hard-held item
      const hardHeldItem = items.find(i => i.status === 'HELD_BELOW_THRESHOLD' || i.status === 'HELD_NON_POSITIVE');
      expect(hardHeldItem).toBeDefined();

      // Rogue attempt to approve hard-held item for batch
      const rogueResolution: OperatorExceptionResolution = {
        payoutItemId: hardHeldItem!.id,
        resolutionStatus: 'APPROVED_FOR_BATCH',
        resolvedBy: 'rogue.actor@company.com',
        resolvedAt: new Date().toISOString(),
        resolutionNote: 'Rogue override attempt on hard hold',
      };

      const evaluation = evaluateFinancialMandate(batchSummary, items, [rogueResolution]);

      expect(evaluation.status).toBe('BLOCKED');
      expect(evaluation.eligibleForHumanAuthorization).toBe(false);

      const hardHoldViolation = evaluation.blockingViolations.find(v => v.code === 'HARD_HOLDS_PRESENT');
      expect(hardHoldViolation).toBeDefined();
      const itemViolation = evaluation.itemChecks.find(c => c.code === 'HARD_HOLDS_PRESENT');
      expect(itemViolation?.message).toContain('cannot be approved for batch execution');

      // The hard-held item's amount was NOT added to eligible payout amount
      expect(evaluation.summary.eligiblePayoutAmountCents).toBe(14059447); // Only routine ready
    });

    it('ADVERSARIAL 8: keeps batch in REVIEW_REQUIRED if even 1 of 17 exceptions is unresolved', () => {
      // Resolve 16 exceptions, leave 1 unresolved
      const partialResolutions: OperatorExceptionResolution[] = items
        .filter(i => i.status === 'AI_ANALYSIS_REQUIRED')
        .slice(0, 16)
        .map(i => ({
          payoutItemId: i.id,
          resolutionStatus: 'APPROVED_FOR_BATCH',
          resolvedBy: 'finance.ops@company.com',
          resolvedAt: new Date().toISOString(),
          resolutionNote: 'Approved in batch audit',
        }));

      const evaluation = evaluateFinancialMandate(batchSummary, items, partialResolutions);

      expect(evaluation.status).toBe('REVIEW_REQUIRED');
      expect(evaluation.eligibleForHumanAuthorization).toBe(false);
      expect(evaluation.summary.unresolvedExceptionCount).toBe(1);
    });

    it('creates well-formed structured audit payload', () => {
      const evaluation = evaluateFinancialMandate(batchSummary, items, []);
      const payload = createMandateAuditPayload(evaluation, 'batch-2026-10-31-001');

      expect(payload.eventType).toBe('MANDATE_EVALUATED');
      expect(payload.batchId).toBe('batch-2026-10-31-001');
      expect(payload.status).toBe('REVIEW_REQUIRED');
      expect(payload.eligibleForHumanAuthorization).toBe(false);
      expect(payload.totalRecipients).toBe(1000);
      expect(payload.eligiblePayoutCount).toBe(917);
      expect(payload.eligiblePayoutAmountCents).toBe(14059447);
      expect(payload.reviewRequirementCodes).toContain('UNRESOLVED_AI_EXCEPTIONS');
    });
  });
});
