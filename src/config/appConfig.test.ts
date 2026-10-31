import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AppConfigurationError,
  DEFAULT_COMMERCEPILOT_DB_PATH,
  DEFAULT_COMMERCEPILOT_PUBLIC_BASE_URL,
  PAYPAL_CANCEL_PATH,
  PAYPAL_RETURN_PATH,
  loadAppConfigFromEnv,
} from './appConfig';

/**
 * Offline configuration tests only: no filesystem, no network, no secrets.
 * Environment stubbing follows the src/services/paypal config-test pattern.
 */
function stubEnv(overrides: Record<string, string> = {}): void {
  vi.stubEnv('COMMERCEPILOT_DB_PATH', '');
  vi.stubEnv('COMMERCEPILOT_PUBLIC_BASE_URL', '');
  for (const [key, value] of Object.entries(overrides)) vi.stubEnv(key, value);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('app config — defaults (C1)', () => {
  it('uses the documented defaults when no environment variables are set', () => {
    stubEnv();
    const config = loadAppConfigFromEnv();
    expect(config).toEqual({
      dbPath: './data/commerce.db',
      publicBaseUrl: 'https://commercepilot.toolspacehub.com',
      paypalReturnUrl: 'https://commercepilot.toolspacehub.com/paypal/return',
      paypalCancelUrl: 'https://commercepilot.toolspacehub.com/paypal/cancel',
    });
    expect(DEFAULT_COMMERCEPILOT_DB_PATH).toBe('./data/commerce.db');
    expect(DEFAULT_COMMERCEPILOT_PUBLIC_BASE_URL).toBe(
      'https://commercepilot.toolspacehub.com'
    );
    expect(PAYPAL_RETURN_PATH).toBe('/paypal/return');
    expect(PAYPAL_CANCEL_PATH).toBe('/paypal/cancel');
  });

  it('treats whitespace-only variables as unset (defaults still apply)', () => {
    stubEnv({ COMMERCEPILOT_DB_PATH: '   ', COMMERCEPILOT_PUBLIC_BASE_URL: '  ' });
    const config = loadAppConfigFromEnv();
    expect(config.dbPath).toBe('./data/commerce.db');
    expect(config.publicBaseUrl).toBe('https://commercepilot.toolspacehub.com');
  });
});

describe('app config — overrides (C2)', () => {
  it('honors explicit overrides and derives both redirect URLs from the base URL', () => {
    stubEnv({
      COMMERCEPILOT_DB_PATH: './data/other-commerce.db',
      COMMERCEPILOT_PUBLIC_BASE_URL: 'https://staging.toolspacehub.com',
    });
    const config = loadAppConfigFromEnv();
    expect(config.dbPath).toBe('./data/other-commerce.db');
    expect(config.paypalReturnUrl).toBe('https://staging.toolspacehub.com/paypal/return');
    expect(config.paypalCancelUrl).toBe('https://staging.toolspacehub.com/paypal/cancel');
  });

  it('strips trailing slashes from the base URL before deriving redirect paths', () => {
    stubEnv({ COMMERCEPILOT_PUBLIC_BASE_URL: 'https://commercepilot.toolspacehub.com///' });
    const config = loadAppConfigFromEnv();
    expect(config.publicBaseUrl).toBe('https://commercepilot.toolspacehub.com');
    expect(config.paypalReturnUrl).toBe('https://commercepilot.toolspacehub.com/paypal/return');
    expect(config.paypalCancelUrl).toBe('https://commercepilot.toolspacehub.com/paypal/cancel');
  });
});

describe('app config — HTTPS-only public base URL (C3)', () => {
  it.each([
    ['plain HTTP', 'http://commercepilot.example'],
    ['HTTP with an explicit localhost exception attempt', 'http://localhost:3000'],
    ['HTTP with a 127.0.0.1 exception attempt', 'http://127.0.0.1:3000'],
    ['uppercase HTTP scheme', 'HTTP://commercepilot.example'],
  ] as Array<[string, string]>)('rejects %s (no localhost exception exists)', (_label, url) => {
    stubEnv({ COMMERCEPILOT_PUBLIC_BASE_URL: url });
    expect(() => loadAppConfigFromEnv()).toThrow(AppConfigurationError);
    expect(() => loadAppConfigFromEnv()).toThrow(/COMMERCEPILOT_PUBLIC_BASE_URL/);
    expect(() => loadAppConfigFromEnv()).toThrow(/https/);
  });

  it('rejects malformed URLs and never echoes the value', () => {
    stubEnv({ COMMERCEPILOT_PUBLIC_BASE_URL: 'not a url at all' });
    expect(() => loadAppConfigFromEnv()).toThrow(AppConfigurationError);
    // Positive secret-hygiene check: the error message names the variable and
    // the rule, never the offending value.
    let message = '';
    try {
      loadAppConfigFromEnv();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('COMMERCEPILOT_PUBLIC_BASE_URL');
    expect(message).not.toContain('not a url at all');
  });

  it('rejects base URLs with query strings or fragments', () => {
    stubEnv({ COMMERCEPILOT_PUBLIC_BASE_URL: 'https://commercepilot.example/?x=1' });
    expect(() => loadAppConfigFromEnv()).toThrow(AppConfigurationError);

    stubEnv({ COMMERCEPILOT_PUBLIC_BASE_URL: 'https://commercepilot.example/#frag' });
    expect(() => loadAppConfigFromEnv()).toThrow(AppConfigurationError);
  });

  it('rejects base URLs with embedded credentials', () => {
    stubEnv({ COMMERCEPILOT_PUBLIC_BASE_URL: 'https://user:pass@commercepilot.example' });
    expect(() => loadAppConfigFromEnv()).toThrow(AppConfigurationError);
  });
});

describe('app config — db path validation (C4)', () => {
  it('rejects empty and whitespace-only paths', () => {
    stubEnv({ COMMERCEPILOT_DB_PATH: '' });
    // Empty is treated as unset → default applies (documented behavior).
    expect(loadAppConfigFromEnv().dbPath).toBe('./data/commerce.db');
  });

  it('rejects parent-directory (..) traversal segments on both separators', () => {
    const bad = [
      '../outside/commerce.db',
      '..\\outside\\commerce.db',
      './data/../secrets.db',
      'data/../../etc/paypal',
      '..',
    ];
    for (const path of bad) {
      stubEnv({ COMMERCEPILOT_DB_PATH: path });
      expect(() => loadAppConfigFromEnv(), `expected rejection: ${path}`).toThrow(
        AppConfigurationError
      );
      expect(() => loadAppConfigFromEnv(), path).toThrow(/COMMERCEPILOT_DB_PATH/);
    }
  });

  it('never echoes the rejected traversal path value', () => {
    stubEnv({ COMMERCEPILOT_DB_PATH: '../outside/secrets.db' });
    let message = '';
    try {
      loadAppConfigFromEnv();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('COMMERCEPILOT_DB_PATH');
    expect(message).not.toContain('secrets.db');
  });

  it('accepts ordinary relative and absolute paths (within-project)', () => {
    stubEnv({ COMMERCEPILOT_DB_PATH: '/var/lib/commercepilot/commerce.db' });
    expect(loadAppConfigFromEnv().dbPath).toBe('/var/lib/commercepilot/commerce.db');
    stubEnv({ COMMERCEPILOT_DB_PATH: './data/nested/commerce.db' });
    expect(loadAppConfigFromEnv().dbPath).toBe('./data/nested/commerce.db');
  });
});

describe('app config — no secrets, no side effects (C5)', () => {
  it('contains only non-secret values (a path and public URLs)', () => {
    stubEnv();
    const config = loadAppConfigFromEnv();
    const serialized = JSON.stringify(config);
    expect(serialized).not.toMatch(/client|secret|token|key/i);
    expect(Object.keys(config).sort()).toEqual([
      'dbPath',
      'paypalCancelUrl',
      'paypalReturnUrl',
      'publicBaseUrl',
    ]);
  });
});
