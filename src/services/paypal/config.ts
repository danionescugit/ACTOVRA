import { PayPalConfigurationError } from './errors';

/**
 * PayPal environment selection. SANDBOX is the safe default for development.
 * LIVE is available for configuration completeness but must never be used by
 * tests or default development flows.
 */
export type PayPalEnvironment = 'SANDBOX' | 'LIVE';

/** PayPal API base URLs (public, non-secret endpoints). */
export const PAYPAL_API_BASE_URLS: Record<PayPalEnvironment, string> = {
  SANDBOX: 'https://api-m.sandbox.paypal.com',
  LIVE: 'https://api-m.paypal.com',
};

/** OAuth token endpoint path (relative to the API base URL). */
export const PAYPAL_OAUTH_TOKEN_PATH = '/v1/oauth2/token';

/** Orders API create-order path (relative to the API base URL). */
export const PAYPAL_ORDERS_PATH = '/v2/checkout/orders';

export interface PayPalConfig {
  /** PayPal environment. SANDBOX is the safe default. */
  readonly environment: PayPalEnvironment;
  /** Resolved API base URL (no trailing slash). */
  readonly apiBaseUrl: string;
  /** PayPal REST app client ID (secret — never log). */
  readonly clientId: string;
  /** PayPal REST app client secret (secret — never log). */
  readonly clientSecret: string;
}

/**
 * Read a required string environment variable. The thrown error names the
 * variable but never includes its value.
 */
function requireEnvString(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new PayPalConfigurationError(
      `Missing required environment variable: ${name}`
    );
  }
  return value;
}

/**
 * Read an optional string environment variable with a default.
 */
function optionalEnvString(name: string, defaultValue: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    return defaultValue;
  }
  return value;
}

/**
 * Resolve a PayPal environment from an env value.
 * Accepts explicit environment names (SANDBOX/LIVE) or a full custom https://
 * API base URL (useful for sandbox-style or mocked endpoints). Unrecognized
 * values fail loudly rather than silently falling back to a production host.
 */
function resolveEnvironment(rawEnvironment: string): {
  environment: PayPalEnvironment;
  apiBaseUrl: string;
} {
  const normalized = rawEnvironment.trim().toUpperCase();

  if (normalized === 'SANDBOX') {
    return { environment: 'SANDBOX', apiBaseUrl: PAYPAL_API_BASE_URLS.SANDBOX };
  }
  if (normalized === 'LIVE') {
    return { environment: 'LIVE', apiBaseUrl: PAYPAL_API_BASE_URLS.LIVE };
  }

  if (/^https:\/\/[^\s]+$/i.test(rawEnvironment.trim())) {
    // A custom URL is an explicit non-default choice; treat unknown hosts as
    // SANDBOX-class (non-production) configuration.
    return {
      environment: 'SANDBOX',
      apiBaseUrl: rawEnvironment.trim().replace(/\/+$/, ''),
    };
  }

  throw new PayPalConfigurationError(
    'Invalid PAYPAL_ENVIRONMENT value (expected SANDBOX, LIVE, or an https:// base URL)'
  );
}

/**
 * Build the PayPal configuration from environment variables.
 *
 * Required:
 *   PAYPAL_CLIENT_ID      — PayPal REST app client ID
 *   PAYPAL_CLIENT_SECRET  — PayPal REST app client secret
 *
 * Optional:
 *   PAYPAL_ENVIRONMENT    — SANDBOX (default) | LIVE | https:// base URL
 *   PAYPAL_API_BASE       — explicit API base URL override (highest priority)
 *
 * Sandbox is always the safe/default development target: if neither
 * PAYPAL_ENVIRONMENT nor PAYPAL_API_BASE is set, SANDBOX is used.
 *
 * Throws PayPalConfigurationError (naming variables, never values) when
 * required configuration is missing.
 */
export function loadPayPalConfigFromEnv(): PayPalConfig {
  const clientId = requireEnvString('PAYPAL_CLIENT_ID');
  const clientSecret = requireEnvString('PAYPAL_CLIENT_SECRET');

  const explicitBase = optionalEnvString('PAYPAL_API_BASE', '');
  const rawEnvironment = optionalEnvString('PAYPAL_ENVIRONMENT', '');

  if (explicitBase.length > 0) {
    // Explicit base URL override wins; unknown hosts are treated as
    // SANDBOX-class (non-production) configuration.
    if (!/^https:\/\/[^\s]+$/i.test(explicitBase)) {
      throw new PayPalConfigurationError(
        'Invalid PAYPAL_API_BASE value (must be an https:// URL)'
      );
    }
    return {
      environment: 'SANDBOX',
      apiBaseUrl: explicitBase.replace(/\/+$/, ''),
      clientId,
      clientSecret,
    };
  }

  // Missing / empty / whitespace PAYPAL_ENVIRONMENT => safe Sandbox default.
  const resolved =
    rawEnvironment.trim().length === 0
      ? { environment: 'SANDBOX' as const, apiBaseUrl: PAYPAL_API_BASE_URLS.SANDBOX }
      : resolveEnvironment(rawEnvironment);
  return {
    environment: resolved.environment,
    apiBaseUrl: resolved.apiBaseUrl,
    clientId,
    clientSecret,
  };
}
