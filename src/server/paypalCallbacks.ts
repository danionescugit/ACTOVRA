import { getCommercePilotComposition } from './composition';

const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };

function failure(code: string, status: number) {
  return Response.json({ error: { code } }, { status, headers });
}

function handoff(operationId: string | undefined, indicator: string) {
  const query = new URLSearchParams();
  if (operationId) query.set('operation', operationId);
  query.set('paypal', indicator);
  return new Response(null, {
    status: 303,
    headers: { ...headers, Location: `/?${query}` },
  });
}

/** Browser values correlate an order; only the orchestrator can authorize capture. */
export async function paypalCallback(params: URLSearchParams, action: 'return' | 'cancel') {
  const tokens = params.getAll('token');
  if (action === 'cancel' && tokens.length === 0) {
    return handoff(undefined, 'approval-not-completed');
  }
  if (tokens.length !== 1 || !tokens[0].trim() || tokens[0].length > 200) {
    return failure('INVALID_CALLBACK', 400);
  }

  try {
    const app = getCommercePilotComposition().application;
    const operation = app.findOperationByPayPalOrderId(tokens[0]);
    if (!operation) return failure('ORDER_NOT_FOUND', 404);

    if (action === 'cancel') {
      // Browser cancellation changes no payment state and makes no provider call.
      return handoff(operation.id, 'approval-not-completed');
    }

    // PayerID, operationId, approval flags and payment results are never forwarded.
    // The application/orchestrator rereads durable order data before provider verification.
    const outcome = await app.captureOperation(operation.id);
    const indicator = outcome.kind === 'CAPTURE_COMPLETED' || outcome.kind === 'NOT_CAPTURABLE'
      ? 'returned'
      : 'review-required';
    return handoff(operation.id, indicator);
  } catch {
    // No exception/provider/configuration details or retry instructions cross HTTP.
    return failure('CALLBACK_REVIEW_REQUIRED', 500);
  }
}
