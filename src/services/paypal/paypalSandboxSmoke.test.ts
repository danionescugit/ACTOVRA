import { log } from 'node:console';
import { describe, expect, it } from 'vitest';
import { PayPalService, loadPayPalConfigFromEnv } from './index';

/* ------------------------------------------------------------------ */
/* GATED PayPal Sandbox smoke (Task 07, Checkpoint 2)                  */
/* ------------------------------------------------------------------ */
/* Runs ONLY when RUN_PAYPAL_SMOKE=1 is set. Skipped in normal         */
/* `npm test`. Performs exactly ONE OAuth request and ONE create-order */
/* request against PayPal SANDBOX via the production PayPalService.    */
/* No capture, no approval, no execution, no retry, no webhooks.       */
/* Never prints credentials, tokens, or authorization headers.         */
/* ------------------------------------------------------------------ */

const SMOKE_ENABLED = process.env.RUN_PAYPAL_SMOKE === '1';

/** Non-secret, human-safe fields only. No token, no headers, no raw body. */
interface SafeSmokeSummary {
  readonly paypalOrderId: string;
  readonly status: string;
  readonly environment: string;
  readonly requestId: string;
  readonly approveUrlIsHttps: boolean | undefined;
}

describe.skipIf(!SMOKE_ENABLED)('gated PayPal SANDBOX smoke (Task 07, CP2)', () => {
  it(
    'performs exactly one OAuth + one create-order against api-m.sandbox.paypal.com',
    { timeout: 30_000 },
    async () => {
      // ---- SAFETY GATE (zero network access before this passes) ----------
      const config = loadPayPalConfigFromEnv(); // throws if credentials missing
      const resolvedHost = new URL(config.apiBaseUrl).hostname;

      // Non-secret gate facts only (environment name + hostname).
      log(
        `[GATE] resolved environment=${config.environment} host=${resolvedHost}`
      );

      if (config.environment !== 'SANDBOX') {
        throw new Error(
          `SAFETY GATE FAILED: resolved environment ${config.environment} is not SANDBOX — aborting with zero PayPal requests`
        );
      }
      if (resolvedHost !== 'api-m.sandbox.paypal.com') {
        throw new Error(
          'SAFETY GATE FAILED: resolved host is not api-m.sandbox.paypal.com — aborting with zero PayPal requests'
        );
      }

      // ---- LIVE SANDBOX CALLS (production PayPalService, no retry) --------
      const service = new PayPalService({ config });
      const result = await service.createOrder({
        amountMinorUnits: 100,
        currency: 'USD',
        commerceOperationId: 'sandbox-smoke-001',
        requestId: 'commercepilot-sandbox-smoke-001',
      });

      // ---- SAFE ASSERTIONS (normalized result only, no raw response) -----
      expect(result.paypalOrderId.length).toBeGreaterThan(0);
      expect(result.environment).toBe('SANDBOX');
      expect(result.status.length).toBeGreaterThan(0);
      expect(result.requestId).toBe('commercepilot-sandbox-smoke-001');
      if (result.approveUrl !== undefined) {
        expect(new URL(result.approveUrl).protocol).toBe('https:');
      }

      // ---- Human-safe summary (no secrets, no raw response) --------------
      const summary: SafeSmokeSummary = {
        paypalOrderId: result.paypalOrderId,
        status: result.status,
        environment: result.environment,
        requestId: result.requestId,
        approveUrlIsHttps:
          result.approveUrl === undefined
            ? undefined
            : new URL(result.approveUrl).protocol === 'https:',
      };
      log('\n[SMOKE] safe summary:', summary);
    }
  );
});
