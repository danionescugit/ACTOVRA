import { paypalCallback } from '../../../server/paypalCallbacks';

// Cache Components requires Node.js; explicit runtime exports are unsupported.
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  return paypalCallback(params, 'cancel');
}
