import { approveOperation } from '../../../../../server/operationsApi';

// Cache Components uses the Node.js runtime; runtime exports are unsupported.

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return approveOperation(request, id);
}
