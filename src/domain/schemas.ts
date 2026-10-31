import { z } from 'zod';

// Base schemas
export const OpportunitySchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  // Add any other fields relevant to a synthetic opportunity
});

export const CommerceDecisionSchema = z.object({
  opportunityId: z.string(),
  action: z.enum(['CREATE_PAYMENT', 'REFUND', 'UPDATE_SUBSCRIPTION', 'CREATE_INVOICE']),
  // Amount in cents (integer minor units) to avoid floating-point issues
  amount: z.number().int().positive(),
  currency: z.enum(['USD', 'EUR', 'GBP', 'JPY', 'CAD']), // Extend as needed
  recipient: z.string(), // e.g., customer ID, email, etc.
  justification: z.string(),
  // Provenance flag distinguishing live model vs synthetic fallback
  provenance: z.enum(['REAL_AI', 'SYNTHETIC_FALLBACK']).optional(),
  // Add any other fields that the policy gate might need
});

export const PolicyResultSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT', 'ESCALATE']),
  reason: z.string(),
  // Optional structured reason codes for auditability
  reasonCode: z.enum([
    'AMOUNT_EXCEEDS_AUTOMATIC_MAX',
    'AMOUNT_EXCEEDS_HUMAN_MAX',
    'ACTION_NOT_ALLOWED',
    'CURRENCY_NOT_ALLOWED',
    'RECIPIENT_NOT_ALLOWED',
    'OPPORTUNITY_NOT_FOUND',
    'JUSTIFICATION_MISSING',
    'OTHER'
  ]).optional(),
});

export const ApprovalStatusSchema = z.enum([
  'PENDING',
  'APPROVED',
  'REJECTED',
]);

/**
 * Durable record of a completed payment.
 *
 * For the capture flow (Task 09), `transactionId` carries the PayPal capture
 * ID, and `captureId` / `paypalOrderId` add the remaining minimal truthful
 * capture evidence. All capture-evidence fields are optional so existing
 * persisted snapshots remain valid (backward compatibility).
 */
export const PaymentResultSchema = z.object({
  success: z.boolean(),
  transactionId: z.string().optional(),
  /** PayPal capture ID for the captured funds (present on capture success). */
  captureId: z.string().optional(),
  /** PayPal order ID that was captured (proves which order produced the result). */
  paypalOrderId: z.string().optional(),
  amount: z.number().int().optional(), // cents
  currency: z.enum(['USD', 'EUR', 'GBP', 'JPY', 'CAD']).optional(),
  errorMessage: z.string().optional(),
});

export const CommerceOperationStatusSchema = z.enum([
  'OPPORTUNITY',
  'DECISION_PROPOSED',
  'POLICY_APPROVED',
  'POLICY_REJECTED',
  'POLICY_ESCALATED',
  'AWAITING_HUMAN_APPROVAL',
  'APPROVED',
  'REJECTED_BY_HUMAN',
  'EXECUTING',
  'PAYPAL_PENDING',
  'PAYPAL_ORDER_CREATED',
  /** Capture attempt claimed; network outcome unknown until a result event. */
  'CAPTURE_EXECUTING',
  'COMPLETED',
  'FAILED',
  'OUTCOME_RECORDED',
]);

/**
 * Durable record of a PayPal order that was successfully created at the
 * PayPal Orders API boundary. This truthfully represents the intermediate
 * state "PayPal order created, buyer has not approved, payment not captured"
 * — it is NOT a payment-completed record.
 *
 * - paypalOrderId: PayPal's order ID from the create-order response.
 * - paypalStatus:  PayPal's normalized status string (e.g. 'CREATED').
 * - requestId:     The caller-owned stable PayPal-Request-Id used for the
 *                  create-order call (idempotency/reconciliation key).
 * - approveUrl:    Optional buyer-approval redirect URL for the later
 *                  human/buyer approval flow.
 */
export const PayPalOrderInfoSchema = z.object({
  paypalOrderId: z.string().min(1),
  paypalStatus: z.string().min(1),
  requestId: z.string().min(1),
  approveUrl: z.string().optional(),
});

export const CommerceOperationSchema = z.object({
  id: z.string(),
  opportunityId: z.string(),
  status: CommerceOperationStatusSchema,
  decision: CommerceDecisionSchema.optional(),
  policyResult: PolicyResultSchema.optional(),
  approvalStatus: ApprovalStatusSchema.optional(),
  paymentResult: PaymentResultSchema.optional(),
  /** Present only after a PayPal order was successfully created (PAYPAL_ORDER_CREATED). Optional for backward compatibility with existing persisted snapshots. */
  paypalOrder: PayPalOrderInfoSchema.optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

// Infer TypeScript types
export type Opportunity = z.infer<typeof OpportunitySchema>;
export type CommerceDecision = z.infer<typeof CommerceDecisionSchema>;
export type PolicyResult = z.infer<typeof PolicyResultSchema>;
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;
export type PaymentResult = z.infer<typeof PaymentResultSchema>;
export type PayPalOrderInfo = z.infer<typeof PayPalOrderInfoSchema>;
export type CommerceOperationStatus = z.infer<typeof CommerceOperationStatusSchema>;
export type CommerceOperation = z.infer<typeof CommerceOperationSchema>;