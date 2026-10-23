/**
 * Explicit error model for the PayPal service boundary (Task 07, Checkpoint 1).
 *
 * Design rules:
 * - Errors are typed so a future orchestration layer can distinguish:
 *     configuration problems, caller-input problems, authentication
 *     failures, PayPal HTTP/API failures, and malformed PayPal responses.
 * - Errors MUST NEVER contain client secrets, access tokens, Authorization
 *   headers, or full sensitive response dumps. Call sites only embed the HTTP
 *   status and PayPal's own short error name/message when available.
 */

export interface PayPalErrorOptions {
  readonly cause?: unknown;
}

/** Base class for every error raised by the PayPal service boundary. */
export class PayPalError extends Error {
  constructor(message: string, options?: PayPalErrorOptions) {
    super(message);
    this.name = 'PayPalError';
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/**
 * Configuration error: required environment configuration is missing or
 * invalid (e.g. PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET not set).
 * Messages name the offending variable — never its value.
 */
export class PayPalConfigurationError extends PayPalError {
  constructor(message: string, options?: PayPalErrorOptions) {
    super(message);
    this.name = 'PayPalConfigurationError';
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/**
 * Caller-input error: a request failed local validation BEFORE any HTTP call
 * was made (e.g. empty idempotency request ID, non-integer amount,
 * unsupported currency).
 */
export class PayPalInvalidRequestError extends PayPalError {
  constructor(message: string, options?: PayPalErrorOptions) {
    super(message);
    this.name = 'PayPalInvalidRequestError';
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/**
 * Authentication error: the PayPal OAuth token endpoint returned a non-2xx
 * response or the token could not be obtained for any other reason.
 */
export class PayPalAuthenticationError extends PayPalError {
  /** HTTP status returned by the token endpoint, when available. */
  readonly status?: number;

  constructor(
    message: string,
    options?: PayPalErrorOptions & { readonly status?: number }
  ) {
    super(message);
    this.name = 'PayPalAuthenticationError';
    this.status = options?.status;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/**
 * HTTP/API error: a PayPal API call (e.g. Orders create) returned a non-2xx
 * response, or the request failed at the transport level. Carries only the
 * status and PayPal's short error name/message — never request headers.
 */
export class PayPalHttpApiError extends PayPalError {
  /** HTTP status returned by PayPal, when available (undefined on network errors). */
  readonly status?: number;
  /** PayPal's own error `name` field, when present in the response body. */
  readonly paypalErrorName?: string;
  /** PayPal's own error `message` field (truncated), when present. */
  readonly paypalErrorMessage?: string;

  constructor(
    message: string,
    options?: PayPalErrorOptions & {
      readonly status?: number;
      readonly paypalErrorName?: string;
      readonly paypalErrorMessage?: string;
    }
  ) {
    super(message);
    this.name = 'PayPalHttpApiError';
    this.status = options?.status;
    this.paypalErrorName = options?.paypalErrorName;
    this.paypalErrorMessage = options?.paypalErrorMessage;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/**
 * Malformed response error: PayPal returned a 2xx response but the body was
 * not valid JSON, or required fields were missing/had unexpected types.
 */
export class PayPalMalformedResponseError extends PayPalError {
  constructor(message: string, options?: PayPalErrorOptions) {
    super(message);
    this.name = 'PayPalMalformedResponseError';
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}
