import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PayPalAuthenticationError,
  PayPalConfigurationError,
  PayPalError,
  PayPalHttpApiError,
  PayPalInvalidRequestError,
  PayPalMalformedResponseError,
  PayPalService,
  convertMinorUnitsToPayPalAmount,
  formatMinorUnitsToPayPalDecimal,
  parsePayPalAmountToMinorUnits,
  loadPayPalConfigFromEnv,
  type CapturePayPalOrderInput,
  type CreatePayPalOrderInput,
  type PayPalConfig,
  type PayPalSupportedCurrency,
} from './index';

/* ------------------------------------------------------------------ */
/* Constants: fake credentials only — never real PayPal values         */
/* ------------------------------------------------------------------ */

const CLIENT_ID = 'fake-client-id';
const CLIENT_SECRET = 'fake-client-secret';
const ACCESS_TOKEN = 'fake-access-token';
const API_BASE = 'https://paypal-mock.local';

const CONFIG: PayPalConfig = {
  environment: 'SANDBOX',
  apiBaseUrl: API_BASE,
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
};

const TOKEN_RESPONSE = { access_token: ACCESS_TOKEN, token_type: 'Bearer', expires_in: 3141 };
const ORDER_RESPONSE = {
  id: 'ORDER-123',
  status: 'CREATED',
  links: [
    { rel: 'self', href: `${API_BASE}/v2/checkout/orders/ORDER-123`, method: 'GET' },
    { rel: 'approve', href: 'https://paypal.example/approve/ORDER-123', method: 'GET' },
  ],
};

/** PayPal capture object as PayPal returns it inside purchase_units[].payments.captures[]. */
function captureObject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'CAP-123',
    status: 'COMPLETED',
    amount: { currency_code: 'USD', value: '10.50' },
    ...overrides,
  };
}

/** Capture response body: the order with its capture evidence attached. */
function captureOrderResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ORDER-123',
    status: 'COMPLETED',
    purchase_units: [{ payments: { captures: [captureObject()] } }],
    ...overrides,
  };
}

const VALID_CAPTURE_INPUT: CapturePayPalOrderInput = {
  paypalOrderId: 'ORDER-123',
  requestId: 'req-cap-001',
};

const VALID_INPUT: CreatePayPalOrderInput = {
  requestId: 'req-h-001',
  amountMinorUnits: 1050,
  currency: 'USD',
};

/* ------------------------------------------------------------------ */
/* Injected transport: records calls, replays queued responses         */
/* ------------------------------------------------------------------ */

interface RecordedCall {
  url: string;
  init: RequestInit;
}

class MockFetch {
  readonly calls: RecordedCall[] = [];
  #queue: Array<Response | Error> = [];

  queueResponse(...items: Array<Response | Error>): void {
    this.#queue.push(...items);
  }

  async fetch(url: string, init?: RequestInit): Promise<Response> {
    this.calls.push({ url, init: init ?? {} });
    const next = this.#queue.shift();
    if (next instanceof Error) throw next;
    if (next === undefined) throw new Error(`Unexpected fetch call #${this.calls.length} to ${url}`);
    return next;
  }

  call(index: number): RecordedCall {
    const call = this.calls[index];
    if (call === undefined) throw new Error(`Expected fetch call #${index} but only ${this.calls.length} recorded`);
    return call;
  }

  header(call: RecordedCall, name: string): string {
    const value = new Headers(call.init.headers).get(name);
    if (value === null) throw new Error(`Missing header ${name} on call to ${call.url}`);
    return value;
  }
}

/* ------------------------------------------------------------------ */
/* Factored helpers                                                    */
/* ------------------------------------------------------------------ */

function makeService(mock: MockFetch, config: PayPalConfig = CONFIG): PayPalService {
  return new PayPalService({ config, fetchImpl: (url, init) => mock.fetch(url, init) });
}

/** Service pre-queued with the token + order responses for one happy path. */
function happyMock(input: Array<Response | Error> = []): { mock: MockFetch; service: PayPalService } {
  const mock = new MockFetch();
  mock.queueResponse(okJson(TOKEN_RESPONSE), okJson(ORDER_RESPONSE), ...input);
  return { mock, service: makeService(mock) };
}

function okJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function okText(body: string): Response {
  return new Response(body, { status: 200 });
}

function err(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Await a promise expected to reject; return the error for field checks. */
async function failureOf(promise: Promise<unknown>): Promise<Error> {
  return (await promise.catch((error: unknown) => error)) as Error;
}

function stubPayPalEnv(overrides: Record<string, string> = {}): void {
  vi.stubEnv('PAYPAL_CLIENT_ID', CLIENT_ID);
  vi.stubEnv('PAYPAL_CLIENT_SECRET', CLIENT_SECRET);
  vi.stubEnv('PAYPAL_API_BASE', '');
  vi.stubEnv('PAYPAL_ENVIRONMENT', '');
  for (const [key, value] of Object.entries(overrides)) vi.stubEnv(key, value);
}

/** Parse the create-order request body from calls[1]. */
function orderBody(mock: MockFetch): {
  intent: string;
  purchase_units: Array<{ amount: { currency_code: string; value: string }; custom_id?: string }>;
} {
  return JSON.parse(String(mock.call(1).init.body));
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/* A. Configuration                                                    */
/* ------------------------------------------------------------------ */

describe('configuration (A)', () => {
  it('fails clearly when PAYPAL_CLIENT_ID is missing, naming the variable not the value', () => {
    stubPayPalEnv({ PAYPAL_CLIENT_ID: '' });
    expect(() => loadPayPalConfigFromEnv()).toThrow(PayPalConfigurationError);
    expect(() => loadPayPalConfigFromEnv()).toThrow(/PAYPAL_CLIENT_ID/);
    expect(() => loadPayPalConfigFromEnv()).not.toThrow(/fake-client-id/);
  });

  it('fails clearly when PAYPAL_CLIENT_SECRET is missing', () => {
    stubPayPalEnv({ PAYPAL_CLIENT_SECRET: '' });
    expect(() => loadPayPalConfigFromEnv()).toThrow(PayPalConfigurationError);
    expect(() => loadPayPalConfigFromEnv()).toThrow(/PAYPAL_CLIENT_SECRET/);
  });

  it('defaults to the Sandbox base URL when no override is set', () => {
    stubPayPalEnv();
    const config = loadPayPalConfigFromEnv();
    expect(config.environment).toBe('SANDBOX');
    expect(config.apiBaseUrl).toBe('https://api-m.sandbox.paypal.com');
  });

  it('PayPalService refuses OAuth without credentials before any HTTP call', async () => {
    const mock = new MockFetch();
    const service = makeService(mock, { environment: 'SANDBOX', apiBaseUrl: API_BASE, clientId: '', clientSecret: '' });
    const error = await failureOf(service.getAccessToken());
    expect(error).toBeInstanceOf(PayPalConfigurationError);
    expect(mock.calls.length).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* G. Money conversion                                                 */
/* ------------------------------------------------------------------ */

describe('money conversion (G)', () => {
  it('converts integer cents to exact PayPal decimal strings, including a large value', () => {
    expect(formatMinorUnitsToPayPalDecimal(1, 2)).toBe('0.01');
    expect(formatMinorUnitsToPayPalDecimal(10, 2)).toBe('0.10');
    expect(formatMinorUnitsToPayPalDecimal(105, 2)).toBe('1.05');
    expect(formatMinorUnitsToPayPalDecimal(5000, 2)).toBe('50.00');
    expect(formatMinorUnitsToPayPalDecimal(123456789, 2)).toBe('1234567.89');
    expect(convertMinorUnitsToPayPalAmount('USD', 1050)).toBe('10.50');
    expect(convertMinorUnitsToPayPalAmount('JPY', 500)).toBe('500'); // 0-decimal currency
  });

  it('rejects non-integer, unsafe, and invalid inputs with TypeError', () => {
    expect(() => formatMinorUnitsToPayPalDecimal(1.5, 2)).toThrow(TypeError);
    expect(() => formatMinorUnitsToPayPalDecimal(Number.MAX_SAFE_INTEGER + 1, 2)).toThrow(TypeError);
    expect(() => formatMinorUnitsToPayPalDecimal(100, 1.5)).toThrow(TypeError);
  });
});

/* ------------------------------------------------------------------ */
/* G2. Deterministic PayPal amount parsing (capture/read evidence)      */
/* ------------------------------------------------------------------ */

describe('PayPal amount parsing (G2, deterministic — no floating point)', () => {
  it('parses amount strings to exact integer minor units (round-trips with the formatter)', () => {
    expect(parsePayPalAmountToMinorUnits('10.50', 'USD')).toBe(1050);
    expect(parsePayPalAmountToMinorUnits('0.01', 'USD')).toBe(1);
    expect(parsePayPalAmountToMinorUnits('0.1', 'USD')).toBe(10);
    expect(parsePayPalAmountToMinorUnits('105', 'USD')).toBe(10500);
    expect(parsePayPalAmountToMinorUnits('1234567.89', 'USD')).toBe(123456789);
    expect(parsePayPalAmountToMinorUnits('500', 'JPY')).toBe(500); // 0-decimal currency
  });

  it('rejects malformed amounts deterministically', () => {
    const bad = ['10.505', '', 'abc', '1,050', ' 10.50', '10.50 ', '+10.50', '-10.50', '1e3', '.50', '10.', '10.5.0'];
    for (const value of bad) {
      expect(() => parsePayPalAmountToMinorUnits(value, 'USD'), `expected rejection: ${JSON.stringify(value)}`).toThrow(
        RangeError
      );
    }
  });

  it('rejects fractional digits beyond the currency precision (including JPY fractions)', () => {
    expect(() => parsePayPalAmountToMinorUnits('500.50', 'JPY')).toThrow(RangeError);
    expect(() => parsePayPalAmountToMinorUnits('10.505', 'EUR')).toThrow(RangeError);
  });

  it('rejects non-string amounts and unsupported currencies with TypeError', () => {
    expect(() => parsePayPalAmountToMinorUnits(10.5 as unknown as string, 'USD')).toThrow(TypeError);
    expect(() => parsePayPalAmountToMinorUnits('10.50', 'CHF' as unknown as PayPalSupportedCurrency)).toThrow(TypeError);
  });

  it('rejects values too large for safe integer arithmetic', () => {
    expect(() => parsePayPalAmountToMinorUnits('1234567890123456.78', 'USD')).toThrow(RangeError);
    // 13 digits (11 integer + 2 fraction) stays safely inside 2^53.
    expect(parsePayPalAmountToMinorUnits('12345678901.23', 'USD')).toBe(1234567890123);
  });

  it('round-trips with the formatter for every supported currency', () => {
    const samples: Array<[PayPalSupportedCurrency, number]> = [
      ['USD', 1],
      ['USD', 1050],
      ['USD', 123456789],
      ['EUR', 99],
      ['GBP', 123456],
      ['CAD', 7],
      ['JPY', 500],
      ['JPY', 1],
    ];
    for (const [currency, minorUnits] of samples) {
      const formatted = convertMinorUnitsToPayPalAmount(currency, minorUnits);
      expect(parsePayPalAmountToMinorUnits(formatted, currency), `${currency} ${formatted}`).toBe(minorUnits);
    }
  });
});

/* ------------------------------------------------------------------ */
/* B/C/D/E. OAuth                                                      */
/* ------------------------------------------------------------------ */

describe('OAuth token acquisition (B, C, D, E)', () => {
  const EXPECTED_BASIC = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`, 'utf8').toString('base64');

  it('POSTs the token endpoint with Basic auth and grant_type=client_credentials (B, C)', async () => {
    const { mock, service } = happyMock();
    const token = await service.getAccessToken();

    expect(mock.calls.length).toBe(1);
    const call = mock.call(0);
    expect(call.url).toBe(`${API_BASE}/v1/oauth2/token`);
    expect(call.init.method).toBe('POST');
    expect(call.init.body).toBe('grant_type=client_credentials');
    expect(mock.header(call, 'Content-Type')).toBe('application/x-www-form-urlencoded');
    expect(mock.header(call, 'Authorization')).toBe(`Basic ${EXPECTED_BASIC}`);
    expect(token).toEqual({ accessToken: ACCESS_TOKEN, tokenType: 'Bearer', expiresInSeconds: 3141 });
  });

  it('never exposes credentials in auth errors (C)', async () => {
    const transportMock = new MockFetch();
    transportMock.queueResponse(new Error('ECONNREFUSED'));
    const transportError = await failureOf(makeService(transportMock).getAccessToken());
    expect(transportError).toBeInstanceOf(PayPalAuthenticationError);
    expect(transportError.message).not.toContain(CLIENT_SECRET);
    expect(transportError.message).not.toContain('Basic ');

    const httpMock = new MockFetch();
    httpMock.queueResponse(
      err(401, { error: 'invalid_client', error_description: `client secret is wrong: ${CLIENT_SECRET}` })
    );
    const httpError = await failureOf(makeService(httpMock).getAccessToken());
    expect(httpError).toBeInstanceOf(PayPalAuthenticationError);
    expect(httpError.message).not.toContain(CLIENT_SECRET);
    expect(httpError.message).not.toContain('invalid_client');
    expect(httpError.message).not.toContain('Basic ');
  });

  it('maps OAuth non-2xx to PayPalAuthenticationError carrying the status (D)', async () => {
    const mock = new MockFetch();
    mock.queueResponse(err(401, { error: 'invalid_client' }));
    const error = await failureOf(makeService(mock).getAccessToken());
    expect(error).toBeInstanceOf(PayPalAuthenticationError);
    expect(error).toBeInstanceOf(PayPalError);
    expect((error as PayPalAuthenticationError).status).toBe(401);
  });

  it('rejects malformed token responses (E)', async () => {
    const cases: Array<Response | Error>[] = [
      [okText('not-json')],
      [okJson({ token_type: 'Bearer', expires_in: 3600 })], // missing access_token
      [okJson({ access_token: ACCESS_TOKEN, token_type: 'Bearer', expires_in: 0 })], // invalid expires_in
    ];
    for (const [response] of cases) {
      const mock = new MockFetch();
      mock.queueResponse(response);
      await expect(makeService(mock).getAccessToken()).rejects.toBeInstanceOf(PayPalMalformedResponseError);
    }
  });
});

/* ------------------------------------------------------------------ */
/* F/H/L. Create-order happy path                                      */
/* ------------------------------------------------------------------ */

describe('create-order happy path (F, H, L)', () => {
  it('calls OAuth first (calls[0]) and Orders second (calls[1]) with the exact body (F)', async () => {
    const { mock, service } = happyMock();
    await service.createOrder({
      requestId: 'req-f-001',
      amountMinorUnits: 1050,
      currency: 'USD',
      commerceOperationId: 'op-1',
    });

    expect(mock.calls.length).toBe(2);

    const tokenCall = mock.call(0);
    expect(tokenCall.url).toBe(`${API_BASE}/v1/oauth2/token`);
    expect(tokenCall.init.method).toBe('POST');

    const orderCall = mock.call(1);
    expect(orderCall.url).toBe(`${API_BASE}/v2/checkout/orders`);
    expect(orderCall.init.method).toBe('POST');

    const body = orderBody(mock);
    expect(body.intent).toBe('CAPTURE');
    expect(body.purchase_units.length).toBe(1);
    expect(body.purchase_units[0].amount.currency_code).toBe('USD');
    expect(body.purchase_units[0].amount.value).toBe('10.50'); // exact decimal from 1050 cents
    expect(body.purchase_units[0].custom_id).toBe('op-1');
  });

  it('omits custom_id when commerceOperationId is not supplied (F)', async () => {
    const { mock, service } = happyMock();
    await service.createOrder({ requestId: 'req-f-002', amountMinorUnits: 105, currency: 'USD' });
    const unit = orderBody(mock).purchase_units[0];
    expect(unit.custom_id).toBeUndefined();
    expect('custom_id' in unit).toBe(false);
  });

  it('sends the caller-supplied PayPal-Request-Id verbatim on the Orders call (H)', async () => {
    const { mock } = happyMock();
    await makeService(mock).createOrder({
      requestId: 'op-1-create-001',
      amountMinorUnits: 1050,
      currency: 'USD',
    });
    const orderCall = mock.call(1);
    expect(mock.header(orderCall, 'PayPal-Request-Id')).toBe('op-1-create-001');
    expect(mock.header(orderCall, 'Authorization')).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(mock.header(orderCall, 'Content-Type')).toBe('application/json');
  });

  it('returns a normalized result with only CommercePilot-owned fields (L)', async () => {
    const { service } = happyMock();
    const result = await service.createOrder({
      requestId: 'req-l-001',
      amountMinorUnits: 105,
      currency: 'USD',
      commerceOperationId: 'op-1',
    });

    expect(Object.keys(result).sort()).toEqual(['approveUrl', 'environment', 'paypalOrderId', 'requestId', 'status']);
    expect(result).toEqual({
      paypalOrderId: 'ORDER-123',
      status: 'CREATED',
      environment: 'SANDBOX',
      approveUrl: 'https://paypal.example/approve/ORDER-123',
      requestId: 'req-l-001',
    });
  });

  it('omits approveUrl when PayPal returns no approve link (L)', async () => {
    const mock = new MockFetch();
    mock.queueResponse(okJson(TOKEN_RESPONSE), okJson({ id: 'ORDER-123', status: 'CREATED' }));
    const result = await makeService(mock).createOrder({ requestId: 'req-l-002', amountMinorUnits: 105, currency: 'USD' });
    expect(Object.keys(result).sort()).toEqual(['environment', 'paypalOrderId', 'requestId', 'status']);
  });
});

/* ------------------------------------------------------------------ */
/* I. Pre-HTTP validation                                              */
/* ------------------------------------------------------------------ */

describe('pre-HTTP validation (I)', () => {
  it.each([
    ['empty requestId', { requestId: '', amountMinorUnits: 1050, currency: 'USD' }],
    ['whitespace-only requestId', { requestId: '   ', amountMinorUnits: 1050, currency: 'USD' }],
    ['non-integer amount', { requestId: 'req-i-003', amountMinorUnits: 10.5, currency: 'USD' }],
    ['unsupported currency', { requestId: 'req-i-004', amountMinorUnits: 1050, currency: 'CHF' as unknown as PayPalSupportedCurrency }],
  ] as Array<[string, CreatePayPalOrderInput]>)(
    'rejects %s with PayPalInvalidRequestError before any HTTP call',
    async (_label, input) => {
      const mock = new MockFetch();
      const error = await failureOf(makeService(mock).createOrder(input));
      expect(error).toBeInstanceOf(PayPalInvalidRequestError);
      expect(mock.calls.length).toBe(0);
    }
  );
});

/* ------------------------------------------------------------------ */
/* CP5A2 FIX. Redirect approval flow — payment_source.paypal.          */
/* experience_context with return_url / cancel_url / user_action.      */
/* All tests are OFFLINE: scripted MockFetch only, never the network.  */
/* ------------------------------------------------------------------ */

const HTTPS_RETURN_URL = 'https://commercepilot.example/paypal/return';
const HTTPS_CANCEL_URL = 'https://commercepilot.example/paypal/cancel';

describe('create-order redirect approval flow (CP5A2 FIX)', () => {
  it('sends payment_source.paypal.experience_context when BOTH URLs are supplied (CP5A2 1)', async () => {
    const { mock } = happyMock();
    await makeService(mock).createOrder({
      requestId: 'req-cp5a2-001',
      amountMinorUnits: 100,
      currency: 'USD',
      returnUrl: HTTPS_RETURN_URL,
      cancelUrl: HTTPS_CANCEL_URL,
    });

    expect(mock.calls.length).toBe(2); // OAuth + exactly one create-order
    const body = orderBody(mock) as Record<string, unknown>;
    // The deprecated top-level application_context form is never sent.
    expect('application_context' in body).toBe(false);

    const paymentSource = body.payment_source as Record<string, unknown>;
    const paypal = paymentSource.paypal as Record<string, unknown>;
    const experienceContext = paypal.experience_context as Record<string, unknown>;
    expect(experienceContext.return_url).toBe(HTTPS_RETURN_URL);
    expect(experienceContext.cancel_url).toBe(HTTPS_CANCEL_URL);
    expect(experienceContext.user_action).toBe('PAY_NOW');
  });

  it('omits payment_source entirely when NEITHER URL is supplied — backward compatible (CP5A2 2)', async () => {
    const { mock } = happyMock();
    await makeService(mock).createOrder({
      requestId: 'req-cp5a2-002',
      amountMinorUnits: 100,
      currency: 'USD',
      commerceOperationId: 'op-1',
    });

    expect(mock.calls.length).toBe(2);
    const body = orderBody(mock) as Record<string, unknown>;
    expect('payment_source' in body).toBe(false);
    expect('application_context' in body).toBe(false);
    // The request body is exactly as before this change.
    expect(body.intent).toBe('CAPTURE');
    expect(body.purchase_units).toEqual([
      { amount: { currency_code: 'USD', value: '1.00' }, custom_id: 'op-1' },
    ]);
  });

  it.each([
    ['returnUrl only (half-configured)', { returnUrl: HTTPS_RETURN_URL }],
    ['cancelUrl only (half-configured)', { cancelUrl: HTTPS_CANCEL_URL }],
    ['malformed returnUrl', { returnUrl: 'not-a-valid-url', cancelUrl: HTTPS_CANCEL_URL }],
    ['malformed cancelUrl', { returnUrl: HTTPS_RETURN_URL, cancelUrl: 'http://[invalid' }],
    [
      'HTTP (non-HTTPS) returnUrl',
      { returnUrl: 'http://commercepilot.example/paypal/return', cancelUrl: HTTPS_CANCEL_URL },
    ],
    [
      'HTTP (non-HTTPS) cancelUrl',
      { returnUrl: HTTPS_RETURN_URL, cancelUrl: 'http://commercepilot.example/paypal/cancel' },
    ],
  ] as Array<[string, Partial<CreatePayPalOrderInput>]>)(
    'rejects %s with PayPalInvalidRequestError BEFORE any network call (CP5A2 3-8)',
    async (_label, overrides) => {
      const mock = new MockFetch(); // no queued responses: any HTTP attempt fails loudly
      const error = await failureOf(
        makeService(mock).createOrder({
          requestId: 'req-cp5a2-003',
          amountMinorUnits: 100,
          currency: 'USD',
          ...overrides,
        } as CreatePayPalOrderInput)
      );
      expect(error).toBeInstanceOf(PayPalInvalidRequestError);
      expect(mock.calls.length).toBe(0); // zero network calls — rejected pre-HTTP
    }
  );

  it('rejects half-configured pairing with the exact contract message (CP5A2 3/4)', async () => {
    const mock = new MockFetch();
    const error = await failureOf(
      makeService(mock).createOrder({
        requestId: 'req-cp5a2-004',
        amountMinorUnits: 100,
        currency: 'USD',
        returnUrl: HTTPS_RETURN_URL, // cancelUrl missing → pairing violation
      })
    );
    expect(error).toBeInstanceOf(PayPalInvalidRequestError);
    expect(error.message).toContain(
      'returnUrl and cancelUrl must be supplied together or both omitted'
    );
    expect(mock.calls.length).toBe(0);
  });

  it('does not silently normalize invalid URL values (CP5A2 5-8)', async () => {
    // Upper-case non-HTTPS scheme must be rejected as-is, never corrected.
    const mock = new MockFetch();
    const error = await failureOf(
      makeService(mock).createOrder({
        requestId: 'req-cp5a2-005',
        amountMinorUnits: 100,
        currency: 'USD',
        returnUrl: 'HTTP://commercepilot.example/paypal/return',
        cancelUrl: HTTPS_CANCEL_URL,
      })
    );
    expect(error).toBeInstanceOf(PayPalInvalidRequestError);
    expect(mock.calls.length).toBe(0);
  });

  it('validation errors name the field but never echo the URL value or credentials (CP5A2 9)', async () => {
    const cases: Array<CreatePayPalOrderInput> = [
      {
        requestId: 'req-cp5a2-006',
        amountMinorUnits: 100,
        currency: 'USD',
        returnUrl: `not-a-url-${CLIENT_SECRET}`,
        cancelUrl: HTTPS_CANCEL_URL,
      },
      {
        requestId: 'req-cp5a2-007',
        amountMinorUnits: 100,
        currency: 'USD',
        returnUrl: `http://leak.example/${CLIENT_SECRET}`,
        cancelUrl: HTTPS_CANCEL_URL,
      },
      {
        requestId: 'req-cp5a2-008',
        amountMinorUnits: 100,
        currency: 'USD',
        returnUrl: `https://pay.example/${CLIENT_SECRET}/${ACCESS_TOKEN}`,
        cancelUrl: 'ht!tp://not a url',
      },
    ];
    for (const input of cases) {
      const mock = new MockFetch();
      const error = await failureOf(makeService(mock).createOrder(input));
      expect(error).toBeInstanceOf(PayPalInvalidRequestError);
      const serialized = `${error.name}: ${error.message}`;
      expect(serialized).not.toContain(CLIENT_SECRET);
      expect(serialized).not.toContain(ACCESS_TOKEN);
      expect(serialized).not.toContain('not-a-url'); // invalid values never echoed
      expect(serialized).not.toContain('leak.example'); // invalid values never echoed
      expect(serialized).not.toContain('pay.example'); // invalid values never echoed
      expect(mock.calls.length).toBe(0);
    }
  });

  it('accepts structurally valid HTTPS URLs verbatim; any later failure still exposes no secrets (CP5A2 9b)', async () => {
    // A credential-bearing but structurally VALID https:// URL is not a URL
    // validation failure: the service must not over-reject it, and it must
    // never echo its value in any error either.
    const mock = new MockFetch(); // nothing queued: OAuth transport fails
    const credentialBearingUrl = `https://user:${CLIENT_SECRET}@pay.example/return?secret=${CLIENT_SECRET}&token=${ACCESS_TOKEN}`;
    const error = await failureOf(
      makeService(mock).createOrder({
        requestId: 'req-cp5a2-009',
        amountMinorUnits: 100,
        currency: 'USD',
        returnUrl: credentialBearingUrl,
        cancelUrl: HTTPS_CANCEL_URL,
      })
    );
    // Validation passed; the failure came from the (failing) transport only.
    expect(error).toBeInstanceOf(PayPalAuthenticationError);
    expect(mock.calls.length).toBe(1); // OAuth attempted, create-order never reached
    const serialized = `${error.name}: ${error.message}`;
    expect(serialized).not.toContain(CLIENT_SECRET);
    expect(serialized).not.toContain(ACCESS_TOKEN);
    expect(serialized).not.toContain('user:'); // credential fragments never echoed
  });
});

/* ------------------------------------------------------------------ */
/* Task 10 CP2 (A). Payer-action link normalization.                   */
/* Live evidence (Task 09 E1): with experience_context user_action     */
/* PAY_NOW, PayPal can return rel "payer-action" INSTEAD of "approve". */
/* Both carry the buyer-approval redirect URL; a payer-action-only     */
/* response must no longer be silently dropped. Offline tests only.    */
/* ------------------------------------------------------------------ */

/** Create-order response body with only the given HATEOAS links. */
function orderResponseWithLinks(
  links: Array<{ rel: string; href: string; method?: string }>
): Record<string, unknown> {
  return { id: 'ORDER-PA-1', status: 'CREATED', links };
}

function happyMockWithOrderResponse(orderResponse: Record<string, unknown>): { mock: MockFetch; service: PayPalService } {
  const mock = new MockFetch();
  mock.queueResponse(okJson(TOKEN_RESPONSE), okJson(orderResponse));
  return { mock, service: makeService(mock) };
}

describe('create-order approve/payer-action normalization (Task 10 CP2 A)', () => {
  it('normalizes a payer-action-only response into approveUrl (CP2-A gap fix)', async () => {
    // Exact live-observed shape from Task 09 E1: rel "payer-action",
    // NO rel "approve" — previously the URL was silently dropped.
    const { service } = happyMockWithOrderResponse(
      orderResponseWithLinks([
        {
          rel: 'self',
          href: 'https://api-m.sandbox.paypal.com/v2/checkout/orders/ORDER-PA-1',
          method: 'GET',
        },
        {
          rel: 'payer-action',
          href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER-PA-1',
          method: 'GET',
        },
      ])
    );
    const result = await service.createOrder({
      requestId: 'req-cp2a-001',
      amountMinorUnits: 100,
      currency: 'USD',
      returnUrl: HTTPS_RETURN_URL,
      cancelUrl: HTTPS_CANCEL_URL,
    });

    expect(result.approveUrl).toBe('https://www.sandbox.paypal.com/checkoutnow?token=ORDER-PA-1');
    // Everything else is unchanged.
    expect(result).toEqual({
      paypalOrderId: 'ORDER-PA-1',
      status: 'CREATED',
      environment: 'SANDBOX',
      approveUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER-PA-1',
      requestId: 'req-cp2a-001',
    });
  });

  it('prefers the approve link when both approve and payer-action are present', async () => {
    const { service } = happyMockWithOrderResponse(
      orderResponseWithLinks([
        { rel: 'approve', href: 'https://paypal.example/approve/ORDER-PA-1', method: 'GET' },
        { rel: 'payer-action', href: 'https://paypal.example/payer-action/ORDER-PA-1', method: 'GET' },
      ])
    );
    const result = await service.createOrder({
      requestId: 'req-cp2a-002',
      amountMinorUnits: 100,
      currency: 'USD',
    });
    expect(result.approveUrl).toBe('https://paypal.example/approve/ORDER-PA-1');
  });

  it('still surfaces a plain approve-only response unchanged (backward compatible)', async () => {
    const { service } = happyMockWithOrderResponse(
      orderResponseWithLinks([
        { rel: 'approve', href: 'https://paypal.example/approve/ORDER-PA-1', method: 'GET' },
      ])
    );
    const result = await service.createOrder({
      requestId: 'req-cp2a-003',
      amountMinorUnits: 100,
      currency: 'USD',
    });
    expect(result.approveUrl).toBe('https://paypal.example/approve/ORDER-PA-1');
  });

  it('leaves approveUrl absent when neither link is present (unchanged behavior)', async () => {
    const { service } = happyMockWithOrderResponse(
      orderResponseWithLinks([
        { rel: 'self', href: 'https://paypal.example/orders/ORDER-PA-1', method: 'GET' },
      ])
    );
    const result = await service.createOrder({
      requestId: 'req-cp2a-004',
      amountMinorUnits: 100,
      currency: 'USD',
    });
    expect(result.approveUrl).toBeUndefined();
    expect('approveUrl' in result).toBe(false);
  });

  it('ignores unrelated link rels and does not let them become approveUrl', async () => {
    const { service } = happyMockWithOrderResponse(
      orderResponseWithLinks([
        { rel: 'update', href: 'https://paypal.example/update/ORDER-PA-1', method: 'PATCH' },
        { rel: 'capture', href: 'https://paypal.example/capture/ORDER-PA-1', method: 'POST' },
      ])
    );
    const result = await service.createOrder({
      requestId: 'req-cp2a-005',
      amountMinorUnits: 100,
      currency: 'USD',
    });
    expect(result.approveUrl).toBeUndefined();
    expect(result.status).toBe('CREATED');
    expect(result.paypalOrderId).toBe('ORDER-PA-1');
  });
});

/* ------------------------------------------------------------------ */
/* J/K. Create-order error handling                                    */
/* ------------------------------------------------------------------ */

describe('create-order error handling (J, K)', () => {
  it('maps a 400 create-order response to PayPalHttpApiError without leaking secrets (J)', async () => {
    const mock = new MockFetch();
    mock.queueResponse(
      okJson(TOKEN_RESPONSE),
      err(400, { name: 'INVALID_REQUEST', message: 'Purchase unit amount is invalid.' })
    );
    const error = (await failureOf(makeService(mock).createOrder(VALID_INPUT))) as PayPalHttpApiError;

    expect(error).toBeInstanceOf(PayPalHttpApiError);
    expect(error).toBeInstanceOf(PayPalError);
    expect(error.status).toBe(400);
    expect(error.paypalErrorName).toBe('INVALID_REQUEST');
    expect(error.paypalErrorMessage).toBe('Purchase unit amount is invalid.');
    expect(error.message).toContain('400');
    expect(error.message).not.toContain(ACCESS_TOKEN);
    expect(error.message).not.toContain(CLIENT_SECRET);
    expect(error.message).not.toContain('Bearer ');
  });

  it('handles non-JSON create-order error bodies explicitly (J)', async () => {
    const mock = new MockFetch();
    mock.queueResponse(okJson(TOKEN_RESPONSE), err(500, 'Internal Server Error'));
    const error = (await failureOf(makeService(mock).createOrder(VALID_INPUT))) as PayPalHttpApiError;
    expect(error).toBeInstanceOf(PayPalHttpApiError);
    expect(error.status).toBe(500);
    expect(error.paypalErrorName).toBeUndefined();
    expect(error.paypalErrorMessage).toBeUndefined();
  });

  it('maps a create-order transport failure to PayPalHttpApiError (J)', async () => {
    const mock = new MockFetch();
    mock.queueResponse(okJson(TOKEN_RESPONSE), new Error('ECONNRESET'));
    await expect(makeService(mock).createOrder(VALID_INPUT)).rejects.toBeInstanceOf(PayPalHttpApiError);
  });

  it('rejects malformed create-order responses (K)', async () => {
    const cases: Response[][] = [
      [okJson(TOKEN_RESPONSE), okJson({ status: 'CREATED' })], // missing id
      [okJson(TOKEN_RESPONSE), okJson({ id: 123, status: 'CREATED' })], // wrong types
      [okJson(TOKEN_RESPONSE), okText('not-json')], // not JSON
    ];
    for (const responses of cases) {
      const mock = new MockFetch();
      mock.queueResponse(...responses);
      await expect(makeService(mock).createOrder(VALID_INPUT)).rejects.toBeInstanceOf(PayPalMalformedResponseError);
    }
  });
});

/* ------------------------------------------------------------------ */
/* M. Idempotency                                                      */
/* ------------------------------------------------------------------ */

describe('idempotency (M)', () => {
  it('retrying with the same caller requestId sends the same PayPal-Request-Id', async () => {
    const mock = new MockFetch();
    mock.queueResponse(
      okJson(TOKEN_RESPONSE),
      okJson(ORDER_RESPONSE),
      okJson(TOKEN_RESPONSE),
      okJson(ORDER_RESPONSE)
    );
    const service = makeService(mock);
    const input: CreatePayPalOrderInput = { requestId: 'stable-req-001', amountMinorUnits: 5000, currency: 'USD' };

    await service.createOrder(input);
    await service.createOrder(input);

    expect(mock.calls.length).toBe(4);
    expect(mock.header(mock.call(1), 'PayPal-Request-Id')).toBe('stable-req-001');
    expect(mock.header(mock.call(3), 'PayPal-Request-Id')).toBe('stable-req-001');
    expect(mock.call(1).url).toBe(mock.call(3).url);
  });
});

/* ------------------------------------------------------------------ */
/* N. No real credentials, no network                                  */
/* ------------------------------------------------------------------ */

describe('transport isolation (N)', () => {
  it('uses only the injected transport — global fetch is never called', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { mock, service } = happyMock();

    await service.createOrder(VALID_INPUT);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mock.calls.length).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* CP3. Capture endpoint, OAuth and caller request ID                   */
/* ------------------------------------------------------------------ */

describe('captureOrder — endpoint, OAuth, request ID (CP3 1-3)', () => {
  it('POSTs exactly {base}/v2/checkout/orders/{id}/capture with OAuth + verbatim PayPal-Request-Id', async () => {
    const mock = new MockFetch();
    mock.queueResponse(okJson(TOKEN_RESPONSE), okJson(captureOrderResponse()));
    const result = await makeService(mock).captureOrder({
      paypalOrderId: 'ORDER-123',
      requestId: 'op-1-capture-001',
    });

    expect(mock.calls.length).toBe(2);
    const captureCall = mock.call(1);
    expect(captureCall.url).toBe(`${API_BASE}/v2/checkout/orders/ORDER-123/capture`);
    expect(captureCall.init.method).toBe('POST');
    expect(mock.header(captureCall, 'Authorization')).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(mock.header(captureCall, 'Content-Type')).toBe('application/json');
    expect(mock.header(captureCall, 'PayPal-Request-Id')).toBe('op-1-capture-001');
    expect(captureCall.init.body).toBe(JSON.stringify({}));
    expect(result.requestId).toBe('op-1-capture-001');
  });

  it('URL-encodes the PayPal order ID path segment', async () => {
    const mock = new MockFetch();
    mock.queueResponse(
      okJson(TOKEN_RESPONSE),
      okJson(captureOrderResponse({ id: 'ORDER 42/1' }))
    );
    await makeService(mock).captureOrder({ paypalOrderId: 'ORDER 42/1', requestId: 'req-enc-001' });
    expect(mock.call(1).url).toBe(`${API_BASE}/v2/checkout/orders/ORDER%2042%2F1/capture`);
  });

  it('fails as configuration error (zero capture HTTP calls) when credentials are absent', async () => {
    const mock = new MockFetch();
    const service = makeService(mock, { environment: 'SANDBOX', apiBaseUrl: API_BASE, clientId: '', clientSecret: '' });
    const error = await failureOf(service.captureOrder(VALID_CAPTURE_INPUT));
    expect(error).toBeInstanceOf(PayPalConfigurationError);
    expect(mock.calls.length).toBe(0);
  });

  it('does not send the Authorization header anywhere on validation failure', async () => {
    const mock = new MockFetch();
    await failureOf(
      makeService(mock).captureOrder({ paypalOrderId: '', requestId: 'req-noauth-001' })
    );
    expect(mock.calls.length).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* CP3. Capture response normalization                                  */
/* ------------------------------------------------------------------ */

describe('captureOrder — response normalization (CP3 4-8)', () => {
  it('normalizes a valid COMPLETED capture response with exact evidence', async () => {
    const mock = new MockFetch();
    mock.queueResponse(
      okJson(TOKEN_RESPONSE),
      okJson(captureOrderResponse({ id: 'ORDER-999', status: 'COMPLETED' }))
    );
    const result = await makeService(mock).captureOrder(VALID_CAPTURE_INPUT);

    expect(result).toEqual({
      paypalOrderId: 'ORDER-999',
      orderStatus: 'COMPLETED',
      capture: {
        captureId: 'CAP-123',
        status: 'COMPLETED',
        amountMinorUnits: 1050, // from "10.50" — deterministic, no floats
        currency: 'USD',
      },
      requestId: 'req-cap-001',
      environment: 'SANDBOX',
    });
  });

  it('normalizes a zero-decimal (JPY) capture amount deterministically', async () => {
    const mock = new MockFetch();
    mock.queueResponse(
      okJson(TOKEN_RESPONSE),
      okJson(
        captureOrderResponse({
          purchase_units: [
            {
              payments: {
                captures: [
                  captureObject({ amount: { currency_code: 'JPY', value: '500' } }),
                ],
              },
            },
          ],
        })
      )
    );
    const result = await makeService(mock).captureOrder(VALID_CAPTURE_INPUT);
    expect(result.capture.amountMinorUnits).toBe(500);
    expect(result.capture.currency).toBe('JPY');
  });

  it('extracts the capture ID exactly as PayPal reported it', async () => {
    const mock = new MockFetch();
    mock.queueResponse(
      okJson(TOKEN_RESPONSE),
      okJson(
        captureOrderResponse({
          purchase_units: [
            { payments: { captures: [captureObject({ id: '8XA123456V1234567' })] } },
          ],
        })
      )
    );
    const result = await makeService(mock).captureOrder(VALID_CAPTURE_INPUT);
    expect(result.capture.captureId).toBe('8XA123456V1234567');
  });

  it('ignores unknown extra PayPal fields (passthrough) while preserving exact evidence keys', async () => {
    const mock = new MockFetch();
    mock.queueResponse(
      okJson(TOKEN_RESPONSE),
      okJson(
        captureOrderResponse({
          purchase_units: [
            {
              reference_id: 'pu-1',
              payments: {
                captures: [
                  captureObject({
                    final_capture: true,
                    seller_protection: { status: 'ELIGIBLE' },
                    create_time: '2026-10-15T00:00:00Z',
                    update_time: '2026-10-15T00:00:01Z',
                  }),
                ],
              },
            },
          ],
        })
      )
    );
    const result = await makeService(mock).captureOrder(VALID_CAPTURE_INPUT);
    expect(Object.keys(result.capture).sort()).toEqual(['amountMinorUnits', 'captureId', 'currency', 'status']);
    expect(Object.keys(result).sort()).toEqual([
      'capture',
      'environment',
      'orderStatus',
      'paypalOrderId',
      'requestId',
    ]);
  });

  it('rejects a malformed capture amount as PayPalMalformedResponseError', async () => {
    for (const amount of [
      { currency_code: 'USD', value: '10.505' }, // 3 fraction digits
      { currency_code: 'USD', value: 'abc' },
      { currency_code: 'USD', value: 10.5 }, // non-string type
      { currency_code: 'JPY', value: '500.50' }, // fractions on 0-decimal currency
    ]) {
      const mock = new MockFetch();
      mock.queueResponse(
        okJson(TOKEN_RESPONSE),
        okJson(
          captureOrderResponse({
            purchase_units: [{ payments: { captures: [captureObject({ amount })] } }],
          })
        )
      );
      const error = await failureOf(makeService(mock).captureOrder(VALID_CAPTURE_INPUT));
      expect(error, JSON.stringify(amount)).toBeInstanceOf(PayPalMalformedResponseError);
    }
  });

  it('rejects an unsupported capture currency as PayPalMalformedResponseError', async () => {
    const mock = new MockFetch();
    mock.queueResponse(
      okJson(TOKEN_RESPONSE),
      okJson(
        captureOrderResponse({
          purchase_units: [
            {
              payments: {
                captures: [
                  captureObject({ amount: { currency_code: 'CHF', value: '10.50' } }),
                ],
              },
            },
          ],
        })
      )
    );
    const error = await failureOf(makeService(mock).captureOrder(VALID_CAPTURE_INPUT));
    expect(error).toBeInstanceOf(PayPalMalformedResponseError);
  });

  it('rejects a capture response with missing capture evidence', async () => {
    const cases: unknown[] = [
      { id: 'ORDER-123', status: 'COMPLETED', purchase_units: [{ payments: { captures: [] } }] },
      { id: 'ORDER-123', status: 'COMPLETED', purchase_units: [{}] },
      { id: 'ORDER-123', status: 'COMPLETED', purchase_units: [] },
      { id: 'ORDER-123', status: 'COMPLETED' },
      { status: 'COMPLETED', purchase_units: [{ payments: { captures: [captureObject()] } }] }, // missing order id
      {
        id: 'ORDER-123',
        status: 'COMPLETED',
        purchase_units: [{ payments: { captures: [{ id: 'CAP-1', status: 'COMPLETED' }] } }], // capture missing amount
      },
    ];
    for (const body of cases) {
      const mock = new MockFetch();
      mock.queueResponse(okJson(TOKEN_RESPONSE), okJson(body));
      const error = await failureOf(makeService(mock).captureOrder(VALID_CAPTURE_INPUT));
      expect(error, JSON.stringify(body)).toBeInstanceOf(PayPalMalformedResponseError);
      expect(mock.calls.length).toBe(2); // token + capture, no further attempts
    }
  });
});

/* ------------------------------------------------------------------ */
/* CP3. Capture error classification and single-attempt discipline      */
/* ------------------------------------------------------------------ */

describe('captureOrder — error classification, retry discipline (CP3 9-13)', () => {
  it('maps an explicit PayPal HTTP failure to PayPalHttpApiError without leaking secrets', async () => {
    const mock = new MockFetch();
    mock.queueResponse(
      okJson(TOKEN_RESPONSE),
      err(422, {
        name: 'ORDER_ALREADY_CAPTURED',
        message: `Order already captured. Context: ${ACCESS_TOKEN} ${CLIENT_SECRET}`,
      })
    );
    const error = (await failureOf(makeService(mock).captureOrder(VALID_CAPTURE_INPUT))) as PayPalHttpApiError;

    expect(error).toBeInstanceOf(PayPalError);
    expect(error.status).toBe(422);
    expect(error.paypalErrorName).toBe('ORDER_ALREADY_CAPTURED');
    expect(error.paypalErrorMessage).toBe(
      `Order already captured. Context: ${ACCESS_TOKEN} ${CLIENT_SECRET}`
    );
    // The typed message is derived from the status + PayPal's error NAME only;
    // PayPal's body message (which may echo secrets) is carried in the typed
    // field for the orchestrator, never in error.message (secret hygiene tests
    // below assert the boundaries).
    expect(error.message).not.toContain(ACCESS_TOKEN);
    expect(error.message).not.toContain(CLIENT_SECRET);
    expect(error.message).not.toContain('Bearer ');
    expect(mock.calls.length).toBe(2); // token + ONE capture attempt
  });

  it('maps a capture transport failure to PayPalHttpApiError with status undefined (ambiguous outcome)', async () => {
    const mock = new MockFetch();
    mock.queueResponse(okJson(TOKEN_RESPONSE), new Error('ECONNRESET'));
    const error = (await failureOf(makeService(mock).captureOrder(VALID_CAPTURE_INPUT))) as PayPalHttpApiError;

    expect(error).toBeInstanceOf(PayPalHttpApiError);
    expect(error.status).toBeUndefined();
    expect(error.message).toContain('unknown');
    expect(error.message).not.toContain(ACCESS_TOKEN);
    expect(mock.calls.length).toBe(2); // token + ONE capture attempt — NO automatic retry
  });

  it('performs exactly one capture HTTP request per invocation — no automatic retry across many failures', async () => {
    const outcomes: Array<Response | Error> = [
      new Error('ECONNRESET'),
      err(500, { name: 'INTERNAL_SERVICE_ERROR' }),
      err(503, 'Service Unavailable'),
      err(400, { name: 'INVALID_REQUEST' }),
    ];
    for (const outcome of outcomes) {
      const mock = new MockFetch();
      mock.queueResponse(okJson(TOKEN_RESPONSE), outcome);
      await failureOf(makeService(mock).captureOrder(VALID_CAPTURE_INPUT));
      // Exactly one capture call (calls[1]); nothing beyond it, ever.
      expect(mock.calls.length).toBe(2);
      expect(mock.call(1).url).toBe(`${API_BASE}/v2/checkout/orders/ORDER-123/capture`);
    }
  });

  it('rejects invalid capture input with PayPalInvalidRequestError and ZERO HTTP calls', async () => {
    const cases: Array<[string, CapturePayPalOrderInput]> = [
      ['empty paypalOrderId', { paypalOrderId: '', requestId: 'req-x-001' }],
      ['whitespace paypalOrderId', { paypalOrderId: '   ', requestId: 'req-x-002' }],
      ['missing paypalOrderId', { requestId: 'req-x-003' } as unknown as CapturePayPalOrderInput],
      ['empty requestId', { paypalOrderId: 'ORDER-123', requestId: '' }],
      ['whitespace requestId', { paypalOrderId: 'ORDER-123', requestId: '   ' }],
      [
        'non-string paypalOrderId',
        { paypalOrderId: 12345, requestId: 'req-x-004' } as unknown as CapturePayPalOrderInput,
      ],
    ];
    for (const [label, input] of cases) {
      const mock = new MockFetch();
      const error = await failureOf(makeService(mock).captureOrder(input));
      expect(error, label).toBeInstanceOf(PayPalInvalidRequestError);
      expect(mock.calls.length, label).toBe(0);
    }
  });

  it('rejects a non-JSON or unreadable capture 2xx body as PayPalMalformedResponseError', async () => {
    const mock = new MockFetch();
    mock.queueResponse(okJson(TOKEN_RESPONSE), okText('not-json'));
    await expect(makeService(mock).captureOrder(VALID_CAPTURE_INPUT)).rejects.toBeInstanceOf(
      PayPalMalformedResponseError
    );
    expect(mock.calls.length).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* CP3. getOrder — read-only reconciliation boundary                    */
/* ------------------------------------------------------------------ */

describe('getOrder — reconciliation read (CP3 15-20)', () => {
  it('GETs exactly {base}/v2/checkout/orders/{id} with OAuth header and no request body', async () => {
    const mock = new MockFetch();
    mock.queueResponse(
      okJson(TOKEN_RESPONSE),
      okJson(
        captureOrderResponse({ id: 'ORDER-123', status: 'COMPLETED' })
      )
    );
    const result = await makeService(mock).getOrder({ paypalOrderId: 'ORDER-123' });

    expect(mock.calls.length).toBe(2);
    const readCall = mock.call(1);
    expect(readCall.url).toBe(`${API_BASE}/v2/checkout/orders/ORDER-123`);
    expect(readCall.init.method).toBe('GET');
    expect(mock.header(readCall, 'Authorization')).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(readCall.init.body).toBeUndefined();
    expect(result).toEqual({
      paypalOrderId: 'ORDER-123',
      orderStatus: 'COMPLETED',
      captures: [
        { captureId: 'CAP-123', status: 'COMPLETED', amountMinorUnits: 1050, currency: 'USD' },
      ],
    });
  });

  it('resolves post-capture ambiguity: a captured order exposes capture evidence for reconciliation', async () => {
    // Scenario: captureOrder failed at the transport level; the orchestrator
    // must be able to determine whether PayPal captured remotely — WITHOUT
    // calling capture again.
    const mock = new MockFetch();
    mock.queueResponse(
      okJson(TOKEN_RESPONSE),
      new Error('ECONNRESET'), // ambiguous capture attempt
      okJson(TOKEN_RESPONSE),
      okJson(
        captureOrderResponse({
          id: 'ORDER-123',
          status: 'COMPLETED',
          purchase_units: [
            {
              payments: {
                captures: [
                  captureObject({ id: 'CAP-RESOLVED', status: 'COMPLETED' }),
                ],
              },
            },
          ],
        })
      )
    );
    const service = makeService(mock);

    await failureOf(service.captureOrder(VALID_CAPTURE_INPUT)); // ambiguous
    const order = await service.getOrder({ paypalOrderId: 'ORDER-123' }); // reconcile

    expect(order.orderStatus).toBe('COMPLETED');
    expect(order.captures).toHaveLength(1);
    expect(order.captures[0]).toEqual({
      captureId: 'CAP-RESOLVED',
      status: 'COMPLETED',
      amountMinorUnits: 1050,
      currency: 'USD',
    });
    // Exactly: OAuth + 1 capture + OAuth + 1 read. No re-capture.
    expect(mock.calls.length).toBe(4);
    expect(mock.call(1).url).toContain('/capture');
    expect(mock.call(3).url).toBe(`${API_BASE}/v2/checkout/orders/ORDER-123`);
  });

  it('returns zero captures for an order with no payments (e.g. CREATED) without failing', async () => {
    const mock = new MockFetch();
    mock.queueResponse(
      okJson(TOKEN_RESPONSE),
      okJson({
        id: 'ORDER-123',
        status: 'CREATED',
        purchase_units: [{ payments: { captures: [] } }],
      })
    );
    const result = await makeService(mock).getOrder({ paypalOrderId: 'ORDER-123' });
    expect(result).toEqual({
      paypalOrderId: 'ORDER-123',
      orderStatus: 'CREATED',
      captures: [],
    });
  });

  it('tolerates purchase_units without a payments field', async () => {
    const mock = new MockFetch();
    mock.queueResponse(
      okJson(TOKEN_RESPONSE),
      okJson({ id: 'ORDER-123', status: 'APPROVED', purchase_units: [{}] })
    );
    const result = await makeService(mock).getOrder({ paypalOrderId: 'ORDER-123' });
    expect(result.orderStatus).toBe('APPROVED');
    expect(result.captures).toEqual([]);
  });

  it('is strictly read-only: mutates nothing and performs no state change beyond the GET', async () => {
    const mock = new MockFetch();
    mock.queueResponse(okJson(TOKEN_RESPONSE), okJson(captureOrderResponse()));
    await makeService(mock).getOrder({ paypalOrderId: 'ORDER-123' });
    expect(mock.calls.length).toBe(2);
    // Only the OAuth POST and the single GET exist — no writes, no retries.
    expect(mock.call(0).init.method).toBe('POST');
    expect(mock.call(1).init.method).toBe('GET');
  });

  it('rejects malformed get-order responses as PayPalMalformedResponseError', async () => {
    const cases: unknown[] = [
      { status: 'COMPLETED', purchase_units: [] }, // missing id
      { id: 'ORDER-123' }, // missing status
      { id: 'ORDER-123', status: 'COMPLETED' }, // missing purchase_units entirely
      { id: 'ORDER-123', status: 'COMPLETED', purchase_units: 'nope' }, // wrong type
      {
        id: 'ORDER-123',
        status: 'COMPLETED',
        purchase_units: [{ payments: { captures: [{ id: 'CAP-1' }] } }], // capture missing status/amount
      },
    ];
    for (const body of cases) {
      const mock = new MockFetch();
      mock.queueResponse(okJson(TOKEN_RESPONSE), okJson(body));
      const error = await failureOf(makeService(mock).getOrder({ paypalOrderId: 'ORDER-123' }));
      expect(error, JSON.stringify(body)).toBeInstanceOf(PayPalMalformedResponseError);
      expect(mock.calls.length).toBe(2); // token + ONE read — no retry
    }
  });

  it('classifies HTTP and transport errors safely for the read', async () => {
    const httpMock = new MockFetch();
    httpMock.queueResponse(
      okJson(TOKEN_RESPONSE),
      err(404, { name: 'INVALID_RESOURCE_ID', message: 'Order not found.' })
    );
    const httpError = (await failureOf(
      makeService(httpMock).getOrder({ paypalOrderId: 'ORDER-123' })
    )) as PayPalHttpApiError;
    expect(httpError).toBeInstanceOf(PayPalHttpApiError);
    expect(httpError.status).toBe(404);
    expect(httpError.paypalErrorName).toBe('INVALID_RESOURCE_ID');
    expect(httpError.paypalErrorMessage).toBe('Order not found.');

    const transportMock = new MockFetch();
    transportMock.queueResponse(okJson(TOKEN_RESPONSE), new Error('ETIMEDOUT'));
    const transportError = (await failureOf(
      makeService(transportMock).getOrder({ paypalOrderId: 'ORDER-123' })
    )) as PayPalHttpApiError;
    expect(transportError).toBeInstanceOf(PayPalHttpApiError);
    expect(transportError.status).toBeUndefined();
  });

  it('rejects invalid input with PayPalInvalidRequestError and ZERO HTTP calls', async () => {
    const cases: Array<[string, { paypalOrderId: string }]> = [
      ['empty order ID', { paypalOrderId: '' }],
      ['whitespace order ID', { paypalOrderId: '   ' }],
      ['non-string order ID', { paypalOrderId: 42 } as unknown as { paypalOrderId: string }],
    ];
    for (const [label, input] of cases) {
      const mock = new MockFetch();
      const error = await failureOf(makeService(mock).getOrder(input));
      expect(error, label).toBeInstanceOf(PayPalInvalidRequestError);
      expect(mock.calls.length, label).toBe(0);
    }
  });
});

/* ------------------------------------------------------------------ */
/* CP3. Secret hygiene                                                  */
/* ------------------------------------------------------------------ */

describe('secret hygiene (CP3 security tests)', () => {
  it('capture errors never contain the client secret, OAuth token, or Authorization header', async () => {
    const scenarios: Array<Response | Error>[] = [
      // Token endpoint transport failure
      [new Error('ECONNREFUSED')],
      // Token endpoint HTTP failure echoing secrets in the body
      [err(401, { error_description: `secret=${CLIENT_SECRET} token=${ACCESS_TOKEN}` })],
      // Capture endpoint transport failure
      [okJson(TOKEN_RESPONSE), new Error('ECONNRESET')],
      // Capture endpoint HTTP failure echoing secrets in the body
      [
        okJson(TOKEN_RESPONSE),
        err(500, {
          name: 'INTERNAL_SERVICE_ERROR',
          message: `debug: ${CLIENT_SECRET} ${ACCESS_TOKEN} Authorization: Bearer ${ACCESS_TOKEN}`,
        }),
      ],
    ];
    for (const responses of scenarios) {
      const mock = new MockFetch();
      mock.queueResponse(...responses);
      const error = await failureOf(makeService(mock).captureOrder(VALID_CAPTURE_INPUT));
      const serialized = `${error.name}: ${error.message}`;
      expect(serialized, JSON.stringify(error.message)).not.toContain(CLIENT_SECRET);
      expect(serialized).not.toContain(ACCESS_TOKEN);
      expect(serialized).not.toContain('Authorization');
      expect(serialized).not.toContain('Basic ');
      expect(serialized).not.toContain(`Bearer ${ACCESS_TOKEN}`);
    }
  });

  it('getOrder errors never contain the client secret, OAuth token, or Authorization header', async () => {
    const scenarios: Array<Response | Error>[] = [
      [new Error('ECONNREFUSED')],
      [err(401, { error_description: `secret=${CLIENT_SECRET}` })],
      [okJson(TOKEN_RESPONSE), new Error('ETIMEDOUT')],
      [
        okJson(TOKEN_RESPONSE),
        err(500, {
          name: 'INTERNAL_SERVICE_ERROR',
          message: `debug: ${CLIENT_SECRET} ${ACCESS_TOKEN}`,
        }),
      ],
    ];
    for (const responses of scenarios) {
      const mock = new MockFetch();
      mock.queueResponse(...responses);
      const error = await failureOf(makeService(mock).getOrder({ paypalOrderId: 'ORDER-123' }));
      const serialized = `${error.name}: ${error.message}`;
      expect(serialized, JSON.stringify(error.message)).not.toContain(CLIENT_SECRET);
      expect(serialized).not.toContain(ACCESS_TOKEN);
      expect(serialized).not.toContain('Authorization');
      expect(serialized).not.toContain('Basic ');
    }
  });

  it('normalization errors never embed raw secret-bearing capture payloads', async () => {
    const mock = new MockFetch();
    mock.queueResponse(
      okJson(TOKEN_RESPONSE),
      okJson(
        captureOrderResponse({
          purchase_units: [
            {
              payments: {
                captures: [
                  captureObject({
                    amount: { currency_code: 'USD', value: `oops-${CLIENT_SECRET}` },
                  }),
                ],
              },
            },
          ],
        })
      )
    );
    const error = await failureOf(makeService(mock).captureOrder(VALID_CAPTURE_INPUT));
    expect(error).toBeInstanceOf(PayPalMalformedResponseError);
    expect(error.message).not.toContain(CLIENT_SECRET);
  });

  it('transport isolation holds for capture and get-order too — global fetch never called', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const mock = new MockFetch();
    mock.queueResponse(
      okJson(TOKEN_RESPONSE),
      okJson(captureOrderResponse()),
      okJson(TOKEN_RESPONSE), // get-order acquires its own token (no caching in CP3)
      okJson(captureOrderResponse())
    );
    const service = makeService(mock);

    await service.captureOrder(VALID_CAPTURE_INPUT);
    await service.getOrder({ paypalOrderId: 'ORDER-123' });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mock.calls.length).toBe(4);
  });
});
