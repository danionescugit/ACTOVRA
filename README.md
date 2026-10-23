# CommercePilot

CommercePilot is an AI-assisted commerce operations system demonstrating a core loop:
Opportunity → CommerceDecision → deterministic policy/risk gate → human approval → PayPal Sandbox transaction → webhook/outcome → next action → Commerce Operations Console.

This is a hackathon demo project. It uses synthetic/demo data only and does not integrate with any proprietary systems.

## Architecture Principle

The important demo is NOT “AI can call PayPal”.

The important demo is:
AI identifies/composes a commercial action
→ deterministic controls make it safe
→ human approves it
→ PayPal executes it
→ the resulting commerce event becomes context for the next decision.

## Getting Started

First, install the dependencies:

```bash
npm install
```

Then, run the development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Running Tests

To run the unit tests with Vitest:

```bash
npm test
```

For watch mode:

```bash
npm run test:watch
```

## Environment Variables

Create a `.env.local` file in the root directory (based on `.env.example`) and fill in the required values.

**Important:** Never commit real credentials to version control. The `.env.example` file contains only variable names.

Required environment variables for PayPal Sandbox:
- `PAYPAL_CLIENT_ID`
- `PAYPAL_CLIENT_SECRET`
- `PAYPAL_API_BASE` (defaults to `https://api-m.sandbox.paypal.com`)

## Project Structure

- `src/domain`: Zod schemas and TypeScript types for domain objects, synthetic data.
- `src/policy`: Deterministic policy/gate functions (to be implemented).
- `src/agents`: AI commerce agent that proposes decisions (to be implemented).
- `src/services`: PayPal service and other external integrations (to be implemented).
- `src/store`: In-memory storage for demo state (to be implemented).
- `src/components`: React components, including the operations console (to be implemented).
- `app`: Next.js App Router pages.

## License

This project is open-source and available under the MIT License.