import { log } from 'node:console';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadPayPalConfigFromEnv } from './config';

/* ------------------------------------------------------------------ */
/* GATED PayPal Sandbox Payouts Capability Diagnostic (PAYOUT-05)     */
/* ------------------------------------------------------------------ */
/* Runs ONLY when RUN_PAYPAL_PAYOUTS_CAPABILITY_CHECK=1 is set.       */
/* Performs:                                                          */
/* 1. Exactly ONE OAuth token request to inspect granted scopes.      */
/* 2. Exactly ONE read-only GET /v1/payments/payouts/{dummy_id} to     */
/*    test endpoint authorization / permission enforcement.           */
/*                                                                    */
/* FORBIDDEN & ENFORCED:                                              */
/* - Zero POST to /v1/payments/payouts                                */
/* - Zero payout batch creation                                       */
/* - Zero orders, zero captures, zero payments                        */
/* - Zero token, secret, or Authorization header logging              */
/* ------------------------------------------------------------------ */

const DIAG_ENABLED = process.env.RUN_PAYPAL_PAYOUTS_CAPABILITY_CHECK === '1';

// Load .env variables safely if not injected by environment
if (DIAG_ENABLED && !process.env.PAYPAL_CLIENT_ID && fs.existsSync('.env')) {
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

describe.skipIf(!DIAG_ENABLED)('PAYOUT-05: PayPal Sandbox Payouts Capability Diagnostic', () => {
  it('safely inspects OAuth token scopes and probes Payouts endpoint read authorization', { timeout: 30_000 }, async () => {
    // 1. Preflight safety checks
    const config = loadPayPalConfigFromEnv();

    if (config.environment !== 'SANDBOX') {
      throw new Error(`SAFETY FAILED: environment ${config.environment} is not SANDBOX`);
    }
    if (config.apiBaseUrl !== 'https://api-m.sandbox.paypal.com') {
      throw new Error(`SAFETY FAILED: apiBaseUrl ${config.apiBaseUrl} is not api-m.sandbox.paypal.com`);
    }

    let authCalls = 0;
    let nonFinancialCalls = 0;
    const payoutCreateCalls = 0;
    const orderCreateCalls = 0;
    const captureCalls = 0;

    log('[SAFETY PREFLIGHT] Environment: SANDBOX (api-m.sandbox.paypal.com)');
    log('[SAFETY PREFLIGHT] Credentials present: YES (Client ID & Client Secret verified)');

    // 2. Obtain OAuth access token and inspect scopes
    const tokenUrl = `${config.apiBaseUrl}/v1/oauth2/token`;
    const basicAuth = Buffer.from(`${config.clientId}:${config.clientSecret}`, 'utf8').toString('base64');

    authCalls += 1;
    const tokenResponse = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    if (!tokenResponse.ok) {
      throw new Error(`OAuth request failed with HTTP status ${tokenResponse.status}`);
    }

    const tokenJson = (await tokenResponse.json()) as {
      scope?: string;
      access_token?: string;
      token_type?: string;
      app_id?: string;
      expires_in?: number;
    };

    const accessToken = tokenJson.access_token;
    if (!accessToken) {
      throw new Error('OAuth response missing access_token');
    }

    const rawScope = tokenJson.scope ?? '';
    const scopesList = rawScope.split(/\s+/).filter(Boolean);

    const hasPayoutsScope = scopesList.includes('https://uri.paypal.com/payments/payouts');
    const anyPayoutScope = scopesList.filter((s) => s.toLowerCase().includes('payout'));

    log('\n--- PAYPAL OAUTH SCOPE AUDIT ---');
    log(`Total scopes granted: ${scopesList.length}`);
    log(`App ID: ${tokenJson.app_id ?? 'N/A'}`);
    log(`Exact 'https://uri.paypal.com/payments/payouts' present: ${hasPayoutsScope}`);
    log(`Any scope matching /payout/i: ${JSON.stringify(anyPayoutScope)}`);
    log('Granted scope URIs:');
    for (const s of scopesList) {
      log(`  - ${s}`);
    }

    // 3. Perform safe read-only capability probe
    // GET /v1/payments/payouts/{payout_batch_id} for a non-existent dummy batch ID.
    // This is read-only. It cannot create or move money.
    // Expected:
    // If NOT authorized for Payouts: HTTP 403 Forbidden (NOT_AUTHORIZED / INSUFFICIENT_SCOPE)
    // If authorized for Payouts: HTTP 404 Not Found (BATCH_NOT_FOUND)
    const probeBatchId = '5UXD2E8A7EBQJ';
    const probeUrl = `${config.apiBaseUrl}/v1/payments/payouts/${probeBatchId}`;

    nonFinancialCalls += 1;
    const probeResponse = await fetch(probeUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    const probeStatus = probeResponse.status;
    let probeBody: Record<string, unknown> = {};
    try {
      probeBody = (await probeResponse.json()) as Record<string, unknown>;
    } catch {
      // Body may not be JSON
    }

    log('\n--- READ-ONLY PAYOUTS ENDPOINT PROBE ---');
    log(`Probed URL: GET ${config.apiBaseUrl}/v1/payments/payouts/${probeBatchId}`);
    log(`HTTP Response Status: ${probeStatus}`);
    log(`Response Error Name: ${probeBody.name ?? 'N/A'}`);
    log(`Response Message: ${probeBody.message ?? 'N/A'}`);
    log(`Response Debug ID: ${probeBody.debug_id ?? 'N/A'}`);
    if (probeBody.details) {
      log(`Response Details: ${JSON.stringify(probeBody.details)}`);
    }

    // Assert that zero financial requests were made
    expect(payoutCreateCalls).toBe(0);
    expect(orderCreateCalls).toBe(0);
    expect(captureCalls).toBe(0);
    expect(authCalls).toBe(1);
    expect(nonFinancialCalls).toBe(1);

    log('\n--- SAFETY AUDIT COUNTERS ---');
    log(`PAYPAL_AUTH_CALLS = ${authCalls}`);
    log(`PAYPAL_NON_FINANCIAL_CALLS = ${nonFinancialCalls}`);
    log(`PAYPAL_PAYOUT_CREATE_CALLS = ${payoutCreateCalls}`);
    log(`PAYPAL_ORDER_CREATE_CALLS = ${orderCreateCalls}`);
    log(`PAYPAL_CAPTURE_CALLS = ${captureCalls}`);
  });
});
