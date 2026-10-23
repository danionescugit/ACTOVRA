import { z } from 'zod';
import { CommerceDecisionSchema } from './schemas';
import { PolicyResultSchema } from './schemas';
import { PaymentResultSchema } from './schemas';
import { PayPalOrderInfoSchema } from './schemas';

// Event types
export const DecisionProposedEventSchema = z.object({
  type: z.literal('DECISION_PROPOSED'),
  decision: CommerceDecisionSchema,
});

export const PolicyApprovedEventSchema = z.object({
  type: z.literal('POLICY_APPROVED'),
  policyResult: PolicyResultSchema,
});

export const PolicyRejectedEventSchema = z.object({
  type: z.literal('POLICY_REJECTED'),
  policyResult: PolicyResultSchema,
});

export const PolicyEscalatedEventSchema = z.object({
  type: z.literal('POLICY_ESCALATED'),
  policyResult: PolicyResultSchema,
});

export const RequestHumanApprovalEventSchema = z.object({
  type: z.literal('REQUEST_HUMAN_APPROVAL'),
});

export const HumanApprovedEventSchema = z.object({
  type: z.literal('HUMAN_APPROVED'),
  approvalStatus: z.literal('APPROVED'),
});

export const HumanRejectedEventSchema = z.object({
  type: z.literal('HUMAN_REJECTED'),
  approvalStatus: z.literal('REJECTED'),
});

export const ExecutionStartedEventSchema = z.object({
  type: z.literal('EXECUTION_STARTED'),
});

export const PayPalPendingEventSchema = z.object({
  type: z.literal('PAYPAL_PENDING'),
});

export const PayPalOrderCreatedEventSchema = z.object({
  type: z.literal('PAYPAL_ORDER_CREATED'),
  paypalOrder: PayPalOrderInfoSchema,
});

/**
 * Durable claim of a capture attempt against the already-persisted PayPal
 * order. Committing this event in the store transaction is the authoritative
 * single-flight gate: the invocation whose CAPTURE_STARTED commits owns the
 * capture network call; concurrent invocations observe CAPTURE_EXECUTING and
 * make zero PayPal calls. Payload-free by design — the capture target is
 * always read from the durably persisted paypalOrder, never supplied by the
 * caller.
 */
export const CaptureStartedEventSchema = z.object({
  type: z.literal('CAPTURE_STARTED'),
});

export const PaymentCompletedEventSchema = z.object({
  type: z.literal('PAYMENT_COMPLETED'),
  paymentResult: PaymentResultSchema,
});

export const PaymentFailedEventSchema = z.object({
  type: z.literal('PAYMENT_FAILED'),
  paymentResult: PaymentResultSchema,
});

export const OutcomeRecordedEventSchema = z.object({
  type: z.literal('OUTCOME_RECORDED'),
});

// Union of all event types
export const CommerceOperationEventSchema = z.union([
  DecisionProposedEventSchema,
  PolicyApprovedEventSchema,
  PolicyRejectedEventSchema,
  PolicyEscalatedEventSchema,
  RequestHumanApprovalEventSchema,
  HumanApprovedEventSchema,
  HumanRejectedEventSchema,
  ExecutionStartedEventSchema,
  PayPalPendingEventSchema,
  PayPalOrderCreatedEventSchema,
  CaptureStartedEventSchema,
  PaymentCompletedEventSchema,
  PaymentFailedEventSchema,
  OutcomeRecordedEventSchema,
]);

// Infer TypeScript types
export type DecisionProposedEvent = z.infer<typeof DecisionProposedEventSchema>;
export type PolicyApprovedEvent = z.infer<typeof PolicyApprovedEventSchema>;
export type PolicyRejectedEvent = z.infer<typeof PolicyRejectedEventSchema>;
export type PolicyEscalatedEvent = z.infer<typeof PolicyEscalatedEventSchema>;
export type RequestHumanApprovalEvent = z.infer<typeof RequestHumanApprovalEventSchema>;
export type HumanApprovedEvent = z.infer<typeof HumanApprovedEventSchema>;
export type HumanRejectedEvent = z.infer<typeof HumanRejectedEventSchema>;
export type ExecutionStartedEvent = z.infer<typeof ExecutionStartedEventSchema>;
export type PayPalPendingEvent = z.infer<typeof PayPalPendingEventSchema>;
export type PayPalOrderCreatedEvent = z.infer<typeof PayPalOrderCreatedEventSchema>;
export type CaptureStartedEvent = z.infer<typeof CaptureStartedEventSchema>;
export type PaymentCompletedEvent = z.infer<typeof PaymentCompletedEventSchema>;
export type PaymentFailedEvent = z.infer<typeof PaymentFailedEventSchema>;
export type OutcomeRecordedEvent = z.infer<typeof OutcomeRecordedEventSchema>;
export type CommerceOperationEvent = z.infer<typeof CommerceOperationEventSchema>;