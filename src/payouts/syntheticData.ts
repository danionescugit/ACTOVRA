import { type PayoutRawRecord } from './schemas';

/**
 * Deterministic pseudo-random number generator (Linear Congruential Generator).
 * Uses fixed seed to guarantee 100% reproducible synthetic generation.
 */
function createPrng(seed: number = 42) {
  let state = seed >>> 0;
  return function next(): number {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const FIRST_NAMES = [
  'Emma', 'Liam', 'Olivia', 'Noah', 'Ava', 'Ethan', 'Sophia', 'Mason', 'Isabella', 'William',
  'Mia', 'James', 'Charlotte', 'Benjamin', 'Amelia', 'Lucas', 'Harper', 'Henry', 'Evelyn', 'Alexander',
  'Abigail', 'Michael', 'Emily', 'Daniel', 'Elizabeth', 'Matthew', 'Mila', 'Aiden', 'Ella', 'David',
  'Avery', 'Joseph', 'Sofia', 'Jackson', 'Camila', 'Samuel', 'Aria', 'Sebastian', 'Scarlett', 'Gabriel',
];

const LAST_NAMES = [
  'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez',
  'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin',
  'Lee', 'Perez', 'Thompson', 'White', 'Harris', 'Sanchez', 'Clark', 'Ramirez', 'Lewis', 'Robinson',
  'Walker', 'Young', 'Allen', 'King', 'Wright', 'Scott', 'Torres', 'Nguyen', 'Hill', 'Flores',
];

/**
 * Generates the authoritative 1,000-affiliate synthetic payout dataset.
 *
 * Characteristics:
 * - Deterministic, zero external APIs.
 * - Exact population: 1,000 recipients.
 * - Segmentation output when passed to calculationEngine:
 *   - 917 READY (normal recurring clean payouts)
 *   - 66 HELD (64 below $50 threshold, 2 non-positive)
 *   - 17 AI_ANALYSIS_REQUIRED (7 velocity, 4 refund, 3 recent destination, 3 duplicate destination)
 * - Known inspectable IDs:
 *   - Sarah Jenkins: aff-042 (payout-042) -> $428.70 net vs $110.00 baseline (Velocity Spike)
 *   - John Doe: aff-067 (payout-067) -> $42.16 net (< $50 threshold)
 *   - Marcus Chen: aff-101 (payout-101) -> Destination changed 1 day ago
 *   - Elena Rostova & Alex Vance: aff-201, aff-202 -> Duplicate PayPal destination
 */
export function generateSyntheticPayoutPopulation(): PayoutRawRecord[] {
  const records: PayoutRawRecord[] = [];
  const rand = createPrng(1337);

  // --------------------------------------------------------------------------
  // Group 1: 17 DESIGNATED ANOMALIES (AI_ANALYSIS_REQUIRED)
  // --------------------------------------------------------------------------

  // 1a. Sarah Jenkins (Hero Demo Item - Velocity Spike)
  records.push({
    id: 'payout-042',
    recipientId: 'aff-042',
    recipientName: 'Sarah Jenkins',
    recipientEmail: 'sarah.jenkins@creatorhub.net',
    currency: 'USD',
    grossCommissionsCents: 51240, // $512.40
    refundDeductionsCents: 6370,  // -$63.70
    chargebackDeductionsCents: 0,
    priorAdjustmentCents: -2000,  // -$20.00
    bonusCents: 0,
    historicalAverageCents: 11000, // $110.00 -> Net $428.70 is 3.89x historical baseline!
    destinationLastChangedDaysAgo: 180,
  });

  // 1b. Additional 6 Velocity Spikes
  const velocityNames = [
    'Tyler Ross', 'Rachel Green', 'Devon Vance', 'Maya Lin', 'Carlos Santana', 'Zoe Kravitz'
  ];
  for (let i = 0; i < 6; i++) {
    const idx = 43 + i;
    const gross = 38000 + Math.floor(rand() * 15000);
    const refund = Math.floor(gross * 0.04);
    const net = gross - refund;
    // Set baseline so net > 3 * baseline
    const baseline = Math.floor(net / 3.4);
    records.push({
      id: `payout-${String(idx).padStart(3, '0')}`,
      recipientId: `aff-${String(idx).padStart(3, '0')}`,
      recipientName: velocityNames[i],
      recipientEmail: `${velocityNames[i].toLowerCase().replace(/\s+/g, '.')}@creatorhub.net`,
      currency: 'USD',
      grossCommissionsCents: gross,
      refundDeductionsCents: refund,
      chargebackDeductionsCents: 0,
      priorAdjustmentCents: 0,
      bonusCents: 0,
      historicalAverageCents: baseline,
      destinationLastChangedDaysAgo: 90 + Math.floor(rand() * 100),
    });
  }

  // 1c. 4 High Refund / Chargeback Cases
  const refundNames = [
    'TechGear Reviews', 'Flash Deals Network', 'Bargain Hunter Daily', 'Coupon Matrix Hub'
  ];
  for (let i = 0; i < 4; i++) {
    const idx = 301 + i;
    const gross = 35000 + Math.floor(rand() * 10000);
    const refundDeduction = Math.floor(gross * 0.26); // 26% refund rate (>20% threshold)
    records.push({
      id: `payout-${String(idx).padStart(3, '0')}`,
      recipientId: `aff-${String(idx).padStart(3, '0')}`,
      recipientName: refundNames[i],
      recipientEmail: `billing@${refundNames[i].toLowerCase().replace(/\s+/g, '')}.com`,
      currency: 'USD',
      grossCommissionsCents: gross,
      refundDeductionsCents: refundDeduction,
      chargebackDeductionsCents: 2000,
      priorAdjustmentCents: 0,
      bonusCents: 0,
      historicalAverageCents: Math.floor(gross * 0.7),
      destinationLastChangedDaysAgo: 120,
    });
  }

  // 1d. 3 Recent Destination Changes (< 3 days security window)
  const recentDestPayees = [
    { name: 'Marcus Chen', id: 'aff-101', pId: 'payout-101', days: 1, email: 'marcus.chen@creatorhub.net' },
    { name: 'Chloe Bennett', id: 'aff-102', pId: 'payout-102', days: 2, email: 'chloe.b@creatorhub.net' },
    { name: 'Liam O\'Connor', id: 'aff-103', pId: 'payout-103', days: 0, email: 'liam.oc@creatorhub.net' },
  ];
  for (const item of recentDestPayees) {
    records.push({
      id: item.pId,
      recipientId: item.id,
      recipientName: item.name,
      recipientEmail: item.email,
      currency: 'USD',
      grossCommissionsCents: 24500,
      refundDeductionsCents: 500,
      chargebackDeductionsCents: 0,
      priorAdjustmentCents: 0,
      bonusCents: 0,
      historicalAverageCents: 22000, // Normal velocity, but triggered by destination change
      destinationLastChangedDaysAgo: item.days,
    });
  }

  // 1e. 3 Duplicate Destination Email Cases
  const sharedEmail = 'shared-payout@creativestudio.io';
  const duplicatePayees = [
    { name: 'Elena Rostova', id: 'aff-201', pId: 'payout-201' },
    { name: 'Alex Vance', id: 'aff-202', pId: 'payout-202' },
    { name: 'Horizon Media Group', id: 'aff-203', pId: 'payout-203' },
  ];
  for (const item of duplicatePayees) {
    records.push({
      id: item.pId,
      recipientId: item.id,
      recipientName: item.name,
      recipientEmail: sharedEmail,
      currency: 'USD',
      grossCommissionsCents: 18000 + Math.floor(rand() * 5000),
      refundDeductionsCents: 300,
      chargebackDeductionsCents: 0,
      priorAdjustmentCents: 0,
      bonusCents: 0,
      historicalAverageCents: 17000,
      destinationLastChangedDaysAgo: 60,
    });
  }

  // --------------------------------------------------------------------------
  // Group 2: 66 HELD ITEMS
  // --------------------------------------------------------------------------

  // 2a. John Doe (Hero Demo Item - Below Threshold)
  records.push({
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

  // 2b. 63 Additional Below-Threshold Items ($5.00 to $49.50)
  for (let i = 0; i < 63; i++) {
    const idx = 501 + i;
    // Ensure net is strictly between 500 and 4950 cents
    const netTarget = 600 + Math.floor(rand() * 4200);
    const refund = 100 + Math.floor(rand() * 200);
    const gross = netTarget + refund;

    const fn = FIRST_NAMES[i % FIRST_NAMES.length];
    const ln = LAST_NAMES[(i * 3) % LAST_NAMES.length];

    records.push({
      id: `payout-${String(idx).padStart(3, '0')}`,
      recipientId: `aff-${String(idx).padStart(3, '0')}`,
      recipientName: `${fn} ${ln}`,
      recipientEmail: `${fn.toLowerCase()}.${ln.toLowerCase()}.${idx}@creatorhub.net`,
      currency: 'USD',
      grossCommissionsCents: gross,
      refundDeductionsCents: refund,
      chargebackDeductionsCents: 0,
      priorAdjustmentCents: 0,
      bonusCents: 0,
      historicalAverageCents: netTarget,
      destinationLastChangedDaysAgo: 30 + Math.floor(rand() * 60),
    });
  }

  // 2c. 2 Non-positive balance items
  records.push({
    id: 'payout-401',
    recipientId: 'aff-401',
    recipientName: 'Inactive Affiliate Delta',
    recipientEmail: 'delta.inactive@creatorhub.net',
    currency: 'USD',
    grossCommissionsCents: 1000,
    refundDeductionsCents: 1500,
    chargebackDeductionsCents: 2000, // Gross $10 - Deductions $35 = -$25
    priorAdjustmentCents: 0,
    bonusCents: 0,
    historicalAverageCents: 5000,
    destinationLastChangedDaysAgo: 100,
  });

  records.push({
    id: 'payout-402',
    recipientId: 'aff-402',
    recipientName: 'Dormant Partner Epsilon',
    recipientEmail: 'epsilon.dormant@creatorhub.net',
    currency: 'USD',
    grossCommissionsCents: 0,
    refundDeductionsCents: 0,
    chargebackDeductionsCents: 0,
    priorAdjustmentCents: 0,
    bonusCents: 0,
    historicalAverageCents: 0,
    destinationLastChangedDaysAgo: 300,
  });

  // --------------------------------------------------------------------------
  // Group 3: 917 ROUTINE READY ITEMS
  // --------------------------------------------------------------------------
  const readyCountNeeded = 1000 - records.length; // 1000 - (17 + 66) = 917

  for (let i = 0; i < readyCountNeeded; i++) {
    const idx = 1000 + i;
    // Routine clean payout: gross between $60.00 and $250.00
    const gross = 6000 + Math.floor(rand() * 19000);
    // Minimal refund rate (0 to 3%)
    const refund = Math.floor(gross * (0.01 + rand() * 0.02));
    const net = gross - refund;

    // Normal historical average: net is within 0.8x to 1.4x of baseline
    const baseline = Math.floor(net / (0.9 + rand() * 0.4));

    const fn = FIRST_NAMES[(i + 7) % FIRST_NAMES.length];
    const ln = LAST_NAMES[(i * 5 + 11) % LAST_NAMES.length];

    records.push({
      id: `payout-${String(idx).padStart(4, '0')}`,
      recipientId: `aff-${String(idx).padStart(4, '0')}`,
      recipientName: `${fn} ${ln}`,
      recipientEmail: `${fn.toLowerCase()}.${ln.toLowerCase()}.${idx}@creatorhub.net`,
      currency: 'USD',
      grossCommissionsCents: gross,
      refundDeductionsCents: refund,
      chargebackDeductionsCents: 0,
      priorAdjustmentCents: 0,
      bonusCents: 0,
      historicalAverageCents: baseline,
      destinationLastChangedDaysAgo: 15 + Math.floor(rand() * 200), // > 3 days
    });
  }

  return records;
}

/**
 * Returns Sarah Jenkins' hero demo item.
 */
export function getSarahJenkinsDemoRecord(): PayoutRawRecord {
  const records = generateSyntheticPayoutPopulation();
  const item = records.find((r) => r.id === 'payout-042');
  if (!item) {
    throw new Error('Sarah Jenkins demo record not found');
  }
  return item;
}

/**
 * Returns John Doe's held demo item.
 */
export function getJohnDoeDemoRecord(): PayoutRawRecord {
  const records = generateSyntheticPayoutPopulation();
  const item = records.find((r) => r.id === 'payout-067');
  if (!item) {
    throw new Error('John Doe demo record not found');
  }
  return item;
}

/**
 * Returns deterministic synthetic context narrative for exception items.
 */
export function getExceptionContext(item: {
  id: string;
  anomalyCodes: string[];
  recipientName: string;
}): string {
  if (item.id === 'payout-042') {
    return 'Sarah Jenkins published a viral product tutorial and review video on Oct 12 during the promotional launch. Referral conversion volume surged 4x with legitimate, verified software checkout transactions. Historical customer refund rate is exceptionally low (3.1%).';
  }
  if (item.anomalyCodes.includes('VELOCITY_SPIKE')) {
    return `${item.recipientName} experienced a sudden promotional traffic surge across external media channels. Payout volume increased by >300% over the rolling 90-day baseline without prior campaign registration.`;
  }
  if (item.anomalyCodes.includes('HIGH_REFUND_RATE')) {
    return `${item.recipientName} has a 26% customer refund rate within the 14-day post-purchase window. Disproportionately high return volume indicates possible coupon scraping, deceptive marketing claims, or return clawback liability.`;
  }
  if (item.anomalyCodes.includes('RECENT_DESTINATION_CHANGE')) {
    return `${item.recipientName} updated their recipient PayPal destination email within the last 1-2 days before the payout batch generation. Mandatory security review window is active to prevent payout redirection fraud.`;
  }
  if (item.anomalyCodes.includes('DUPLICATE_DESTINATION')) {
    return `${item.recipientName} shares an identical PayPal payout address (shared-payout@creativestudio.io) with other distinct affiliate accounts. Indicates multi-account agency coordination or shared beneficiary management.`;
  }
  return 'Standard anomaly requiring contextual review.';
}

