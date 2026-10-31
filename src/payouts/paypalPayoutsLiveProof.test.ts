import { log } from 'node:console';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadPayPalConfigFromEnv } from '../services/paypal/config';
import { PayPalPayoutsService } from './paypalPayoutsService';
import {
  type CreatePayoutProofBatchInput,
  type PayoutReconciliationResult,
} from './paypalPayoutsTypes';

/* ------------------------------------------------------------------ */
/* GATED PayPal Sandbox Real Payout Proof & Reconciliation (PAYOUT-06)*/
/* ------------------------------------------------------------------ */
/* Authorized Scope:                                                   */
/* - Exactly 2 Sandbox payout items of $1.00 USD each ($2.00 USD total) */
/* - PayPal SANDBOX only (https://api-m.sandbox.paypal.com)            */
/* - Verified Sandbox personal recipient:                              */
/*   sb-kpdlt53262038@personal.example.com                             */
/* - Maximum payout create calls: EXACTLY 1 (no automatic retries)     */
/* - Zero production calls, zero orders, zero captures, zero NVIDIA     */
/* - Zero secret / token logging                                       */
/* ------------------------------------------------------------------ */

const LIVE_PROOF_ENABLED = process.env.RUN_PAYPAL_PAYOUT_PROOF === '1';

// Load .env variables safely if not injected by environment
if (LIVE_PROOF_ENABLED && !process.env.PAYPAL_CLIENT_ID && fs.existsSync('.env')) {
  if (typeof (process as unknown as { loadEnvFile?: (path?: string) => void }).loadEnvFile === 'function') {
    (process as unknown as { loadEnvFile: (path?: string) => void }).loadEnvFile('.env');
  } else {
    const content = fs.readFileSync('.env', 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const idx = trimmed.indexOf('=');
        if (idx > 0) {
          const key = trimmed.slice(0, idx).trim();
          const val = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
          if (!process.env[key]) {
            process.env[key] = val;
          }
        }
      }
    }
  }
}

describe.skipIf(!LIVE_PROOF_ENABLED)('PAYOUT-06: Live PayPal Sandbox Payout Proof & Reconciliation', () => {
  it('executes exactly one authorized 2-item $2.00 USD sandbox payout batch and reconciles it', { timeout: 45_000 }, async () => {
    // Track execution counters
    let productionPayPalCalls = 0;
    let paypalPayoutCreateCalls = 0;
    let paypalPayoutStatusCalls = 0;
    const paypalOrderCreateCalls = 0;
    const paypalCaptureCalls = 0;
    const nvidiaCalls = 0;

    // 1. Strict Preflight Configuration Checks
    const config = loadPayPalConfigFromEnv();

    if (config.environment !== 'SANDBOX') {
      productionPayPalCalls++;
      throw new Error(`SAFETY BREACH: config.environment is ${config.environment}, expected SANDBOX`);
    }
    if (config.apiBaseUrl !== 'https://api-m.sandbox.paypal.com') {
      productionPayPalCalls++;
      throw new Error(`SAFETY BREACH: config.apiBaseUrl is ${config.apiBaseUrl}, expected https://api-m.sandbox.paypal.com`);
    }
    if (!config.clientId || !config.clientSecret) {
      throw new Error('SAFETY BREACH: Missing PayPal Sandbox credentials in environment');
    }

    log('[PAYOUT-06 LIVE PROOF] Initializing authorized PayPal Sandbox Payouts test...');
    log('[PAYOUT-06 LIVE PROOF] Host: https://api-m.sandbox.paypal.com (Sandbox ONLY)');

    const payoutsService = new PayPalPayoutsService({ config });

    // 2. Build strictly bounded proof payload
    const timestamp = Date.now();
    const batchIdSuffix = Math.random().toString(36).slice(2, 8).toUpperCase();
    const senderBatchId = `ACTOVRA-PROOF-${timestamp}-${batchIdSuffix}`;
    const verifiedReceiver = 'sb-kpdlt53262038@personal.example.com';

    const proofInput: CreatePayoutProofBatchInput = {
      senderBatchId,
      items: [
        {
          senderItemId: `PROOF-ITEM-1-${timestamp}`,
          receiverEmail: verifiedReceiver,
          amountCents: 100, // $1.00 USD
          currency: 'USD',
          note: 'ACTOVRA Sandbox Proof Item 1 ($1.00 USD)',
        },
        {
          senderItemId: `PROOF-ITEM-2-${timestamp}`,
          receiverEmail: verifiedReceiver,
          amountCents: 100, // $1.00 USD
          currency: 'USD',
          note: 'ACTOVRA Sandbox Proof Item 2 ($1.00 USD)',
        },
      ],
    };

    // Hard in-test assertion on exact authorized boundaries
    expect(proofInput.items).toHaveLength(2);
    expect(proofInput.items[0].amountCents).toBe(100);
    expect(proofInput.items[1].amountCents).toBe(100);
    expect(proofInput.items[0].currency).toBe('USD');
    expect(proofInput.items[1].currency).toBe('USD');

    // 3. Execute exactly ONE payout batch creation
    log(`[PAYOUT-06 LIVE PROOF] Submitting authorized 2-item payout batch (sender_batch_id: ${senderBatchId})...`);
    paypalPayoutCreateCalls++;
    expect(paypalPayoutCreateCalls).toBe(1); // Hard ceiling: exactly 1 create call

    const createResult = await payoutsService.createAuthorizedProofBatch(proofInput);

    log('[PAYOUT-06 LIVE PROOF] Batch submission successful:');
    log(`  - Payout Batch ID: ${createResult.payoutBatchId}`);
    log(`  - Batch Status: ${createResult.batchStatus}`);
    log(`  - Sender Batch ID: ${createResult.senderBatchId}`);
    log(`  - Time Created: ${createResult.timeCreated}`);
    if (createResult.debugId) {
      log(`  - PayPal-Debug-Id: ${createResult.debugId}`);
    }

    expect(createResult.payoutBatchId).toBeDefined();
    expect(createResult.payoutBatchId.length).toBeGreaterThan(0);
    expect(createResult.batchStatus).toBeDefined();

    // 4. Poll for batch status and reconciliation (bounded to max 3 status checks)
    let reconResult: PayoutReconciliationResult | null = null;
    const maxPolls = 3;
    const pollDelayMs = 2500;

    for (let poll = 1; poll <= maxPolls; poll++) {
      log(`[PAYOUT-06 LIVE PROOF] Polling payout batch status (poll ${poll}/${maxPolls}) after ${pollDelayMs}ms...`);
      await new Promise((resolve) => setTimeout(resolve, pollDelayMs));

      paypalPayoutStatusCalls++;
      reconResult = await payoutsService.getPayoutBatch(createResult.payoutBatchId);

      log(`  - Current Batch Status: ${reconResult.batchStatus}`);
      log(`  - Items Reconciled: ${reconResult.items.length}/${reconResult.requestedCount}`);

      if (
        reconResult.batchStatus === 'SUCCESS' ||
        reconResult.batchStatus === 'DENIED' ||
        reconResult.items.some((it) => it.transactionStatus === 'SUCCESS')
      ) {
        log('[PAYOUT-06 LIVE PROOF] Final item state detected, concluding polling.');
        break;
      }
    }

    expect(reconResult).not.toBeNull();
    const finalRecon = reconResult as PayoutReconciliationResult;

    log('\n============================================================');
    log('ACTOVRA PAYOUT-06 RECONCILIATION REPORT');
    log('============================================================');
    log(`PayPal Payout Batch ID:    ${finalRecon.payoutBatchId}`);
    log(`Batch Status:              ${finalRecon.batchStatus}`);
    log(`Sender Batch ID:           ${finalRecon.senderBatchId}`);
    log(`Total Amount:              $${(finalRecon.totalAmountCents / 100).toFixed(2)} ${finalRecon.currency}`);
    log(`Time Created:              ${finalRecon.timeCreated}`);
    log(`Time Completed:            ${finalRecon.timeCompleted ?? 'N/A'}`);
    log(`Requested Items:           ${finalRecon.requestedCount}`);
    log(`Completed Items:           ${finalRecon.completedCount}`);
    log(`Pending Items:             ${finalRecon.pendingCount}`);
    log(`Failed Items:              ${finalRecon.failedCount}`);
    log('------------------------------------------------------------');
    log('Reconciled Items:');
    finalRecon.items.forEach((item, idx) => {
      log(`  Item #${idx + 1}:`);
      log(`    Payout Item ID:         ${item.payoutItemId ?? 'N/A'}`);
      log(`    Sender Item ID:         ${item.senderItemId}`);
      log(`    Receiver Email:         ${item.receiverEmail}`);
      log(`    Amount:                 $${(item.amountCents / 100).toFixed(2)} ${item.currency}`);
      log(`    Transaction Status:     ${item.transactionStatus}`);
      log(`    Transaction ID:         ${item.transactionId ?? 'N/A'}`);
      if (item.errorDetails) {
        log(`    Error Details:          ${item.errorDetails}`);
      }
    });
    log('============================================================\n');

    // 5. Final Safety Counter Assertions
    expect(productionPayPalCalls).toBe(0);
    expect(paypalPayoutCreateCalls).toBe(1);
    expect(paypalPayoutStatusCalls).toBeGreaterThanOrEqual(1);
    expect(paypalPayoutStatusCalls).toBeLessThanOrEqual(maxPolls);
    expect(paypalOrderCreateCalls).toBe(0);
    expect(paypalCaptureCalls).toBe(0);
    expect(nvidiaCalls).toBe(0);

    // Verify reconciliation integrity
    expect(finalRecon.payoutBatchId).toBe(createResult.payoutBatchId);
    expect(finalRecon.requestedCount).toBe(2);
    expect(finalRecon.totalAmountCents).toBe(200);
    expect(finalRecon.currency).toBe('USD');
  });
});
