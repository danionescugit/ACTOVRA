import { log } from 'node:console';
import { describe, expect, it } from 'vitest';
import {
  PayPalHttpApiError,
  PayPalService,
  loadPayPalConfigFromEnv,
  type FetchLike,
} from './index';
import { PAYPAL_API_BASE_URLS } from './config';

/* ------------------------------------------------------------------ */
/* GATED PayPal Sandbox buyer-approval DIAGNOSTIC (Task 09, CP5A-diag) */
/* Runs ONLY when RUN_PAYPAL_CP5A_GET_ORDER_DIAG=1 is set. Skipped in  */
/* normal `npm test` (network-free). Performs exactly ONE OAuth        */
/* request and exactly ONE GET /v2/checkout/orders/{id} request        */
/* against PayPal SANDBOX via the production PayPalService.getOrder(). */
/*                                                                     */
/* READ-ONLY DIAGNOSTIC of the existing Sandbox order:                 */
/*   29G94348NH454964S (USD 1.00, CREATED, approval attempted          */
/*   manually by a human; Sandbox showed "Things don't appear to be    */
/*   working at the moment." — buyer approval DID NOT occur).          */
/*                                                                     */
/* NEVER calls createOrder, captureOrder, or any orchestrator;         */
/* never retries, never polls, never opens a browser, never mutates    */
/* CommerceOperation state, never writes PAYMENT_COMPLETED, never      */
/* creates a new order, never touches production PayPal.               */
/* Never prints credentials, tokens, authorization headers, .env, or   */
/* raw response bodies. Only normalized, non-secret fields are logged. */
/* ------------------------------------------------------------------ */

const DIAG_ENABLED = process.env.RUN_PAYPAL_CP5A_GET_ORDER_DIAG === '1';

/** The EXISTING order under diagnosis. Never replaced, never recreated. */
const EXISTING_SANDBOX_ORDER_ID = '29G94348NH454964S';

const SANDBOX_HOST = 'api-m.sandbox.paypal.com';
const PRODUCTION_HOST = new URL(PAYPAL_API_BASE_URLS.LIVE).hostname;

/** Non-secret network ledger: counts by host/path only. No headers, no bodies. */
class PayPalNetworkLedger {
  oauthTokenRequests = 0;
  getOrderRequests = 0;
  createOrderRequests = 0;
  captureRequests = 0;
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
      } else if (
        url.pathname === `/v2/checkout/orders/${EXISTING_SANDBOX_ORDER_ID}`
      ) {
        ledger.getOrderRequests += 1;
      } else if (
        url.pathname ===
        `/v2/checkout/orders/${EXISTING_SANDBOX_ORDER_ID}/capture`
      ) {
        ledger.captureRequests += 1;
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
interface SafeDiagSummary {
  readonly paypalOrderId: string;
  readonly orderStatus: string;
  readonly environment: string;
  readonly captureCount: number;
  readonly networkRequests: {
    readonly oauthToken: number;
    readonly getOrder: number;
    readonly createOrder: number;
    readonly capture: number;
    readonly total: number;
    readonly productionHost: number;
    readonly nonSandboxHost: number;
    readonly forbiddenPath: number;
  };
  readonly httpError?: {
    readonly status?: number;
    readonly paypalErrorName?: string;
    readonly paypalErrorMessage?: string;
  };
}

describe.skipIf(!DIAG_ENABLED)(
  'gated PayPal SANDBOX CP5A get-order diagnostic (Task 09, READ-ONLY)',
  () => {
    it(
      'reads the EXISTING Sandbox order exactly ONCE (no create, no capture, no retry)',
      { timeout: 30_000 },
      async () => {
        // ---- SAFETY PREFLIGHT (zero network access before this passes) ---
        const config = loadPayPalConfigFromEnv(); // throws if credentials missing

        if (
          typeof process.env.PAYPAL_CLIENT_ID !== 'string' ||
          process.env.PAYPAL_CLIENT_ID.trim().length === 0 ||
          typeof process.env.PAYPAL_CLIENT_SECRET !== 'string' ||
          process.env.PAYPAL_CLIENT_SECRET.trim().length === 0
        ) {
          throw new Error(
            'SAFETY PREFLIGHT FAILED: PayPal credential variables absent — aborting with zero PayPal requests'
          );
        }
        if (config.environment !== 'SANDBOX') {
          throw new Error(
            `SAFETY PREFLIGHT FAILED: resolved environment ${config.environment} is not SANDBOX — aborting with zero PayPal requests`
          );
        }
        if (config.apiBaseUrl !== PAYPAL_API_BASE_URLS.SANDBOX) {
          throw new Error(
            `SAFETY PREFLIGHT FAILED: resolved base ${config.apiBaseUrl} is not exactly ${PAYPAL_API_BASE_URLS.SANDBOX} — aborting with zero PayPal requests`
          );
        }
        if (
          typeof process.env.PAYPAL_API_BASE === 'string' &&
          process.env.PAYPAL_API_BASE.trim().length > 0
        ) {
          throw new Error(
            'SAFETY PREFLIGHT FAILED: PAYPAL_API_BASE override present (redirect risk) — aborting with zero PayPal requests'
          );
        }
        const resolvedHost = new URL(config.apiBaseUrl).hostname;
        if (resolvedHost !== SANDBOX_HOST) {
          throw new Error(
            `SAFETY PREFLIGHT FAILED: resolved host ${resolvedHost} is not ${SANDBOX_HOST} — aborting with zero PayPal requests`
          );
        }
        if (resolvedHost === PRODUCTION_HOST) {
          throw new Error(
            'SAFETY PREFLIGHT FAILED: resolved host is the production PayPal host — aborting with zero PayPal requests'
          );
        }

        // Non-secret preflight facts only (environment name + hostname).
        log(
          `[PREFLIGHT] resolved environment=${config.environment} host=${resolvedHost}`
        );

        // ---- SINGLE READ-ONLY PROVIDER CALL (production PayPalService) ---
        // Exactly ONE OAuth request + ONE GET order request. No retry, no
        // polling, no create, no capture. The counting transport proves the
        // exact request counts.
        const ledger = new PayPalNetworkLedger();
        const service = new PayPalService({
          config,
          fetchImpl: makeCountingFetch(ledger),
        });

        // Sanitized, secret-free error fields only — intentionally NOT the
        // full PayPalHttpApiError type (no headers/token/class instance kept).
        let diagError:
          | {
              status?: number;
              paypalErrorName?: string;
              paypalErrorMessage?: string;
            }
          | undefined;
        let summary: SafeDiagSummary | undefined;

        try {
          const result = await service.getOrder({
            paypalOrderId: EXISTING_SANDBOX_ORDER_ID,
          });

          summary = {
            paypalOrderId: result.paypalOrderId,
            orderStatus: result.orderStatus,
            environment: config.environment,
            captureCount: result.captures.length,
            networkRequests: {
              oauthToken: ledger.oauthTokenRequests,
              getOrder: ledger.getOrderRequests,
              createOrder: ledger.createOrderRequests,
              capture: ledger.captureRequests,
              total: ledger.totalRequests,
              productionHost: ledger.productionHostRequests,
              nonSandboxHost: ledger.nonSandboxHostRequests,
              forbiddenPath: ledger.forbiddenPathRequests,
            },
          };
        } catch (error) {
          if (error instanceof PayPalHttpApiError) {
            // Sanitized, secret-free error fields only (name/message/debug-ID
            // class data is carried by the typed error; no headers, no token).
            diagError = {
              status: error.status,
              paypalErrorName: error.paypalErrorName,
              paypalErrorMessage: error.paypalErrorMessage,
            };
          } else {
            throw error;
          }
        }

        // ---- NETWORK LEDGER ASSERTIONS (hard invariants) -----------------
        expect(ledger.totalRequests).toBe(2); // 1 OAuth + 1 GET order
        expect(ledger.oauthTokenRequests).toBe(1);
        expect(ledger.getOrderRequests).toBe(1);
        expect(ledger.createOrderRequests).toBe(0); // MUST be zero
        expect(ledger.captureRequests).toBe(0); // MUST be zero
        expect(ledger.productionHostRequests).toBe(0); // MUST be zero
        expect(ledger.nonSandboxHostRequests).toBe(0);
        expect(ledger.forbiddenPathRequests).toBe(0);

        // ---- Human-safe summary (no secrets, no raw response) ------------
        if (summary !== undefined) {
          log('[DIAG] read-only get-order succeeded. Safe summary:', summary);
        } else {
          log(
            '[DIAG] read-only get-order FAILED. Sanitized error (no secrets):',
            {
              status: diagError?.status,
              paypalErrorName: diagError?.paypalErrorName,
              paypalErrorMessage: diagError?.paypalErrorMessage,
              networkRequests: {
                oauthToken: ledger.oauthTokenRequests,
                getOrder: ledger.getOrderRequests,
                createOrder: ledger.createOrderRequests,
                capture: ledger.captureRequests,
                total: ledger.totalRequests,
                productionHost: ledger.productionHostRequests,
                nonSandboxHost: ledger.nonSandboxHostRequests,
                forbiddenPath: ledger.forbiddenPathRequests,
              },
            }
          );
        }
      }
    );
  }
);
