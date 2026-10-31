import { z } from 'zod';
import { InvalidTransitionError } from '../domain/stateMachine';
import { getCommercePilotComposition } from './composition';
import { SyntheticDecisionProposerError, listSyntheticOpportunities } from './syntheticDecisionProposer';
import { operationRepresentation } from './operationRepresentation';

const createInput = z.object({ opportunityId: z.string().min(1).max(200) }).strict();
const actionInput = z.object({}).strict();
const idInput = z.string().min(1).max(200);

class InvalidInput extends Error {}
class OperationNotFound extends Error {}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

function failure(code: string, message: string, status: number, operation?: unknown) {
  return json({ error: { code, message }, ...(operation ? { operation } : {}) }, status);
}

async function body(request: Request, allowEmpty = false): Promise<unknown> {
  const text = await request.text();
  if (allowEmpty && !text.trim()) return {};
  try { return JSON.parse(text); } catch { throw new InvalidInput(); }
}

async function handle(action: () => Promise<Response>): Promise<Response> {
  try { return await action(); } catch (error) {
    if (error instanceof InvalidInput || error instanceof z.ZodError) {
      return failure('INVALID_INPUT', 'Invalid request body or operation ID.', 400);
    }
    if (error instanceof OperationNotFound) {
      return failure('OPERATION_NOT_FOUND', 'Operation not found.', 404);
    }
    if (error instanceof SyntheticDecisionProposerError) {
      return failure('UNKNOWN_OPPORTUNITY', 'Unknown synthetic opportunity.', 404);
    }
    if (error instanceof InvalidTransitionError) {
      return failure('INVALID_TRANSITION', 'Action is not allowed in the current operation state.', 409);
    }
    // No configuration, provider errors, paths, SQL, or exception details cross HTTP.
    return failure('INTERNAL_ERROR', 'Operation could not be processed.', 500);
  }
}

function existingOperation(id: string) {
  idInput.parse(id);
  const app = getCommercePilotComposition().application;
  if (!app.getOperation(id)) throw new OperationNotFound();
  return app;
}

export function createOperation(request: Request) {
  return handle(async () => {
    const input = createInput.parse(await body(request));
    const app = getCommercePilotComposition().application;
    const outcome = await app.createOperationAwaitingApproval(input.opportunityId);
    return json(operationRepresentation(app, outcome.operationId), 201, {
      Location: `/api/operations/${encodeURIComponent(outcome.operationId)}`,
    });
  });
}

export function listOperations() {
  return handle(async () => {
    const app = getCommercePilotComposition().application;
    const ops = app.listOperations();
    const representations = ops.map(op => operationRepresentation(app, op.id));
    return json({
      operations: representations,
      opportunities: listSyntheticOpportunities(),
    });
  });
}

export function getOperation(id: string) {
  return handle(async () => json(operationRepresentation(existingOperation(id), id)));
}

export function approveOperation(request: Request, id: string) {
  return handle(async () => {
    actionInput.parse(await body(request, true));
    const app = existingOperation(id);
    app.approveOperation(id);
    return json(operationRepresentation(app, id));
  });
}

export function executeOperation(request: Request, id: string) {
  return handle(async () => {
    actionInput.parse(await body(request, true));
    const app = existingOperation(id);
    const outcome = await app.executeOperation(id);
    // Return only durable state, never the provider result/recovery payload.
    const operation = operationRepresentation(app, id);
    switch (outcome.kind) {
      case 'ORDER_CREATED': return json(operation);
      case 'NOT_EXECUTABLE':
        return failure('NOT_EXECUTABLE', 'Operation is not executable in its current state.', 409, operation);
      case 'EXECUTION_FAILED':
        return failure('EXECUTION_FAILED', 'Payment order execution failed. Review the operation before taking further action.', 502, operation);
      case 'POST_PAYPAL_PERSISTENCE_FAILED':
        return failure('PERSISTENCE_FAILED', 'Payment order may exist. Review required; do not retry execution.', 500, operation);
    }
  });
}
