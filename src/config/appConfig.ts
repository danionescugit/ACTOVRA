/**
 * CommercePilot application configuration (Task 10, CP2-C).
 *
 * Server-side runtime configuration for the composition root:
 * - Where the durable commerce store database lives.
 * - The canonical HTTPS public base URL of this deployment, from which the
 *   PayPal redirect-approval return/cancel URLs are derived.
 *
 * Discipline (mirrors src/services/paypal/config.ts):
 * - Pure synchronous env reader; no I/O, no network, no secrets. All values
 *   here are non-secret (a database path and public URLs).
 * - Validation errors name the environment variable and the rule violated —
 *   NEVER the offending value.
 * - HTTPS-only public base URL: buyer redirects must never target plain HTTP.
 *   There is deliberately NO localhost/HTTP exception (CP1 decision): local
 *   development uses the sandbox + a tunnel, or the default public base URL
 *   with no buyer redirect exercised.
 * - No side effects at import time; callers opt in via loadAppConfigFromEnv().
 */

/** Non-secret, fully-derived application configuration. */
export interface AppConfig {
  /**
   * Filesystem path for the commerce store database (or ':memory:' only in
   * tests). Relative paths are resolved against the process working
   * directory by the store layer.
   */
  readonly dbPath: string;
  /**
   * Canonical HTTPS base URL of this deployment (no trailing slash). Used
   * ONLY to derive absolute buyer-redirect URLs; never echoed in errors.
   */
  readonly publicBaseUrl: string;
  /** Absolute HTTPS URL PayPal redirects the buyer's browser to after approval. */
  readonly paypalReturnUrl: string;
  /** Absolute HTTPS URL PayPal redirects the buyer's browser to on cancellation. */
  readonly paypalCancelUrl: string;
}

/** Error raised for invalid application configuration (never echoes values). */
export class AppConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppConfigurationError';
  }
}

/** Default store database path (relative to the process working directory). */
export const DEFAULT_COMMERCEPILOT_DB_PATH = './data/commerce.db';

/** Default public base URL of the CommercePilot deployment. */
export const DEFAULT_COMMERCEPILOT_PUBLIC_BASE_URL =
  'https://commercepilot.toolspacehub.com';

/** Fixed buyer-redirect paths derived from the public base URL. */
export const PAYPAL_RETURN_PATH = '/paypal/return';
export const PAYPAL_CANCEL_PATH = '/paypal/cancel';

/**
 * Read an optional string environment variable with a default; whitespace-only
 * values are treated as unset (same discipline as the PayPal boundary).
 */
function optionalEnvString(name: string, defaultValue: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    return defaultValue;
  }
  return value;
}

/**
 * Validate a database path. Rejects empty paths and any path containing a
 * `..` segment (on either separator style) so configuration can never point
 * the store outside the intended location via traversal. The value is never
 * echoed in errors.
 */
function validateDbPath(name: string, rawPath: string): string {
  const trimmed = rawPath.trim();
  if (trimmed.length === 0) {
    throw new AppConfigurationError(
      `Invalid ${name}: must be a non-empty database path`
    );
  }
  const segments = trimmed.split(/[\\/]/);
  if (segments.includes('..')) {
    throw new AppConfigurationError(
      `Invalid ${name}: parent-directory segments ('..') are not allowed`
    );
  }
  if (trimmed.includes('\0')) {
    throw new AppConfigurationError(
      `Invalid ${name}: null bytes are not allowed`
    );
  }
  return trimmed;
}

/**
 * Validate and normalize the public base URL: must be an absolute https://
 * URL with no query string or fragment; trailing slashes are stripped so the
 * derived redirect URLs are deterministic. Never echoes the value.
 */
function validatePublicBaseUrl(name: string, rawUrl: string): string {
  const trimmed = rawUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new AppConfigurationError(
      `Invalid ${name}: must be a valid absolute URL (malformed value rejected; value not echoed)`
    );
  }
  if (parsed.protocol !== 'https:') {
    throw new AppConfigurationError(
      `Invalid ${name}: must be an https:// URL (non-HTTPS values are rejected; there is no localhost exception)`
    );
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new AppConfigurationError(
      `Invalid ${name}: query strings and fragments are not allowed (they would corrupt derived redirect paths)`
    );
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new AppConfigurationError(
      `Invalid ${name}: embedded credentials are not allowed`
    );
  }
  return trimmed.replace(/\/+$/, '');
}

/**
 * Build the application configuration from environment variables.
 *
 * Optional (all have safe defaults):
 *   COMMERCEPILOT_DB_PATH          — store database file (default
 *                                    ./data/commerce.db); '..' segments
 *                                    rejected
 *   COMMERCEPILOT_PUBLIC_BASE_URL  — canonical HTTPS base URL (default
 *                                    https://commercepilot.toolspacehub.com);
 *                                    HTTPS-only, no query/fragment
 *
 * Derived (not configurable):
 *   paypalReturnUrl = {publicBaseUrl}/paypal/return
 *   paypalCancelUrl = {publicBaseUrl}/paypal/cancel
 *
 * @throws AppConfigurationError naming variables and rules, never values.
 */
export function loadAppConfigFromEnv(): AppConfig {
  const dbPath = validateDbPath(
    'COMMERCEPILOT_DB_PATH',
    optionalEnvString('COMMERCEPILOT_DB_PATH', DEFAULT_COMMERCEPILOT_DB_PATH)
  );

  const publicBaseUrl = validatePublicBaseUrl(
    'COMMERCEPILOT_PUBLIC_BASE_URL',
    optionalEnvString(
      'COMMERCEPILOT_PUBLIC_BASE_URL',
      DEFAULT_COMMERCEPILOT_PUBLIC_BASE_URL
    )
  );

  return {
    dbPath,
    publicBaseUrl,
    paypalReturnUrl: `${publicBaseUrl}${PAYPAL_RETURN_PATH}`,
    paypalCancelUrl: `${publicBaseUrl}${PAYPAL_CANCEL_PATH}`,
  };
}
