import { paypalCallback } from '../../../server/paypalCallbacks';

// Cache Components requires Node.js; explicit runtime exports are unsupported.
export async function GET(request: Request) {
  // Read the request outside the error adapter so prerendering bails out safely.
  const params = new URL(request.url).searchParams;
  return paypalCallback(params, 'return');
}
