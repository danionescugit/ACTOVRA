import { z } from 'zod';
import {
  PayPalAuthenticationError,
  PayPalConfigurationError,
  PayPalHttpApiError,
  PayPalInvalidRequestError,
  PayPalMalformedResponseError,
} from './errors';
import {
  convertMinorUnitsToPayPalAmount,
  isSupportedPayPalCurrency,
  parsePayPalAmountToMinorUnits,
  type PayPalSupportedCurrency,
} from './money';
import {
  PAYPAL_OAUTH_TOKEN_PATH,
  PAYPAL_ORDERS_PATH,
  type PayPalConfig,
  type PayPalEnvironment,
} from './config';

/**
 * PayPal Orders API service boundary (infrastructure adapter only).
 *
 * - OAuth (client credentials) + create-order + capture + get-order against
 *   the PayPal Orders API v2.
 * - Caller owns the stable PayPal-Request-Id; it is sent verbatim on every
 *   call, including retries. The service never generates keys.
 * - No token caching, no automatic retry (orchestration layer's job, reusing
 *   the same requestId). captureOrder performs AT MOST ONE capture HTTP
 *   attempt per invocation.
 * - This file knows nothing about CommerceOperation, the store, or the state
 *   machine: calling PayPal never advances operation state, and the service
 *   never decides WHETHER a capture is permitted — only executes a validated
 *   provider request.
 * - No webhooks. Errors never contain secrets, tokens, or Authorization
 *   headers.
 */

/** HTTP transport — injectable so tests never hit the network. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** CommercePilot-owned input for creating a PayPal order. */
export interface CreatePayPalOrderInput {
  /** Caller-owned stable idempotency/request ID (non-empty). */
  readonly requestId: string;
  /** Purchase amount in integer minor units (cents). */
  readonly amountMinorUnits: number;
  /** ISO currency code; must be domain-supported. */
  readonly currency: PayPalSupportedCurrency;
  /** Optional CommercePilot-owned reference echoed into PayPal custom_id. */
  readonly commerceOperationId?: string;
  /**
   * Optional buyer-redirect approval flow: the URL PayPal redirects the
   * buyer's browser to AFTER approval. MUST be paired with cancelUrl (either
   * both or neither). Absolute HTTPS only; validated BEFORE any network call.
   */
  readonly returnUrl?: string;
  /**
   * Optional buyer-redirect approval flow: the URL PayPal redirects the
   * buyer's browser to on cancellation. MUST be paired with returnUrl (either
   * both or neither). Absolute HTTPS only; validated BEFORE any network call.
   */
  readonly cancelUrl?: string;
}

/**
 * Validate one redirect-approval URL for the create-order experience_context.
 * Absolute HTTPS URLs only; invalid values are rejected (never silently
 * normalized) with an error naming the field — never echoing the value.
 */
function validateExperienceContextUrl(
  fieldName: 'returnUrl' | 'cancelUrl',
  rawUrl: string
): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new PayPalInvalidRequestError(
      `${fieldName} must be a valid absolute URL (malformed value rejected; value not echoed)`
    );
  }
  if (parsed.protocol !== 'https:') {
    throw new PayPalInvalidRequestError(
      `${fieldName} must be an https:// URL (non-HTTPS value rejected; value not echoed)`
    );
  }
}

/** CommercePilot-owned normalized create-order result. */
export interface PayPalCreateOrderResult {
  readonly paypalOrderId: string;
  readonly status: string;
  readonly environment: PayPalEnvironment;
  /**
   * Buyer-approval redirect URL, when PayPal returns one (approval flow).
   * Normalized from the HATEOAS link whose rel is either "approve" (the
   * standard buyer-approval link) or "payer-action" (observed live when
   * experience_context user_action is PAY_NOW); "approve" is preferred when
   * both are present. Absent when PayPal returns neither.
   */
  readonly approveUrl?: string;
  /** Echoed caller request ID for traceability. */
  readonly requestId: string;
}

/**
 * CommercePilot-owned input for capturing an existing PayPal order.
 *
 * The PayPal order ID is a provider-level primitive here. The future capture
 * orchestrator MUST obtain it exclusively from the persisted
 * CommerceOperation.paypalOrder — no browser/client-supplied order ID may
 * become authoritative.
 */
export interface CapturePayPalOrderInput {
  /** PayPal order ID to capture (non-empty). */
  readonly paypalOrderId: string;
  /**
   * Caller-owned stable idempotency/request ID (non-empty), sent verbatim as
   * PayPal-Request-Id on the capture call. The service never generates one.
   */
  readonly requestId: string;
}

/** Normalized PayPal capture state for one captured payment. */
export interface PayPalCaptureStatus {
  /** PayPal capture (transaction) ID, e.g. "8XA123456V1234567". */
  readonly captureId: string;
  /** PayPal capture status, e.g. 'COMPLETED' | 'DECLINED' | 'PENDING'. */
  readonly status: string;
  /** Captured amount in integer minor units (deterministic, no floats). */
  readonly amountMinorUnits: number;
  /** ISO currency code of the captured amount as reported by PayPal. */
  readonly currency: PayPalSupportedCurrency;
}

/**
 * CommercePilot-owned normalized capture evidence. Contains exactly what the
 * future orchestrator needs to truthfully construct PAYMENT_COMPLETED after a
 * successful capture — and nothing more.
 */
export interface PayPalCaptureOrderResult {
  readonly paypalOrderId: string;
  /** PayPal order status in the capture response, e.g. 'COMPLETED'. */
  readonly orderStatus: string;
  readonly capture: PayPalCaptureStatus;
  /** Echoed caller request ID for traceability. */
  readonly requestId: string;
  readonly environment: PayPalEnvironment;
}

/**
 * CommercePilot-owned normalized get-order result (read-only reconciliation).
 */
export interface PayPalGetOrderResult {
  readonly paypalOrderId: string;
  /** PayPal order status, e.g. 'COMPLETED' | 'APPROVED' | 'CREATED'. */
  readonly orderStatus: string;
  /** Captures PayPal reports for the order, when any exist. */
  readonly captures: readonly PayPalCaptureStatus[];
}

export type PayPalServiceOptions = {
  readonly config: PayPalConfig;
  readonly fetchImpl?: FetchLike;
};

const OAuthTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().min(1),
  expires_in: z.union([z.number(), z.string()]),
});

const CreateOrderResponseSchema = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  links: z
    .array(
      z.object({
        rel: z.string(),
        href: z.string(),
        method: z.string().optional(),
      })
    )
    .optional(),
});

/**
 * PayPal capture object as returned inside purchase_units[].payments.captures[]
 * (capture response and get-order response). Only fields CommercePilot needs
 * are extracted; `amount.value` is a decimal string ("10.50") normalized to
 * integer minor units by the money utilities (never via floats).
 */
const PayPalCaptureSchema = z
  .object({
    id: z.string().min(1),
    status: z.string().min(1),
    amount: z.object({
      currency_code: z.string().min(1),
      value: z.string().min(1),
    }),
  })
  .passthrough();

/** One purchase_units[] entry (shared by capture and get-order responses). */
const PurchaseUnitWithPaymentsSchema = z
  .object({
    payments: z
      .object({
        captures: z.array(PayPalCaptureSchema),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/** Capture response body: the order with its captures attached. */
const CaptureOrderResponseSchema = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  purchase_units: z.array(PurchaseUnitWithPaymentsSchema).min(1),
});

/** Get-order response body: order with optional payments/captures. */
const GetOrderResponseSchema = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  purchase_units: z.array(PurchaseUnitWithPaymentsSchema).min(1),
});

type ParsedPurchaseUnit = z.infer<typeof PurchaseUnitWithPaymentsSchema>;

/**
 * Normalize one PayPal capture object into typed evidence. Deterministic
 * money parsing; unsupported/malformed currency or amount values are rejected
 * as malformed provider responses.
 */
function normalizeCapture(
  capture: z.infer<typeof PayPalCaptureSchema>
): PayPalCaptureStatus {
  const currency = capture.amount.currency_code;
  if (!isSupportedPayPalCurrency(currency)) {
    throw new PayPalMalformedResponseError(
      `PayPal capture response has an unsupported currency: ${JSON.stringify(currency)}`
    );
  }
  let amountMinorUnits: number;
  try {
    amountMinorUnits = parsePayPalAmountToMinorUnits(
      capture.amount.value,
      currency
    );
  } catch {
    // The parser's message is categorical (never echoes the untrusted input);
    // do not attach the cause either, since it embeds provider-supplied text.
    throw new PayPalMalformedResponseError(
      'PayPal capture response has a malformed amount (rejected by deterministic money parsing)'
    );
  }
  return {
    captureId: capture.id,
    status: capture.status,
    amountMinorUnits,
    currency,
  };
}

/**
 * Extract the first capture from an orders response. `requireCapture` selects
 * between the capture-response discipline (exactly one capture required) and
 * the get-order discipline (zero or more captures tolerated).
 */
function extractCaptures(
  purchaseUnits: readonly ParsedPurchaseUnit[],
  requireCapture: boolean
): PayPalCaptureStatus[] {
  const captures: PayPalCaptureStatus[] = [];
  for (const unit of purchaseUnits) {
    for (const capture of unit.payments?.captures ?? []) {
      captures.push(normalizeCapture(capture));
    }
  }
  if (requireCapture && captures.length === 0) {
    throw new PayPalMalformedResponseError(
      'PayPal capture response contains no capture evidence (no purchase_units[].payments.captures[])'
    );
  }
  return captures;
}

/** Short, secret-free {name, message} from a PayPal error response body. */
function extractApiErrorNameAndMessage(rawBody: string): {
  name?: string;
  message?: string;
} {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      return {
        name: typeof record.name === 'string' ? record.name : undefined,
        message: typeof record.message === 'string' ? record.message : undefined,
      };
    }
    return {};
  } catch {
    return {};
  }
}

function truncate(value: string, max = 200): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function zodIssuesToString(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('; ');
}

export class PayPalService {
  readonly #config: PayPalConfig;
  readonly #fetchImpl: FetchLike;

  constructor(options: PayPalServiceOptions) {
    this.#config = options.config;
    this.#fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  /**
   * POST {base}/v1/oauth2/token with Basic auth and
   * grant_type=client_credentials. Returns the validated token fields.
   *
   * @throws PayPalConfigurationError when credentials are absent.
   * @throws PayPalAuthenticationError on non-2xx or transport failure
   *   (status only — the token-endpoint body is never read on failure).
   * @throws PayPalMalformedResponseError when the 2xx body is unusable.
   */
  async getAccessToken(): Promise<{
    accessToken: string;
    tokenType: string;
    expiresInSeconds: number;
  }> {
    const { clientId, clientSecret, apiBaseUrl } = this.#config;
    if (!clientId || !clientSecret) {
      throw new PayPalConfigurationError(
        'PayPal client credentials are not configured (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET)'
      );
    }

    const url = `${apiBaseUrl}${PAYPAL_OAUTH_TOKEN_PATH}`;
    // Built here, sent only as a header, never included in errors/logs.
    const basicAuthToken = Buffer.from(
      `${clientId}:${clientSecret}`,
      'utf8'
    ).toString('base64');

    let response: Response;
    try {
      response = await this.#fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basicAuthToken}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
      });
    } catch (cause) {
      throw new PayPalAuthenticationError(
        'PayPal OAuth token request failed at the transport level',
        { cause }
      );
    }

    if (!response.ok) {
      throw new PayPalAuthenticationError(
        `PayPal OAuth token request failed with HTTP status ${response.status}`,
        { status: response.status }
      );
    }

    let rawBody: string;
    try {
      rawBody = await response.text();
    } catch (cause) {
      throw new PayPalAuthenticationError(
        'PayPal OAuth token response could not be read',
        { cause }
      );
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawBody);
    } catch {
      throw new PayPalMalformedResponseError(
        'PayPal OAuth token response is not valid JSON'
      );
    }

    const result = OAuthTokenResponseSchema.safeParse(parsedJson);
    if (!result.success) {
      throw new PayPalMalformedResponseError(
        `PayPal OAuth token response failed validation: ${zodIssuesToString(result.error)}`
      );
    }

    const expiresRaw = result.data.expires_in;
    const expiresInSeconds =
      typeof expiresRaw === 'number'
        ? expiresRaw
        : Number.parseInt(expiresRaw, 10);

    if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
      throw new PayPalMalformedResponseError(
        'PayPal OAuth token response has an invalid expires_in value'
      );
    }

    return {
      accessToken: result.data.access_token,
      tokenType: result.data.token_type,
      expiresInSeconds,
    };
  }

  /**
   * POST {base}/v2/checkout/orders (intent=CAPTURE; no /capture call here).
   * Sends the caller-supplied requestId verbatim as PayPal-Request-Id so
   * retried logical operations deduplicate at PayPal. Validates all inputs
   * locally BEFORE any HTTP call. No token caching, no automatic retry.
   *
   * Redirect (manual buyer) approval flow: when BOTH returnUrl and cancelUrl
   * are supplied, they are sent as
   * payment_source.paypal.experience_context.{return_url,cancel_url} with
   * user_action "PAY_NOW" (the current PayPal Orders v2 location; the legacy
   * top-level application_context form is deprecated). With neither supplied
   * the request is unchanged (backward compatible; server-driven flows that
   * never redirect the buyer's browser are unaffected). Half-configured
   * pairing (exactly one of the two) is rejected before any network call.
   *
   * @throws PayPalInvalidRequestError for pre-HTTP input problems.
   * @throws PayPalAuthenticationError when token acquisition fails.
   * @throws PayPalHttpApiError on non-2xx or transport failure.
   * @throws PayPalMalformedResponseError when a 2xx body is unusable.
   */
  async createOrder(
    input: CreatePayPalOrderInput
  ): Promise<PayPalCreateOrderResult> {
    // ---- Local validation (no HTTP side effects) --------------------------
    if (typeof input.requestId !== 'string' || input.requestId.trim().length === 0) {
      throw new PayPalInvalidRequestError(
        'requestId must be a non-empty string (caller-owned stable idempotency ID)'
      );
    }

    if (
      !Number.isSafeInteger(input.amountMinorUnits) ||
      input.amountMinorUnits <= 0
    ) {
      throw new PayPalInvalidRequestError(
        'amountMinorUnits must be a positive safe integer (minor units/cents)'
      );
    }

    if (!isSupportedPayPalCurrency(input.currency)) {
      throw new PayPalInvalidRequestError(
        `Unsupported currency: ${String(input.currency)}`
      );
    }

    if (
      input.commerceOperationId !== undefined &&
      input.commerceOperationId.length > 200
    ) {
      throw new PayPalInvalidRequestError(
        'commerceOperationId must be at most 200 characters'
      );
    }

    // ---- Redirect approval-flow pairing rule -------------------------------
    // Either BOTH returnUrl and cancelUrl are absent (server-driven flow,
    // unchanged behavior) or BOTH are present and valid (manual buyer-redirect
    // approval). Exactly one supplied => reject BEFORE any network call.
    // Never invent default URLs.
    if (
      (input.returnUrl === undefined) !== (input.cancelUrl === undefined)
    ) {
      throw new PayPalInvalidRequestError(
        'returnUrl and cancelUrl must be supplied together or both omitted (half-configured approval flow rejected)'
      );
    }
    if (input.returnUrl !== undefined) {
      if (typeof input.returnUrl !== 'string' || input.returnUrl.length === 0) {
        throw new PayPalInvalidRequestError(
          'returnUrl must be a non-empty string when supplied'
        );
      }
      if (typeof input.cancelUrl !== 'string' || input.cancelUrl.length === 0) {
        throw new PayPalInvalidRequestError(
          'cancelUrl must be a non-empty string when supplied'
        );
      }
      validateExperienceContextUrl('returnUrl', input.returnUrl);
      validateExperienceContextUrl('cancelUrl', input.cancelUrl);
    }

    // ---- OAuth (no caching in this checkpoint) -----------------------------
    const token = await this.getAccessToken();

    // ---- Request ------------------------------------------------------------
    const amountString = convertMinorUnitsToPayPalAmount(
      input.currency,
      input.amountMinorUnits
    );
    const url = `${this.#config.apiBaseUrl}${PAYPAL_ORDERS_PATH}`;
    // Redirect approval-flow configuration goes ONLY at the current PayPal
    // Orders v2 location (payment_source.paypal.experience_context); the
    // legacy top-level application_context form is deprecated and is never
    // sent. user_action PAY_NOW renders an explicit pay button for the buyer.
    const body = {
      intent: 'CAPTURE' as const,
      purchase_units: [
        {
          amount: {
            currency_code: input.currency,
            value: amountString,
          },
          ...(input.commerceOperationId !== undefined
            ? { custom_id: input.commerceOperationId }
            : {}),
        },
      ],
      ...(input.returnUrl !== undefined && input.cancelUrl !== undefined
        ? {
            payment_source: {
              paypal: {
                experience_context: {
                  return_url: input.returnUrl,
                  cancel_url: input.cancelUrl,
                  user_action: 'PAY_NOW' as const,
                },
              },
            },
          }
        : {}),
    };

    let response: Response;
    try {
      response = await this.#fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token.accessToken}`,
          'Content-Type': 'application/json',
          'PayPal-Request-Id': input.requestId,
        },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      throw new PayPalHttpApiError(
        'PayPal create-order request failed at the transport level',
        { cause }
      );
    }

    if (!response.ok) {
      let rawErrorBody = '';
      try {
        rawErrorBody = await response.text();
      } catch {
        // Body unreadable — fall through with empty body.
      }
      const { name, message } = extractApiErrorNameAndMessage(rawErrorBody);
      throw new PayPalHttpApiError(
        `PayPal create-order failed with HTTP status ${response.status}` +
          (name !== undefined ? ` (${name})` : ''),
        {
          status: response.status,
          paypalErrorName: name,
          paypalErrorMessage: message !== undefined ? truncate(message) : undefined,
        }
      );
    }

    // ---- Normalize the 2xx response -----------------------------------------
    let rawOkBody: string;
    try {
      rawOkBody = await response.text();
    } catch (cause) {
      throw new PayPalMalformedResponseError(
        'PayPal create-order response could not be read',
        { cause }
      );
    }

    let parsedOkJson: unknown;
    try {
      parsedOkJson = JSON.parse(rawOkBody);
    } catch {
      throw new PayPalMalformedResponseError(
        'PayPal create-order response is not valid JSON'
      );
    }

    const parsedOrder = CreateOrderResponseSchema.safeParse(parsedOkJson);
    if (!parsedOrder.success) {
      throw new PayPalMalformedResponseError(
        `PayPal create-order response failed validation: ${zodIssuesToString(parsedOrder.error)}`
      );
    }

    // Normalize the buyer-approval redirect URL. PayPal's HATEOAS links
    // observed live for the redirect approval flow use rel "approve"
    // (standard) or "payer-action" (returned instead of "approve" when
    // experience_context user_action is PAY_NOW — see Task 09 E1 evidence).
    // Both refer to the buyer-approval redirect, so both are surfaced through
    // the existing approveUrl field; "approve" wins when both are present.
    // When PayPal returns neither, approveUrl stays absent (CP2-A gap fix:
    // a payer-action-only response is no longer silently dropped).
    const approveRel = parsedOrder.data.links?.find(
      (link) => link.rel === 'approve'
    );
    const payerActionRel =
      approveRel === undefined
        ? parsedOrder.data.links?.find((link) => link.rel === 'payer-action')
        : undefined;

    return {
      paypalOrderId: parsedOrder.data.id,
      status: parsedOrder.data.status,
      environment: this.#config.environment,
      ...(approveRel !== undefined
        ? { approveUrl: approveRel.href }
        : payerActionRel !== undefined
          ? { approveUrl: payerActionRel.href }
          : {}),
      requestId: input.requestId,
    };
  }

  /**
   * Read a 2xx response body as parsed JSON with typed failure modes.
   * Shared by the Orders-API POST/GET readers; never includes the body or
   * headers in error messages (secret-safe by construction).
   */
  async #readJsonOkBody(
    label: string,
    response: Response
  ): Promise<unknown> {
    let rawOkBody: string;
    try {
      rawOkBody = await response.text();
    } catch (cause) {
      throw new PayPalMalformedResponseError(
        `PayPal ${label} response could not be read`,
        { cause }
      );
    }

    try {
      return JSON.parse(rawOkBody);
    } catch {
      throw new PayPalMalformedResponseError(
        `PayPal ${label} response is not valid JSON`
      );
    }
  }

  /**
   * POST {base}/v2/checkout/orders/{id}/capture — capture the funds of a
   * previously created, buyer-approved PayPal order.
   *
   * Discipline:
   * - Validates all inputs locally BEFORE any HTTP call.
   * - Sends the caller-supplied requestId verbatim as PayPal-Request-Id
   *   (the capture endpoint supports request-id semantics; PayPal dedupes
   *   retried captures that reuse it — but this service performs AT MOST
   *   ONE capture HTTP attempt per invocation and NEVER retries
   *   automatically: the capture side effect is a money-moving operation).
   * - Never decides WHETHER capture is allowed; that belongs to the future
   *   capture orchestrator/domain. This executes a validated provider
   *   request only, and never reads CommerceOperation/store/domain state.
   * - Transport failure is typed as PayPalHttpApiError with status
   *   undefined: the remote outcome is UNKNOWN (PayPal may have captured).
   *   Reconciliation belongs to the orchestrator via getOrder().
   *
   * @throws PayPalInvalidRequestError for pre-HTTP input problems.
   * @throws PayPalConfigurationError when credentials are absent.
   * @throws PayPalAuthenticationError when token acquisition fails.
   * @throws PayPalHttpApiError on non-2xx or transport failure.
   * @throws PayPalMalformedResponseError when a 2xx body lacks usable
   *   capture evidence (e.g. malformed amount, unsupported currency, or no
   *   captures present).
   */
  async captureOrder(
    input: CapturePayPalOrderInput
  ): Promise<PayPalCaptureOrderResult> {
    // ---- Local validation (no HTTP side effects) --------------------------
    if (
      typeof input.paypalOrderId !== 'string' ||
      input.paypalOrderId.trim().length === 0
    ) {
      throw new PayPalInvalidRequestError(
        'paypalOrderId must be a non-empty string (take it from the persisted operation.paypalOrder)'
      );
    }

    if (typeof input.requestId !== 'string' || input.requestId.trim().length === 0) {
      throw new PayPalInvalidRequestError(
        'requestId must be a non-empty string (caller-owned stable idempotency ID)'
      );
    }

    // ---- OAuth (no caching in this checkpoint) -----------------------------
    const token = await this.getAccessToken();

    // ---- Single capture attempt (never automatically retried) --------------
    const url = `${this.#config.apiBaseUrl}${PAYPAL_ORDERS_PATH}/${encodeURIComponent(
      input.paypalOrderId
    )}/capture`;

    let response: Response;
    try {
      response = await this.#fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token.accessToken}`,
          'Content-Type': 'application/json',
          'PayPal-Request-Id': input.requestId,
        },
        body: JSON.stringify({}),
      });
    } catch (cause) {
      // Transport failure: the remote outcome is UNKNOWN — PayPal may or may
      // not have captured. Typed with status undefined so orchestration can
      // distinguish ambiguity and reconcile via getOrder() instead of blindly
      // re-capturing.
      throw new PayPalHttpApiError(
        'PayPal capture request failed at the transport level (remote outcome unknown)',
        { cause }
      );
    }

    if (!response.ok) {
      let rawErrorBody = '';
      try {
        rawErrorBody = await response.text();
      } catch {
        // Body unreadable — fall through with empty body.
      }
      const { name, message } = extractApiErrorNameAndMessage(rawErrorBody);
      throw new PayPalHttpApiError(
        `PayPal capture failed with HTTP status ${response.status}` +
          (name !== undefined ? ` (${name})` : ''),
        {
          status: response.status,
          paypalErrorName: name,
          paypalErrorMessage: message !== undefined ? truncate(message) : undefined,
        }
      );
    }

    // ---- Normalize the 2xx response -----------------------------------------
    const parsedJson = await this.#readJsonOkBody('capture', response);
    const parsedOrder = CaptureOrderResponseSchema.safeParse(parsedJson);
    if (!parsedOrder.success) {
      throw new PayPalMalformedResponseError(
        `PayPal capture response failed validation: ${zodIssuesToString(parsedOrder.error)}`
      );
    }

    const captures = extractCaptures(parsedOrder.data.purchase_units, true);
    const capture = captures[0];

    return {
      paypalOrderId: parsedOrder.data.id,
      orderStatus: parsedOrder.data.status,
      capture,
      requestId: input.requestId,
      environment: this.#config.environment,
    };
  }

  /**
   * GET {base}/v2/checkout/orders/{id} — READ-ONLY reconciliation read.
   *
   * Justification (capture-ambiguity resolution): after a capture request
   * fails at the transport level, PayPal may still have captured remotely.
   * Blindly re-calling capture is forbidden. The get-order response carries
   * purchase_units[].payments.captures[] — sufficient evidence to determine
   * whether a capture exists, identify its capture ID, and read its
   * status/amount/currency — so this minimal typed read boundary is
   * implemented now.
   *
   * Discipline: read-only (no state mutation), validates the order ID before
   * HTTP, no retries, no secrets in errors, no Authorization/token leakage.
   *
   * @throws PayPalInvalidRequestError for pre-HTTP input problems.
   * @throws PayPalConfigurationError when credentials are absent.
   * @throws PayPalAuthenticationError when token acquisition fails.
   * @throws PayPalHttpApiError on non-2xx or transport failure.
   * @throws PayPalMalformedResponseError when a 2xx body is unusable.
   */
  async getOrder(
    input: { readonly paypalOrderId: string }
  ): Promise<PayPalGetOrderResult> {
    // ---- Local validation (no HTTP side effects) --------------------------
    if (
      typeof input?.paypalOrderId !== 'string' ||
      input.paypalOrderId.trim().length === 0
    ) {
      throw new PayPalInvalidRequestError(
        'paypalOrderId must be a non-empty string (take it from the persisted operation.paypalOrder)'
      );
    }

    // ---- OAuth (no caching in this checkpoint) -----------------------------
    const token = await this.getAccessToken();

    // ---- Single read attempt (never retried) -------------------------------
    const url = `${this.#config.apiBaseUrl}${PAYPAL_ORDERS_PATH}/${encodeURIComponent(
      input.paypalOrderId
    )}`;

    let response: Response;
    try {
      response = await this.#fetchImpl(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token.accessToken}`,
        },
      });
    } catch (cause) {
      throw new PayPalHttpApiError(
        'PayPal get-order request failed at the transport level',
        { cause }
      );
    }

    if (!response.ok) {
      let rawErrorBody = '';
      try {
        rawErrorBody = await response.text();
      } catch {
        // Body unreadable — fall through with empty body.
      }
      const { name, message } = extractApiErrorNameAndMessage(rawErrorBody);
      throw new PayPalHttpApiError(
        `PayPal get-order failed with HTTP status ${response.status}` +
          (name !== undefined ? ` (${name})` : ''),
        {
          status: response.status,
          paypalErrorName: name,
          paypalErrorMessage: message !== undefined ? truncate(message) : undefined,
        }
      );
    }

    // ---- Normalize the 2xx response -----------------------------------------
    const parsedJson = await this.#readJsonOkBody('get-order', response);
    const parsedOrder = GetOrderResponseSchema.safeParse(parsedJson);
    if (!parsedOrder.success) {
      throw new PayPalMalformedResponseError(
        `PayPal get-order response failed validation: ${zodIssuesToString(parsedOrder.error)}`
      );
    }

    const captures = extractCaptures(parsedOrder.data.purchase_units, false);

    return {
      paypalOrderId: parsedOrder.data.id,
      orderStatus: parsedOrder.data.status,
      captures,
    };
  }
}
