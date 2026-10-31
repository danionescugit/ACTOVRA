/* eslint-disable @typescript-eslint/no-require-imports -- Passenger loads a CommonJS startup file. */
const { createServer } = require('node:http');
const next = require('next');

async function start() {
  // Production demo defaults for offline exploration (ensures /api/operations can initialize SQLite
  // even if live PayPal credentials have not been configured in cPanel yet):
  if (!process.env.PAYPAL_CLIENT_ID || process.env.PAYPAL_CLIENT_ID.trim() === '') {
    process.env.PAYPAL_CLIENT_ID = 'demo-sandbox-client-id';
  }
  if (!process.env.PAYPAL_CLIENT_SECRET || process.env.PAYPAL_CLIENT_SECRET.trim() === '') {
    process.env.PAYPAL_CLIENT_SECRET = 'demo-sandbox-client-secret';
  }

  const rawPort = process.env.PORT;
  let numericPort;
  let listenArg;

  if (rawPort !== undefined && rawPort.trim() !== '') {
    if (rawPort === 'passenger') {
      listenArg = 'passenger';
    } else if (/^\d+$/.test(rawPort)) {
      numericPort = Number(rawPort);
      if (numericPort < 1 || numericPort > 65535) {
        throw new Error('PORT must be a valid TCP port between 1 and 65535.');
      }
      listenArg = numericPort;
    } else {
      // Unix domain socket or named pipe path
      listenArg = rawPort;
    }
  } else if (typeof PhusionPassenger !== 'undefined' || typeof globalThis.PhusionPassenger !== 'undefined') {
    listenArg = 'passenger';
  } else {
    // cPanel / CloudLinux / LiteSpeed Passenger reverse port binding:
    // Passenger automatically intercepts the first http.Server listen call and substitutes its Unix domain socket.
    // Calling listen() without arguments enables this automatic integration without hardcoding a port.
    listenArg = undefined;
  }

  const nextOptions = { dev: false, dir: __dirname };
  if (numericPort !== undefined) {
    nextOptions.port = numericPort;
  }

  const app = next(nextOptions);
  await app.prepare();
  const handle = app.getRequestHandler();
  const server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (response.headersSent) {
        response.destroy();
      } else {
        response.statusCode = 500;
        response.end('Internal Server Error');
      }
    });
  });
  server.on('error', (err) => {
    console.error('CommercePilot HTTP server failed:', err.message || err);
    process.exit(1);
  });

  // Listen using the resolved argument:
  // - If numericPort: binds to the specified TCP port (local tests / custom port).
  // - If 'passenger': Passenger explicit socket binding.
  // - If undefined: server.listen() triggers Passenger reverse port binding on cPanel / CloudLinux.
  if (listenArg !== undefined) {
    server.listen(listenArg);
  } else {
    server.listen();
  }
}

start().catch((error) => {
  console.error('CommercePilot startup failed:', error.stack || error);
  process.exit(1);
});
