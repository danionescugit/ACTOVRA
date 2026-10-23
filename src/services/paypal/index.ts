/**
 * Public surface of the PayPal service boundary (Task 07 → Task 09).
 *
 * CommercePilot code outside src/services/paypal must import from this barrel
 * file only — no raw fetch calls, no raw PayPal request/response shapes.
 *
 * Nothing in this boundary reads or writes CommerceOperation state: calling
 * PayPal does not advance the state machine, and the service never decides
 * whether a capture is permitted (that is the orchestrator/domain's job).
 * No webhooks here.
 */
export { PayPalService, type FetchLike } from './paypalService';
export type {
  CreatePayPalOrderInput,
  PayPalCreateOrderResult,
  CapturePayPalOrderInput,
  PayPalCaptureOrderResult,
  PayPalCaptureStatus,
  PayPalGetOrderResult,
} from './paypalService';
export {
  PayPalError,
  PayPalConfigurationError,
  PayPalInvalidRequestError,
  PayPalAuthenticationError,
  PayPalHttpApiError,
  PayPalMalformedResponseError,
} from './errors';
export {
  loadPayPalConfigFromEnv,
  PAYPAL_API_BASE_URLS,
  PAYPAL_OAUTH_TOKEN_PATH,
  PAYPAL_ORDERS_PATH,
  type PayPalConfig,
  type PayPalEnvironment,
} from './config';
export {
  formatMinorUnitsToPayPalDecimal,
  convertMinorUnitsToPayPalAmount,
  parsePayPalAmountToMinorUnits,
  isSupportedPayPalCurrency,
  decimalsForCurrency,
  type PayPalSupportedCurrency,
} from './money';
