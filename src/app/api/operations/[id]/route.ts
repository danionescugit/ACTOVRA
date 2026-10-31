import { getOperation } from '../../../../server/operationsApi';

// Cache Components uses the Node.js runtime; runtime exports are unsupported.

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  // Awaiting request params keeps this read at request time with Cache Components.
  const { id } = await context.params;
  return getOperation(id);
}
