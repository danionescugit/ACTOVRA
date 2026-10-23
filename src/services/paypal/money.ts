/**
 * Deterministic money conversion for the PayPal service boundary (Task 07).
 *
 * CommercePilot owns all money as INTEGER minor units (cents). PayPal's Orders
 * API requires decimal strings such as "10.50". Conversion happens ONLY at
 * this boundary and uses pure string manipulation on integers — no floating
 * point arithmetic anywhere, so `1` always becomes "0.01" and
 * `105` always becomes "1.05".
 *
 * Currency decimal places follow PayPal/ISO-4217 rules. The CommercePilot
 * domain currency enum (see src/domain/schemas.ts CommerceDecisionSchema)
 * currently allows USD, EUR, GBP, JPY, CAD — JPY is a zero-decimal currency
 * and must be sent to PayPal without fractional digits.
 */

export type PayPalSupportedCurrency = 'USD' | 'EUR' | 'GBP' | 'JPY' | 'CAD';

const SUPPORTED_CURRENCIES: readonly PayPalSupportedCurrency[] = [
  'USD',
  'EUR',
  'GBP',
  'JPY',
  'CAD',
];

/** Number of decimal digits PayPal requires for each supported currency. */
const CURRENCY_DECIMALS: Record<PayPalSupportedCurrency, number> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  CAD: 2,
  JPY: 0,
};

export function isSupportedPayPalCurrency(value: unknown): value is PayPalSupportedCurrency {
  return (
    typeof value === 'string' &&
    SUPPORTED_CURRENCIES.includes(value as PayPalSupportedCurrency)
  );
}

export function decimalsForCurrency(currency: PayPalSupportedCurrency): number {
  return CURRENCY_DECIMALS[currency];
}

/**
 * Convert integer minor units to a fixed-decimal PayPal amount string using
 * string arithmetic only (no floating point).
 *
 * Examples (decimals = 2): 1 → "0.01", 10 → "0.10", 105 → "1.05",
 * 5000 → "50.00", 1234567890 → "12345678.90".
 *
 * @param minorUnits Integer amount in minor units (cents for 2-decimal
 *   currencies, whole units for zero-decimal currencies such as JPY).
 * @param decimals Number of decimal digits (0–20). Must be an integer.
 * @returns The PayPal amount string, e.g. "0.01".
 * @throws TypeError when inputs are not safe integers or decimals is invalid.
 */
export function formatMinorUnitsToPayPalDecimal(
  minorUnits: number,
  decimals: number
): string {
  if (!Number.isSafeInteger(minorUnits)) {
    throw new TypeError(
      `minorUnits must be a safe integer, got: ${String(minorUnits)}`
    );
  }
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 20) {
    throw new TypeError(
      `decimals must be a safe integer between 0 and 20, got: ${String(decimals)}`
    );
  }

  const negative = minorUnits < 0;
  const digits = Math.abs(minorUnits).toString();

  let result: string;
  if (decimals === 0) {
    result = digits;
  } else {
    // Pad so at least one integer digit exists before the separator.
    const padded = digits.padStart(decimals + 1, '0');
    const intPart = padded.slice(0, padded.length - decimals);
    const fracPart = padded.slice(padded.length - decimals);
    result = `${intPart}.${fracPart}`;
  }

  return negative ? `-${result}` : result;
}

/**
 * Convert a CommercePilot integer minor-unit amount into the PayPal amount
 * string for the given currency, applying that currency's required precision.
 */
export function convertMinorUnitsToPayPalAmount(
  currency: PayPalSupportedCurrency,
  minorUnits: number
): string {
  return formatMinorUnitsToPayPalDecimal(minorUnits, decimalsForCurrency(currency));
}

/**
 * Parse a PayPal amount string ("10.50", "500") into integer minor units for
 * the given currency using PURE STRING manipulation — no floating-point
 * arithmetic anywhere — so monetary comparison upstream stays deterministic.
 *
 * Accepts exactly: one or more digits, optionally followed by '.' and
 * 1..decimals fractional digits for that currency. Zero-decimal currencies
 * (e.g. JPY) must NOT carry a fractional part — "10.50" for JPY is rejected
 * rather than silently reinterpreted.
 *
 * Rejects (with a thrown error): signs, whitespace, exponent notation
 * ("1e3"), thousands separators, empty strings, non-strings, and any value
 * too large for safe integer arithmetic. Capture/read results are
 * non-negative; negative amounts are rejected.
 *
 * Examples (USD, decimals = 2): "10.50" → 1050, "0.1" → 10, "105" → 10500.
 * Examples (JPY, decimals = 0): "500" → 500, "10.50" → rejected.
 *
 * @throws TypeError when amount is not a string or currency is unsupported.
 * @throws RangeError when the amount string is malformed or out of range.
 */
export function parsePayPalAmountToMinorUnits(
  amount: string,
  currency: PayPalSupportedCurrency
): number {
  if (typeof amount !== 'string') {
    throw new TypeError(
      `amount must be a string, got: ${typeof amount}`
    );
  }
  if (!isSupportedPayPalCurrency(currency)) {
    throw new TypeError(`Unsupported currency: ${String(currency)}`);
  }

  const decimals = decimalsForCurrency(currency);
  // A 0-decimal currency must not accept a fractional part at all; note that
  // `\d{1,0}` would be an invalid quantifier, hence the explicit branch.
  const pattern =
    decimals === 0
      ? /^\d+$/
      : new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`);
  if (!pattern.test(amount)) {
    // Deliberately does NOT echo the input string: callers feed this parser
    // provider-supplied values, and untrusted content must never enter error
    // messages (secret-safe discipline).
    throw new RangeError(
      `Malformed PayPal amount string for ${currency} (expected a non-negative decimal string with at most ${decimals} fractional digits)`
    );
  }

  const [intPart, fracPart = ''] = amount.split('.');
  const digits = `${intPart}${fracPart.padEnd(decimals, '0')}`;

  // 15 digits keeps the value < 2^53, so Number.parseInt below is exact.
  if (digits.length > 15) {
    throw new RangeError(
      `PayPal amount string for ${currency} is too large for safe integer arithmetic`
    );
  }

  const minorUnits = Number.parseInt(digits, 10);
  if (!Number.isSafeInteger(minorUnits)) {
    throw new RangeError(
      `PayPal amount string for ${currency} is out of safe integer range`
    );
  }
  return minorUnits;
}
