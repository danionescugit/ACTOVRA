import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCommercePilotComposition,
  getCommercePilotComposition,
  resetCommercePilotCompositionForTests,
} from './composition';

/**
 * Offline composition tests: the composition root must construct the full
 * object graph WITHOUT any network I/O. PayPal credentials are stubbed as
 * clearly-fake values; the PayPalService is only constructed (never called).
 */

const createdDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'commercepilot-comp-'));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  resetCommercePilotCompositionForTests();
  vi.unstubAllEnvs();
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Stub the env with fake credentials and a temp DB path. */
function stubEnv(dbPath: string, overrides: Record<string, string> = {}): void {
  vi.stubEnv('PAYPAL_CLIENT_ID', 'fake-composition-client-id');
  vi.stubEnv('PAYPAL_CLIENT_SECRET', 'fake-composition-client-secret');
  vi.stubEnv('PAYPAL_ENVIRONMENT', '');
  vi.stubEnv('PAYPAL_API_BASE', '');
  vi.stubEnv('COMMERCEPILOT_DB_PATH', dbPath);
  vi.stubEnv('COMMERCEPILOT_PUBLIC_BASE_URL', '');
  for (const [key, value] of Object.entries(overrides)) vi.stubEnv(key, value);
}

describe('createCommercePilotComposition (D1)', () => {
  it('wires the full object graph with zero network calls and correct types', () => {
    const dir = tempDir();
    stubEnv(join(dir, 'commerce.db'));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const composition = createCommercePilotComposition();

    expect(composition.config.dbPath).toBe(join(dir, 'commerce.db'));
    expect(composition.config.publicBaseUrl).toBe('https://commercepilot.toolspacehub.com');
    expect(composition.config.paypalReturnUrl).toBe(
      'https://commercepilot.toolspacehub.com/paypal/return'
    );
    expect(composition.config.paypalCancelUrl).toBe(
      'https://commercepilot.toolspacehub.com/paypal/cancel'
    );
    expect(typeof composition.paypal.createOrder).toBe('function');
    expect(typeof composition.execution.executeApprovedOperation).toBe('function');
    expect(typeof composition.capture.captureApprovedOrder).toBe('function');
    expect(typeof composition.application.createOperationAwaitingApproval).toBe('function');
    // The store is immediately usable (durable DB opened and schema applied).
    composition.store.createOperation('op-comp-1', 'opp-1', new Date('2026-01-01T00:00:00Z'));
    expect(composition.store.getOperation('op-comp-1')?.status).toBe('OPPORTUNITY');
    expect(composition.application.getOperation('op-comp-1')?.status).toBe('OPPORTUNITY');
    expect(typeof composition.close).toBe('function');

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    composition.close();
  });

  it('honors explicit configs over environment (injectable for tests)', () => {
    const dir = tempDir();
    const composition = createCommercePilotComposition({
      appConfig: {
        dbPath: join(dir, 'explicit.db'),
        publicBaseUrl: 'https://explicit.example',
        paypalReturnUrl: 'https://explicit.example/paypal/return',
        paypalCancelUrl: 'https://explicit.example/paypal/cancel',
      },
      paypalConfig: {
        environment: 'SANDBOX',
        apiBaseUrl: 'https://paypal-mock.invalid',
        clientId: 'explicit-id',
        clientSecret: 'explicit-secret',
      },
    });
    expect(composition.config.dbPath).toBe(join(dir, 'explicit.db'));
    expect(composition.store.getOperation('missing')).toBeUndefined();
    composition.close();
  });

  it('creates a real durable database file at the configured path (WAL file-backed)', () => {
    const dir = tempDir();
    const dbPath = join(dir, 'durable.db');
    stubEnv(dbPath);
    const composition = createCommercePilotComposition();
    composition.store.createOperation('op-dur-1', 'opp-1', new Date('2026-01-01T00:00:00Z'));
    composition.close();

    expect(existsSync(dbPath)).toBe(true);
    expect(statSync(dbPath).size).toBeGreaterThan(0);
    // Reopening the same path sees the durable data.
    const reopened = createCommercePilotComposition();
    expect(reopened.store.getOperation('op-dur-1')?.id).toBe('op-dur-1');
    reopened.close();
  });

  it('throws PayPalConfigurationError naming the variable when credentials are missing', () => {
    const dir = tempDir();
    stubEnv(join(dir, 'commerce.db'), { PAYPAL_CLIENT_ID: '' });
    let message = '';
    try {
      createCommercePilotComposition();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('PAYPAL_CLIENT_ID');
    expect(message).not.toContain('fake-composition-client-id');
  });
});

describe('lazy singleton getCommercePilotComposition (D2)', () => {
  it('is lazy: importing the module performs no construction (no env reads at import)', async () => {
    // No credentials stubbed here on purpose. The module was already imported
    // at the top of this file; if construction happened at import time, this
    // suite would already have thrown. Calling now MUST throw (proving the
    // credential read happens at call time, not import time).
    vi.stubEnv('PAYPAL_CLIENT_ID', '');
    vi.stubEnv('PAYPAL_CLIENT_SECRET', '');
    vi.stubEnv('COMMERCEPILOT_DB_PATH', join(tempDir(), 'commerce.db'));
    let message = '';
    try {
      getCommercePilotComposition();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('PAYPAL_CLIENT_ID');
  });

  it('returns the SAME instance across calls and rebuilds only after reset', () => {
    const dir = tempDir();
    stubEnv(join(dir, 'commerce.db'));
    const a = getCommercePilotComposition();
    const b = getCommercePilotComposition();
    expect(b).toBe(a);

    const c = createCommercePilotComposition();
    expect(c).not.toBe(a);
    c.close();

    resetCommercePilotCompositionForTests();
    const d = getCommercePilotComposition();
    expect(d).not.toBe(a);
    d.close();
  });

  it('close() releases the singleton handle; the store rejects after close', () => {
    const dir = tempDir();
    stubEnv(join(dir, 'commerce.db'));
    const composition = getCommercePilotComposition();
    composition.close();
    expect(() => composition.store.getOperation('anything')).toThrow();
  });
});
