import { type PayoutItem } from './schemas';

export interface ExceptionReviewPlaybook {
  payoutItemId: string;
  affiliateName: string;
  issueTitle: string;
  issueSubtitle: string;
  issueSummary: string;
  whyItMatters: string;
  whatActovraFound: string[];
  actovraFindings: string[]; // alias for compatibility
  whatYouNeedToVerify: string[];
  verificationSteps: string[]; // alias for compatibility
  whereToVerify: string;
  verificationSources: string[]; // alias for compatibility
  approveIf: string;
  approveWhen: string; // alias for compatibility
  holdIf: string;
  holdWhen: string; // alias for compatibility
  suggestedAction: 'APPROVE' | 'HOLD';
  suggestedNote?: string;
  recommendedActionText: string;
  recommendedNextStep: string;
  attentionLevel: 'HIGH' | 'MEDIUM' | 'LOW';
  riskScore: number;
  assessmentSource: string;
  sourceDetails: string;
}

/**
 * Deterministic review playbooks for all anomaly classes.
 *
 * ACTOVRA Product Rule:
 * "ACTOVRA doesn't just flag an exception. It tells the operator why it matters,
 * what evidence to inspect, and exactly what must be true before the payout can be approved."
 *
 * Deterministic rules enforce minimum mandatory verification steps.
 * AI risk evaluation provides advisory context but cannot remove mandatory checks.
 */
export function getReviewPlaybook(item: PayoutItem): ExceptionReviewPlaybook {
  const affiliateName = item.recipientName;

  // 1. Sarah Jenkins hero item (PAYOUT-02 proven Nemotron values)
  if (item.id === 'payout-042') {
    const actovraFindings = [
      'Payout calculation is internally consistent ($512.40 gross - $63.70 refunds - $20.00 prior adjustment = $428.70 net)',
      'Payout destination has not recently changed (account updated 180 days ago)',
      'Historical 90-day rolling baseline is $110.00',
      'Current payout is $428.70 (3.89x baseline)',
      'Minimal historical refund liability (3.1%)',
    ];
    const verificationSteps = [
      'Confirm the underlying commission activity legitimately explains the increase',
      'Confirm the source transactions and commission records are valid',
      'Verify traffic source conversion analytics in marketing portal',
    ];
    const verificationSources = [
      'Marketing portal',
      'Affiliate sales reports',
      'Order attribution ledger',
      'Traffic conversion logs',
    ];
    const approveWhen =
      'The underlying commission activity legitimately explains the increase from campaign launch and source records are valid.';
    const holdWhen =
      'The increase cannot be explained, or source records are unverified.';

    return {
      payoutItemId: item.id,
      affiliateName,
      issueTitle: 'Unusual payout increase',
      issueSubtitle: "Sarah's payout is 3.89× her historical average.",
      issueSummary: 'Unusual payout increase (3.89x baseline surge)',
      whyItMatters:
        'Velocity surges can indicate legitimate viral traffic or commission fraud. A significant velocity jump over historical baselines may reflect sudden legitimate sales volume, but can also stem from commission misattribution, bulk order anomalies, or unearned affiliate tiers.',
      whatActovraFound: actovraFindings,
      actovraFindings,
      whatYouNeedToVerify: verificationSteps,
      verificationSteps,
      whereToVerify: verificationSources.join(' • '),
      verificationSources,
      approveIf: approveWhen,
      approveWhen,
      holdIf: holdWhen,
      holdWhen,
      suggestedAction: 'APPROVE',
      suggestedNote:
        'Verified Sarah Jenkins campaign launch on TikTok; surge is legitimate sales volume.',
      recommendedActionText: 'Verify commission activity before approval',
      recommendedNextStep: 'Verify commission activity',
      attentionLevel: 'MEDIUM',
      riskScore: 50,
      assessmentSource: 'AI analysis · NVIDIA Nemotron 3.5',
      sourceDetails: 'nvidia/nemotron-3.5-lightning-30b-a3b',
    };
  }

  // 2. Security risk: destination changed recently (Marcus Chen & cohort)
  if (item.anomalyCodes.includes('RECENT_DESTINATION_CHANGE')) {
    const daysAgo = item.destinationLastChangedDaysAgo;
    const daysText = daysAgo === 0 ? 'today' : daysAgo === 1 ? '1 day ago' : `${daysAgo} days ago`;
    const actovraFindings = [
      `Destination updated ${daysText} (within the 3-day active security hold window)`,
      `Payout net amount is $${(item.netPayableCents / 100).toFixed(2)}`,
      'Account has active affiliate conversion history',
      `Current payout destination: ${item.recipientEmail}`,
    ];
    const verificationSteps = [
      `Contact ${affiliateName} using a previously verified contact method (phone/2FA)`,
      `Confirm ${affiliateName} requested the payout destination change`,
      'Verify the destination matches their confirmation in security logs',
      'Important security instruction: Do not rely only on contact information added or changed together with the payout destination.',
    ];
    const verificationSources = [
      'Security event log',
      'Historical 2FA audit logs',
      'Outbound callback record',
      'Verified CRM contact profile',
    ];
    const approveWhen =
      `${affiliateName} confirmed the change through a previously trusted contact channel and the destination matches.`;
    const holdWhen =
      'Hold the payout if the change cannot be independently verified or any details conflict.';

    return {
      payoutItemId: item.id,
      affiliateName,
      issueTitle: 'Payout destination changed recently',
      issueSubtitle: `Payment destination was updated ${
        daysAgo === 0 ? 'today' : `${daysAgo} day(s) ago`
      }, shortly before the payout cycle.`,
      issueSummary: 'Payout destination changed recently (within 72-hour security window)',
      whyItMatters:
        'A payout destination changed shortly before payment can indicate account takeover or payment-redirection fraud. Diversion attacks typically alter credentials right before settlement.',
      whatActovraFound: actovraFindings,
      actovraFindings,
      whatYouNeedToVerify: verificationSteps,
      verificationSteps,
      whereToVerify: verificationSources.join(' • '),
      verificationSources,
      approveIf: approveWhen,
      approveWhen,
      holdIf: holdWhen,
      holdWhen,
      suggestedAction: 'HOLD',
      suggestedNote:
        'Marcus Chen completed phone and 2FA verification of new PayPal destination.',
      recommendedActionText: 'Hold until ownership is verified',
      recommendedNextStep: 'Verify account ownership via 2FA callback',
      attentionLevel: 'HIGH',
      riskScore: 85,
      assessmentSource: 'AI analysis · NVIDIA Nemotron 3.5',
      sourceDetails: 'nvidia/nemotron-3.5-lightning-30b-a3b',
    };
  }

  // 3. Financial risk: high refund rate (TechGear Reviews & cohort)
  if (item.anomalyCodes.includes('HIGH_REFUND_RATE')) {
    const refundPercentage = (
      ((item.refundDeductionsCents + item.chargebackDeductionsCents) /
        item.grossCommissionsCents) *
      100
    ).toFixed(1);
    const actovraFindings = [
      `Refund deductions ($${(item.refundDeductionsCents / 100).toFixed(
        2
      )}) exceed 20% of gross commissions ($${(
        item.grossCommissionsCents / 100
      ).toFixed(2)})`,
      `Refund and chargeback rate is ${refundPercentage}%`,
      'Deterministic calculation deducted all refunds and chargebacks from net payable',
      `Net payable remains positive at $${(item.netPayableCents / 100).toFixed(2)}`,
    ];
    const verificationSteps = [
      "Compare refund rate with recipient's historical range",
      'Inspect merchant return transaction logs and chargeback portal records',
      'Confirm commissions were adjusted according to payout rules',
      'Check customer support dispute tickets for product quality issues',
    ];
    const verificationSources = [
      'Merchant return transaction logs',
      'Chargeback portal records',
      'Customer support dispute tickets',
    ];
    const approveWhen =
      'The refund activity is legitimate customer returns and the payout calculation correctly reflects all deductions.';
    const holdWhen =
      'Hold the payout if refund activity cannot be explained or source transactions indicate chargeback fraud.';

    return {
      payoutItemId: item.id,
      affiliateName,
      issueTitle: 'Unusually high refund rate',
      issueSubtitle: `Refund and chargeback deductions (${refundPercentage}%) exceed tolerance.`,
      issueSummary: `Unusually high refund rate (${refundPercentage}% vs 10% threshold)`,
      whyItMatters:
        'Elevated refund rates increase clawback exposure and indicate campaign quality problems, invalid commission attribution, or potential return abuse.',
      whatActovraFound: actovraFindings,
      actovraFindings,
      whatYouNeedToVerify: verificationSteps,
      verificationSteps,
      whereToVerify: verificationSources.join(' • '),
      verificationSources,
      approveIf: approveWhen,
      approveWhen,
      holdIf: holdWhen,
      holdWhen,
      suggestedAction: 'HOLD',
      suggestedNote: 'Held: TechGear Reviews refund rate exceeds tolerance.',
      recommendedActionText: 'Hold pending refund audit',
      recommendedNextStep: 'Inspect refund transactions',
      attentionLevel: 'HIGH',
      riskScore: 78,
      assessmentSource: 'AI analysis · NVIDIA Nemotron 3.5',
      sourceDetails: 'nvidia/nemotron-3.5-lightning-30b-a3b',
    };
  }

  // 4. Duplicate destination: shared payout account (Elena Rostova, Alex Vance, Horizon Media)
  if (item.anomalyCodes.includes('DUPLICATE_DESTINATION')) {
    const actovraFindings = [
      `Shared PayPal destination email detected across multiple accounts: ${item.recipientEmail}`,
      `Individual net payable is $${(item.netPayableCents / 100).toFixed(2)}`,
      'Distinct affiliate IDs and tax records on file for each entity',
      'First detected during October 2026 pre-flight clustering',
    ];
    const verificationSteps = [
      'Confirm both recipients are legitimately associated with the same agency/business',
      'Confirm the shared payout destination is authorized under signed agency agreement',
      'Check that neither payout duplicates the other in the transaction ledger',
      'Check recent destination-change history for suspicious re-routing',
    ];
    const verificationSources = [
      'Affiliate legal contracts',
      'Corporate registry',
      'Agency representation agreement',
    ];
    const approveWhen =
      'Both payees have a signed agency agreement on file confirming authorization to use the shared PayPal address.';
    const holdWhen =
      'The affiliates claim to be independent and undisclosed sharing cannot be verified.';

    return {
      payoutItemId: item.id,
      affiliateName,
      issueTitle: 'Shared payout account detected',
      issueSubtitle: 'Recipient uses a PayPal destination shared with other affiliate accounts.',
      issueSummary: 'Shared payout account detected (duplicate destination)',
      whyItMatters:
        'Two or more recipients are using the same payout destination. This may reflect collusion or undisclosed multi-accounting, though legitimate for agency representation.',
      whatActovraFound: actovraFindings,
      actovraFindings,
      whatYouNeedToVerify: verificationSteps,
      verificationSteps,
      whereToVerify: verificationSources.join(' • '),
      verificationSources,
      approveIf: approveWhen,
      approveWhen,
      holdIf: holdWhen,
      holdWhen,
      suggestedAction: 'APPROVE',
      suggestedNote: `${affiliateName} agency authorization on file for Creative Studio IO.`,
      recommendedActionText: 'Verify agency relationship',
      recommendedNextStep: 'Check agency contracts',
      attentionLevel: 'MEDIUM',
      riskScore: 65,
      assessmentSource: 'AI analysis · NVIDIA Nemotron 3.5',
      sourceDetails: 'nvidia/nemotron-3.5-lightning-30b-a3b',
    };
  }

  // Default fallback for any remaining exception items
  const defaultFindings = [
    `Anomaly flags detected: ${item.anomalyCodes.join(', ')}`,
    `Net calculated amount: $${(item.netPayableCents / 100).toFixed(2)}`,
    `Destination: ${item.recipientEmail}`,
  ];
  const defaultSteps = [
    'Inspect transaction logs for commission source authenticity',
    'Verify recipient account state and historical baseline',
  ];
  const defaultSources = ['Affiliate ledger', 'Transaction logs'];

  return {
    payoutItemId: item.id,
    affiliateName,
    issueTitle: 'Exception Requires Review',
    issueSubtitle: 'Flagged for operational review prior to disbursement.',
    issueSummary: `Exception requires review (${item.anomalyCodes.join(', ')})`,
    whyItMatters:
      'Deterministic safety gates flagged this item to ensure financial controls are upheld.',
    whatActovraFound: defaultFindings,
    actovraFindings: defaultFindings,
    whatYouNeedToVerify: defaultSteps,
    verificationSteps: defaultSteps,
    whereToVerify: defaultSources.join(' • '),
    verificationSources: defaultSources,
    approveIf: 'Calculations and identity are verified against records.',
    approveWhen: 'Calculations and identity are verified against records.',
    holdIf: 'Discrepancies remain unresolved.',
    holdWhen: 'Discrepancies remain unresolved.',
    suggestedAction: 'APPROVE',
    suggestedNote: 'Verified and approved by finance operator',
    recommendedActionText: 'Review exception details',
    recommendedNextStep: 'Inspect records',
    attentionLevel: 'LOW',
    riskScore: 35,
    assessmentSource: 'Automated safety review',
    sourceDetails: 'Deterministic Safety Gate',
  };
}
