/**
 * Public surface of the Commerce Execution Orchestrator (Task 08, CP3).
 */
export {
  CommerceExecutionOrchestrator,
  PAYPAL_REQUEST_ID_PREFIX,
  payPalRequestIdForOperation,
  NON_EXECUTABLE_REASONS,
  isDefiniteNoOrderFailure,
} from './commerceExecutionOrchestrator';
export type {
  PayPalOrderCreator,
  PayPalOrderCreatorResult,
  CommerceExecutionClock,
  CommerceExecutionOutcome,
  CommerceExecutionOrchestratorOptions,
} from './commerceExecutionOrchestrator';

/**
 * Public surface of the Capture Orchestrator (Task 09, CP4) — additive only;
 * the CP3 exports above are unchanged.
 */
export {
  CaptureOrchestrator,
  PAYPAL_CAPTURE_REQUEST_ID_PREFIX,
  payPalCaptureRequestIdForOperation,
  NOT_CAPTURABLE_REASONS,
  NOT_RECONCILABLE_REASONS,
  RECOVERY_NOT_APPLICABLE_REASONS,
} from './captureOrchestrator';
export type {
  PayPalCaptureExecutor,
  CaptureOutcome,
  ReconcileOutcome,
  CaptureRecoveryResult,
  CaptureOrchestratorOptions,
} from './captureOrchestrator';
