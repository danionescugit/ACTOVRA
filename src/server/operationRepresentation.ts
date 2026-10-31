import type { CommercePilotApplication } from './commercePilotApp';
import { listSyntheticOpportunities } from './syntheticDecisionProposer';

/** Derived UI values only; the application remains the durable authority. */
export function operationRepresentation(app: CommercePilotApplication, id: string) {
  const operation = app.getOperation(id);
  if (!operation) return undefined;
  const { decision, paypalOrder, paymentResult, status } = operation;
  const nextAction = status === 'AWAITING_HUMAN_APPROVAL'
    ? 'APPROVE'
    : status === 'APPROVED'
      ? 'EXECUTE'
      : status === 'PAYPAL_ORDER_CREATED' && paypalOrder?.approveUrl
        ? 'BUYER_APPROVAL'
        : null;

  return {
    operationId: operation.id,
    opportunityId: operation.opportunityId,
    opportunity: listSyntheticOpportunities().find(o => o.id === operation.opportunityId) ?? null,
    status,
    decision: decision ?? null,
    // All amounts use integer minor units, as in CommerceDecision.
    amount: decision?.amount ?? null,
    currency: decision?.currency ?? null,
    justification: decision?.justification ?? null,
    policyResult: operation.policyResult ?? null,
    approvalStatus: operation.approvalStatus ?? (status === 'AWAITING_HUMAN_APPROVAL' ? 'PENDING' : null),
    paypalOrder: paypalOrder ? {
      paypalOrderId: paypalOrder.paypalOrderId,
      paypalStatus: paypalOrder.paypalStatus,
    } : null,
    approvalUrl: paypalOrder?.approveUrl ?? null,
    paymentResult: paymentResult ? {
      success: paymentResult.success,
      transactionId: paymentResult.transactionId ?? null,
      captureId: paymentResult.captureId ?? null,
      paypalOrderId: paymentResult.paypalOrderId ?? null,
      amount: paymentResult.amount ?? null,
      currency: paymentResult.currency ?? null,
    } : null,
    auditTrail: app.getAuditTrail(id).map(entry => ({
      sequence: entry.eventSeq,
      eventType: entry.event.type,
      occurredAt: entry.occurredAt.toISOString(),
    })),
    createdAt: operation.createdAt.toISOString(),
    updatedAt: operation.updatedAt.toISOString(),
    nextAction,
  };
}
