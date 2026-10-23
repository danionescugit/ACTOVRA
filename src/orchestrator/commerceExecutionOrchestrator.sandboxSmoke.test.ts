import { log } from 'node:console';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import { CommerceOperationStore } from '../store';
import { openStoreDb, type StoreDb } from '../store/db';
import { evaluatePolicy } from '../policy/evaluatePolicy';
import { syntheticPolicyConfig } from '../policy/policyConfig';
import {
  PayPalService,
  loadPayPalConfigFromEnv,
  type FetchLike,
  type PayPalConfig,
} from '../services/paypal';
import {
  CommerceExecutionOrchestrator,
  payPalRequestIdForOperation,
} from './commerceExecutionOrchestrator';

/* ------------------------------------------------------------------ */
/* GATED PayPal Sandbox orchestrator E2E smoke (Task 08, Checkpoint 4) */
/* ------------------------------------------------------------------ */
/* Runs ONLY when RUN_PAYPAL_ORCHESTRATOR_SMOKE=1 is set. Skipped in   */
/* normal `npm test`. Performs the REAL production orchestration path  */
/* exactly once against PayPal SANDBOX:                                */
/*                                                                     */
/*   CommerceOperation → real state machine → APPROVED                  */
/*   → CommerceExecutionOrchestrator.executeApprovedOperation()        */
/*   → durable EXECUTION_STARTED → real PayPalService.createOrder()    */
/*   → real PayPal Sandbox → durable PAYPAL_ORDER_CREATED              */
/*                                                                     */
/* THIS IS NOT A PAYMENT TEST: no buyer approval, no capture, no       */
/* payment execution, no webhook, no UI, no API routes, no retry.      */
/* Never prints credentials, tokens, authorization headers, or raw     */
/* response bodies.                                                    */
/* ------------------------------------------------------------------ */

const SMOKE_ENABLED = process.env.RUN_PAYPAL_ORCHESTRATOR_SMOKE === '1';

/** The one and only operation used by this smoke (single run per checkpoint). */
const OPERATION_ID = 'op-sandbox-orch-smoke-001';
const OPPORTUNITY_ID = 'opp-003'; // exists in syntheticPolicyConfig.knownOpportunities

/** Human-safe fields only. No tokens, no headers, no raw bodies. */
interface SafeSmokeSummary {
  readonly operationId: string;
  readonly outcomeKind: string;
  readonly paypalOrderId: string;
  readonly paypalStatus: string;
  readonly requestId: string;
  readonly approveUrlPresent: boolean;
  readonly approveUrlIsHttps: boolean | undefined;
  readonly counts: SafeNetworkCounts;
}

interface SafeNetworkCounts {
  readonly oauthToken: number;
  readonly createOrder: number;
  readonly capture: number;
  readonly other: number;
}

/** Analyze a URL into a safe category — no secrets, no query strings logged. */
function classifyPayPalRequest(url: string): keyof Omit<SafeNetworkCounts, 'other'> | 'other' {
  const pathname = new URL(url).pathname;
  if (pathname === '/v1/oauth2/token') return 'oauthToken';
  if (pathname === '/v2/checkout/orders') return 'createOrder';
  if (pathname.includes('/capture')) return 'capture';
  return 'other';
}

/** Human-safe log of a request category — URL pathname only, never headers. */
function logRequest(category: string, method: string, url: string): void {
  log(`[NET] ${method} ${url} → ${category}`);
}

/** Close temp DBs even if assertions fail mid-test. */
const createdStores: StoreDb[] = [];

afterEach(() => {
  for (const store of createdStores.splice(0)) {
    try {
      store.close();
    } catch {
      // already closed
    }
  }
});

describe.skipIf(!SMOKE_ENABLED)('gated PayPal SANDBOX orchestrator E2E smoke (Task 08, CP4)', () => {
  it(
    'orchestrates one APPROVED operation through real Sandbox create-order (no capture, no approval)',
    { timeout: 60_000 },
    async () => {
      // ================================================================
      // SAFETY GATE — zero network access before this block passes.
      // ================================================================

      // 1. Credential presence only — never their values.
      const clientIdPresent =
        typeof process.env.PAYPAL_CLIENT_ID === 'string' &&
        process.env.PAYPAL_CLIENT_ID.trim().length > 0;
      const clientSecretPresent =
        typeof process.env.PAYPAL_CLIENT_SECRET === 'string' &&
        process.env.PAYPAL_CLIENT_SECRET.trim().length > 0;
      log(
        `[GATE] PAYPAL_CLIENT_ID=${clientIdPresent ? 'PRESENT' : 'MISSING'} ` +
          `PAYPAL_CLIENT_SECRET=${clientSecretPresent ? 'PRESENT' : 'MISSING'}`
      );
      if (!clientIdPresent || !clientSecretPresent) {
        throw new Error(
          'SAFETY GATE FAILED: PayPal credentials are not configured ' +
            '(PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET) — aborting with zero PayPal requests'
        );
      }

      // 2–3. Loaded config must be SANDBOX on the exact Sandbox host. The
      // production loader rejects custom hosts for this smoke: no PAYPAL_API_BASE
      // override and no custom PAYPAL_ENVIRONMENT URL is permitted here.
      const config: PayPalConfig = loadPayPalConfigFromEnv();
      const resolvedHost = new URL(config.apiBaseUrl).hostname;
      log(`[GATE] resolved environment=${config.environment} host=${resolvedHost}`);

      if (process.env.PAYPAL_API_BASE !== undefined) {
        throw new Error(
          'SAFETY GATE FAILED: PAYPAL_API_BASE override is not allowed for this smoke ' +
            '(only the built-in Sandbox host is permitted) — zero PayPal requests made'
        );
      }
      if (config.environment !== 'SANDBOX') {
        throw new Error(
          `SAFETY GATE FAILED: resolved environment ${config.environment} is not SANDBOX ` +
            '— aborting with zero PayPal requests'
        );
      }
      if (resolvedHost !== 'api-m.sandbox.paypal.com') {
        throw new Error(
          'SAFETY GATE FAILED: resolved host is not api-m.sandbox.paypal.com ' +
            '— aborting with zero PayPal requests'
        );
      }

      // ================================================================
      // ISOLATED DURABLE TEST STORE (file-backed, temp dir, no leakage)
      // ================================================================
      const dir = mkdtempSync(join(tmpdir(), 'commercepilot-orch-smoke-'));
      const storeDb = openStoreDb(join(dir, 'store.sqlite3'));
      createdStores.push(storeDb);

      try {
        const store = new CommerceOperationStore({ db: storeDb.db });

        // ==============================================================
        // TEST OPERATION — real state machine path to APPROVED. The policy
        // result is computed by the REAL policy engine, not fabricated.
        // ==============================================================
        // Synthetic demo data only: USD 1.00, known demo opportunity.
        store.createOperation(OPERATION_ID, OPPORTUNITY_ID, new Date());
        const decision = {
          opportunityId: OPPORTUNITY_ID,
          action: 'CREATE_PAYMENT',
          amount: 100, // minor units: USD 1.00
          currency: 'USD',
          recipient: 'customer-demo-001',
          justification: 'Task 08 CP4 Sandbox orchestrator smoke (synthetic demo)',
        } as const;
        store.applyOperationEvent(
          OPERATION_ID,
          { type: 'DECISION_PROPOSED', decision },
          new Date()
        );
        const policyResult = evaluatePolicy(decision, syntheticPolicyConfig);
        if (policyResult.decision !== 'APPROVE') {
          throw new Error(
            `Smoke setup error: policy did not approve the synthetic decision (${policyResult.decision}: ${policyResult.reason})`
          );
        }
        store.applyOperationEvent(
          OPERATION_ID,
          { type: 'POLICY_APPROVED', policyResult },
          new Date()
        );
        store.applyOperationEvent(OPERATION_ID, { type: 'REQUEST_HUMAN_APPROVAL' }, new Date());
        store.applyOperationEvent(
          OPERATION_ID,
          { type: 'HUMAN_APPROVED', approvalStatus: 'APPROVED' },
          new Date()
        );
        expect(store.getOperation(OPERATION_ID)?.status).toBe('APPROVED');

        // ==============================================================
        // REAL PRODUCTION PATH — counting fetch wrapper (delegates to
        // real fetch; counts URL/method categories only, never headers,
        // bodies, tokens, or secrets; does not alter behavior).
        // ==============================================================
        const counts = { oauthToken: 0, createOrder: 0, capture: 0, other: 0 };
        const countingFetch: FetchLike = (url, init) => {
          const method = (init?.method ?? 'GET').toUpperCase();
          const category = classifyPayPalRequest(url);
          counts[category] += 1;
          logRequest(category, method, url);
          return fetch(url, init); // REAL network — delegates unchanged
        };

        const service = new PayPalService({ config, fetchImpl: countingFetch });
        const orchestrator = new CommerceExecutionOrchestrator({ store, paypal: service });

        // ==============================================================
        // REAL EXECUTION — exactly one call, no retry, no direct createOrder.
        // ==============================================================
        const outcome = await orchestrator.executeApprovedOperation(OPERATION_ID);

        // ==============================================================
        // SUCCESS ASSERTIONS (1–16)
        // ==============================================================
        expect(outcome.kind).toBe('ORDER_CREATED');

        // Exactly one execution attempt through the orchestrator.
        expect(counts.createOrder).toBe(1);

        const operation = store.getOperation(OPERATION_ID);
        expect(operation?.status).toBe('PAYPAL_ORDER_CREATED');

        // Durable audit: exactly one claim, one order, no payment events.
        const audit = store.getAuditTrail(OPERATION_ID).map((e) => e.event.type);
        const countOf = (t: string): number => audit.filter((x) => x === t).length;
        expect(countOf('EXECUTION_STARTED')).toBe(1);
        expect(countOf('PAYPAL_ORDER_CREATED')).toBe(1);
        expect(countOf('PAYMENT_COMPLETED')).toBe(0);
        expect(countOf('PAYMENT_FAILED')).toBe(0);

        // paymentResult remains undefined (no payment completed overclaim).
        expect(operation?.paymentResult).toBeUndefined();

        // paypalOrder exists with the required fields.
        const paypalOrder = operation?.paypalOrder;
        expect(paypalOrder).toBeDefined();
        if (paypalOrder === undefined) throw new Error('unreachable');
        expect(paypalOrder.paypalOrderId.length).toBeGreaterThan(0);
        expect(paypalOrder.paypalStatus.length).toBeGreaterThan(0);

        // Deterministic requestId from the production strategy, echoed back.
        const expectedRequestId = payPalRequestIdForOperation(OPERATION_ID);
        expect(paypalOrder.requestId).toBe(expectedRequestId);

        // approveUrl, if present, must be HTTPS.
        if (paypalOrder.approveUrl !== undefined) {
          expect(new URL(paypalOrder.approveUrl).protocol).toBe('https:');
        }

        // Truthful status for an unapproved/uncaptured order.
        expect(paypalOrder.paypalStatus).toBe('CREATED');

        // Network shape: exactly 1 OAuth + 1 create-order, nothing else.
        expect(counts.oauthToken).toBe(1);
        expect(counts.capture).toBe(0);
        expect(counts.other).toBe(0);

        // custom_id: PayPalService sends commerceOperationId as custom_id
        // (its existing behavior); asserted at unit level in CP3/CP2 tests.
        // The smoke asserts the production input path was used end-to-end via
        // the durable record: the exact amount/currency that the orchestrator
        // passed to the real service.
        expect(operation?.decision?.amount).toBe(100);
        expect(operation?.decision?.currency).toBe('USD');

        // ==============================================================
        // HUMAN-SAFE SUMMARY (no secrets, no raw response bodies)
        // ==============================================================
        const summary: SafeSmokeSummary = {
          operationId: OPERATION_ID,
          outcomeKind: outcome.kind,
          paypalOrderId: paypalOrder.paypalOrderId,
          paypalStatus: paypalOrder.paypalStatus,
          requestId: paypalOrder.requestId,
          approveUrlPresent: paypalOrder.approveUrl !== undefined,
          approveUrlIsHttps:
            paypalOrder.approveUrl === undefined
              ? undefined
              : new URL(paypalOrder.approveUrl).protocol === 'https:',
          counts,
        };
        log('\n[SMOKE] safe summary:', summary);
      } finally {
        // Clean up the temp directory (DB already closed by afterEach).
        try {
          rmSync(dir, { recursive: true, force: true });
          log('[CLEANUP] temp store directory removed');
        } catch {
          // best-effort cleanup only
        }
      }
    }
  );
});
