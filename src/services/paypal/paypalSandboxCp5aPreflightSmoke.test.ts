import { log } from 'node:console';
import { describe, expect, it } from 'vitest';
import { PayPalService, loadPayPalConfigFromEnv, type FetchLike } from './index';
import { PAYPAL_API_BASE_URLS } from './config';

/* ------------------------------------------------------------------ */
/* GATED PayPal Sandbox buyer-approval PREFLIGHT smoke (Task 09, CP5A) */
/* Runs ONLY when RUN_PAYPAL_CP5A_SMOKE=1 is set. Skipped in normal    */
/* `npm test`. Performs exactly ONE OAuth request and ONE create-order */
/* request against PayPal SANDBOX via the production PayPalService.    */
/*                                                                     */
/* THIS IS A STOP-GATE CHECKPOINT: it prepares ONE fresh Sandbox order */
/* in CREATED state so a HUMAN can perform buyer approval manually in  */
/* a separate step (CP5B). It never automates approval, never opens    */
/* the approve URL, never polls the order, never persists payment      */
/* state, and never makes any money-moving call of any kind.           */
/* Never prints credentials, tokens, authorization headers, or raw     */
/* response bodies.                                                    */
/* ------------------------------------------------------------------ */

const CP5A_SMOKE_ENABLED = process.env.RUN_PAYPAL_CP5A_SMOKE === '1';

/** Deterministic, unique-to-this-checkpoint idempotency ID. */
const CP5A_REQUEST_ID = 'commercepilot-cp5a-sandbox-preflight-001';
const CP5A_COMMERCE_OPERATION_ID = 'cp5a-sandbox-preflight-001';

const SANDBOX_HOST = 'api-m.sandbox.paypal.com';
const PRODUCTION_HOST = new URL(PAYPAL_API_BASE_URLS.LIVE).hostname;

/** Non-secret network ledger: counts by host/path only. No headers, no bodies. */
class PayPalNetworkLedger {
  oauthTokenRequests = 0;
  createOrderRequests = 0;
  productionHostRequests = 0;
  nonSandboxHostRequests = 0;
  forbiddenPathRequests = 0;
  totalRequests = 0;
}

/**
 * Transparent counting transport. Records host/path counts only — never
 * headers, tokens, or bodies — then delegates to the real fetch.
 */
function makeCountingFetch(ledger: PayPalNetworkLedger): FetchLike {
  return (input, init) => {
    const url = new URL(input);
    ledger.totalRequests += 1;
    if (url.hostname === SANDBOX_HOST) {
      if (url.pathname === '/v1/oauth2/token') {
        ledger.oauthTokenRequests += 1;
      } else if (url.pathname === '/v2/checkout/orders') {
        ledger.createOrderRequests += 1;
      } else {
        ledger.forbiddenPathRequests += 1;
      }
    } else {
      ledger.nonSandboxHostRequests += 1;
      if (url.hostname === PRODUCTION_HOST) {
        ledger.productionHostRequests += 1;
      }
    }
    return fetch(input, init);
  };
}

/** Human-safe, non-secret fields only. */
interface SafeCp5aSummary {
  readonly paypalOrderId: string;
  readonly orderStatus: string;
  readonly environment: string;
  readonly requestId: string;
  readonly approveUrl: string;
  readonly networkRequests: {
    readonly oauthToken: number;
    readonly createOrder: number;
    readonly total: number;
    readonly moneyMoving: number;
    readonly productionHost: number;
    readonly nonSandboxHost: number;
    readonly forbiddenPath: number;
  };
}

describe.skipIf(!CP5A_SMOKE_ENABLED)(
  'gated PayPal SANDBOX CP5A preflight smoke (Task 09, CP5A)',
  () => {
    it(
      'creates exactly ONE SANDBOX order for manual buyer approval, then STOPS',
      { timeout: 30_000 },
      async () => {
        // ---- SAFETY GATE (zero network access before this passes) --------
        const config = loadPayPalConfigFromEnv(); // throws if credentials missing

        if (
          typeof process.env.PAYPAL_CLIENT_ID !== 'string' ||
          process.env.PAYPAL_CLIENT_ID.trim().length === 0 ||
          typeof process.env.PAYPAL_CLIENT_SECRET !== 'string' ||
          process.env.PAYPAL_CLIENT_SECRET.trim().length === 0
        ) {
          throw new Error(
            'SAFETY GATE FAILED: PayPal credential variables absent — aborting with zero PayPal requests'
          );
        }
        if (config.environment !== 'SANDBOX') {
          throw new Error(
            `SAFETY GATE FAILED: resolved environment ${config.environment} is not SANDBOX — aborting with zero PayPal requests`
          );
        }
        if (config.apiBaseUrl !== PAYPAL_API_BASE_URLS.SANDBOX) {
          throw new Error(
            `SAFETY GATE FAILED: resolved base ${config.apiBaseUrl} is not exactly ${PAYPAL_API_BASE_URLS.SANDBOX} — aborting with zero PayPal requests`
          );
        }
        if (
          typeof process.env.PAYPAL_API_BASE === 'string' &&
          process.env.PAYPAL_API_BASE.trim().length > 0
        ) {
          throw new Error(
            'SAFETY GATE FAILED: PAYPAL_API_BASE override present (redirect risk) — aborting with zero PayPal requests'
          );
        }
        const resolvedHost = new URL(config.apiBaseUrl).hostname;
        if (resolvedHost !== SANDBOX_HOST) {
          throw new Error(
            `SAFETY GATE FAILED: resolved host ${resolvedHost} is not ${SANDBOX_HOST} — aborting with zero PayPal requests`
          );
        }
        if (resolvedHost === PRODUCTION_HOST) {
          throw new Error(
            'SAFETY GATE FAILED: resolved host is the production PayPal host — aborting with zero PayPal requests'
          );
        }

        // Non-secret gate facts only (environment name + hostname).
        log(
          `[GATE] resolved environment=${config.environment} host=${resolvedHost}`
        );

        // ---- LIVE SANDBOX CALLS (production PayPalService, no retry) -----
        // Exactly ONE create-order attempt: the production service performs
        // one OAuth request and one create-order request, with no automatic
        // retry. The counting transport proves the exact request counts.
        const ledger = new PayPalNetworkLedger();
        const service = new PayPalService({
          config,
          fetchImpl: makeCountingFetch(ledger),
        });
        const result = await service.createOrder({
          amountMinorUnits: 100, // USD 1.00
          currency: 'USD',
          commerceOperationId: CP5A_COMMERCE_OPERATION_ID,
          requestId: CP5A_REQUEST_ID,
        });

        // ---- SAFE ASSERTIONS (normalized result only, no raw response) ---
        expect(result.paypalOrderId.length).toBeGreaterThan(0);
        expect(result.status).toBe('CREATED');
        expect(result.environment).toBe('SANDBOX');
        expect(result.requestId).toBe(CP5A_REQUEST_ID);
        expect(result.approveUrl).toBeDefined();
        expect(new URL(result.approveUrl as string).protocol).toBe('https:');
        expect(new URL(result.approveUrl as string).hostname).toBe('www.sandbox.paypal.com');

        // ---- NETWORK LEDGER ASSERTIONS ------------------------------------
        expect(ledger.oauthTokenRequests).toBe(1);
        expect(ledger.createOrderRequests).toBe(1);
        expect(ledger.totalRequests).toBe(2);
        expect(ledger.productionHostRequests).toBe(0);
        expect(ledger.nonSandboxHostRequests).toBe(0);
        expect(ledger.forbiddenPathRequests).toBe(0);

        // ---- Human-safe summary (no secrets, no raw response) -------------
        const summary: SafeCp5aSummary = {
          paypalOrderId: result.paypalOrderId,
          orderStatus: result.status,
          environment: result.environment,
          requestId: result.requestId,
          approveUrl: result.approveUrl as string,
          networkRequests: {
            oauthToken: ledger.oauthTokenRequests,
            createOrder: ledger.createOrderRequests,
            total: ledger.totalRequests,
            moneyMoving: 0,
            productionHost: ledger.productionHostRequests,
            nonSandboxHost: ledger.nonSandboxHostRequests,
            forbiddenPath: ledger.forbiddenPathRequests,
          },
        };
        log('\n[CP5A] STOP GATE REACHED — order CREATED; manual Sandbox buyer approval is now required (CP5B).');
        log('[CP5A] safe summary:', summary);
      }
    );
  }
);
