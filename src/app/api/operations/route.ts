import { createOperation, listOperations } from '../../../server/operationsApi';

// Cache Components uses the Node.js runtime; runtime exports are unsupported.

export async function GET() {
  return listOperations();
}

export async function POST(request: Request) {
  return createOperation(request);
}
