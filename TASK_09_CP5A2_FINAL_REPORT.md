# TASK 09 CP5A2 — FINAL REPORT

**Fresh Sandbox order for immediate manual buyer approval**

---

## 1. STATUS

**STOPPED BEFORE NETWORK — NO ORDER CREATED**

Phase 1 (read-only inspection) found that the production `createOrder` payload
does **NOT** include `application_context` (nor its successor
`payment_source.paypal.experience_context`) — therefore no `return_url` and no
`cancel_url`. Per the checkpoint's own rule ("If a production change is
required: STOP BEFORE NETWORK … Do not combine a production-code fix and a live
order creation without a separate review"), the checkpoint halted after Phase 2.
Phase 3 was **NOT** executed. Zero PayPal requests of any kind were made.

The old order `29G94348NH454964S` was not reused, not read, not captured, not
mutated (the CP5A get-order diagnostic tool was **not** run — zero getOrder).

## 2. CREATE-ORDER APPROVAL-FLOW INSPECTION (read-only, zero network)

Production implementation: `src/services/paypal/paypalService.ts`, `createOrder()`
(lines ~397–540). The request body it builds (lines ~441–455):

```ts
const body = {
  intent: 'CAPTURE' as const,
  purchase_units: [
    {
      amount: { currency_code: input.currency, value: amountString },
      ...(input.commerceOperationId !== undefined
        ? { custom_id: input.commerceOperationId }
        : {}),
    },
  ],
};
```

- `POST {base}/v2/checkout/orders` with `PayPal-Request-Id: <caller requestId>`.
- Body contains ONLY `intent` + `purchase_units` (+ optional `custom_id`).
- **No `application_context` object exists anywhere in the request.**
- Repo-wide search (`return_url|cancel_url|application_context`, all of `src/`
  including production and tests): **0 matches**. The strings do not exist in
  this codebase.
- The service correctly parses the response `links[]` for `rel: 'approve'` and
  returns `approveUrl` (https, `www.sandbox.paypal.com`) — approval-URL
  *extraction* is fine; what is missing is the redirect-flow *configuration*
  on the created order.

Verification against PayPal's own machine-readable API contract
(`paypal/paypal-rest-api-specifications` → `openapi/checkout_orders_v2.json`,
fetched to `/tmp`, not into the repo):

- `order_request` requires only `intent` + `purchase_units`; it also accepts
  `application_context` and `payment_source`.
- `order_application_context.return_url/cancel_url` are marked **DEPRECATED**:
  *"The fields in `application_context` are now available in the
  `experience_context` object under the `payment_source` (eg.
  `payment_source.paypal.experience_context.return_url`)."*
- Current location: `payment_source.paypal.experience_context.return_url`
  ("The URL where the customer will be redirected upon approving a payment.")
  and `.cancel_url`, plus optional `user_action: 'CONTINUE' | 'PAY_NOW'`.

This matches the documented warning that redirect Checkout without a suitable
`return_url` can produce the **"Things don't appear to be working at the
moment"** buyer experience — the exact Sandbox symptom recorded for the CP5A
order in `paypalSandboxCp5aGetOrderDiagnostic.test.ts`. Combined with the
checkout-order lifetime (the CP5A order was left un-approved overnight), the
missing redirect configuration is the deterministic, fixable root-cause
candidate; the order lifetime is an operational constraint (approve immediately).

## 3. RETURN_URL PRESENT?

**NO.** Neither `application_context.return_url` (deprecated location) nor
`payment_source.paypal.experience_context.return_url` (current location) is
sent. Absent from the production payload and from the entire repository.

## 4. CANCEL_URL PRESENT?

**NO.** Same as above — absent everywhere.

## 5. ANY CODE CHANGE REQUIRED?

**YES — production change required → STOP before network (this checkpoint).**

Exact proposed MINIMUM change (for separate review, NOT applied):

**File 1: `src/services/paypal/paypalService.ts`** (the only required change)

a) Extend the input type (additive, optional — no existing caller breaks):

```ts
export interface CreatePayPalOrderInput {
  // ...existing fields unchanged...
  /** URL PayPal redirects the buyer to AFTER approval (redirect approval flow). */
  readonly returnUrl?: string;
  /** URL PayPal redirects the buyer to on cancellation. */
  readonly cancelUrl?: string;
}
```

b) In `createOrder()`, extend the body — ONLY when both are provided, at the
current (non-deprecated) spec location, with `user_action: 'PAY_NOW'` so the
buyer sees an explicit pay button:

```ts
const body = {
  intent: 'CAPTURE' as const,
  purchase_units: [ /* unchanged */ ],
  ...(input.returnUrl !== undefined && input.cancelUrl !== undefined
    ? {
        payment_source: {
          paypal: {
            experience_context: {
              return_url: input.returnUrl,
              cancel_url: input.cancelUrl,
              user_action: 'PAY_NOW' as const,
            },
          },
        },
      }
    : {}),
};
```

Response parsing, request-ID handling, validation, error model, and the
single-attempt discipline are untouched. `CreateOrderResponseSchema` already
tolerates the response shape (`.links[]` passthrough of `{rel, href, method}`).

**File 2 (wiring, needed for the live order):**
`src/services/paypal/paypalSandboxCp5aPreflightSmoke.test.ts` (or its CP5A2
successor harness) passes, e.g.:

```ts
returnUrl: 'https://example.com/commercepilot/paypal/return',
cancelUrl: 'https://example.com/commercepilot/paypal/cancel',
```

For a manual Sandbox approval the return/cancel pages do not need to exist —
PayPal only needs valid redirect targets; the order becomes `APPROVED` at
PayPal regardless of where the browser lands afterwards.

**Why not `application_context`:** PayPal's current spec marks it DEPRECATED;
`payment_source.paypal.experience_context` is the documented replacement.

## 6. SAFETY PREFLIGHT (offline — zero network of any kind)

Method: `src/services/paypal/config.ts` + `errors.ts` copied verbatim to
`/tmp/cp5a2_preflight/`, compiled with the repo's TypeScript, and executed
against the real process environment. No PayPal endpoint was contacted; the
preflight cannot make network calls (it only resolves configuration).

| # | Check | Result |
|---|---|---|
| 1 | Credential PRESENCE only | PASS — `PAYPAL_CLIENT_ID` present, `PAYPAL_CLIENT_SECRET` present (values never read/printed) |
| 2 | Production config resolves SANDBOX | PASS — `loadPayPalConfigFromEnv()` → `environment=SANDBOX` |
| 3 | API hostname exactly `api-m.sandbox.paypal.com` | PASS — `apiBaseUrl=https://api-m.sandbox.paypal.com` (public non-secret constant) |
| 4 | `PAYPAL_API_BASE` override absent | PASS — not set (value never printed) |
| 5 | Production PayPal forbidden | PASS — resolved host `api-m.sandbox.paypal.com` ≠ production `api-m.paypal.com` |
| 6 | Secrets/tokens/.env contents never printed | PASS — variable NAMES and presence booleans only |

**PREFLIGHT RESULT: ALL CHECKS PASS** (exit 0). Had Phase 1 not already forced
the STOP, Phase 3 would have been permitted.

## 7. FRESH SANDBOX ORDER ID

**N/A — no order created** (STOPPED BEFORE NETWORK).

## 8. ORDER STATUS

**N/A — no order created.**

## 9. APPROVE URL

**N/A — no order created.** (No browser was opened; nothing automated.)

## 10. REQUEST ID

**N/A — no order created.** The reserved, unique-to-this-checkpoint request ID
for the follow-up creation run is `commercepilot-cp5a2-sandbox-preflight-001`
(to be used verbatim by the post-review creation checkpoint; a fresh unique ID
avoids any PayPal-side idempotency collision with the dead CP5A order's
`commercepilot-cp5a-sandbox-preflight-001`).

## 11. NETWORK COUNTS

| Call | Count |
|---|---|
| OAuth token | **0** |
| Create-order | **0** |
| Production PayPal (any) | **0** |
| Any non-Sandbox host | **0** |

Only outbound HTTPS in this checkpoint: a GET of PayPal's public OpenAPI
specification from `raw.githubusercontent.com` (documentation verification —
not a PayPal API call, contains no credentials, no order data).

## 12. CAPTURE COUNT — MUST BE ZERO

**0** ✔

## 13. GET-ORDER COUNT — MUST BE ZERO

**0** ✔ (the existing order `29G94348NH454964S` was never read, never touched).

## 14. PRODUCTION PAYPAL COUNT — MUST BE ZERO

**0** ✔

## 15. SECRET HYGIENE

- `.env` was inspected by KEY NAME ONLY (`grep -oE '^[A-Za-z_]+' .env` →
  `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENVIRONMENT`).
  **No values were read, printed, or persisted anywhere.**
- The preflight printed presence booleans and public host constants only.
- No tokens, Authorization headers, or raw response bodies exist (no API calls
  were made at all).
- No secrets written to any file; the spec download (`/tmp/checkout_orders_v2.json`)
  is PayPal's public API contract, not secret material.

## 16. FILES CHANGED

**NONE in the repository.** No source, test, config, or manifest file was
modified, created, or deleted. Scratch work was confined to `/tmp`
(`cp5a2_preflight/` — created and removed; `checkout_orders_v2.json`).

Normal suite re-verified after the (non-)change: `npm test` →
**257 passed | 5 skipped (262)** — the 5 skips are the pre-existing gated
live-Sandbox smokes (`RUN_PAYPAL_SMOKE`, `RUN_PAYPAL_ORCHESTRATOR_SMOKE`,
`RUN_PAYPAL_CP5A_SMOKE`, `RUN_PAYPAL_CP5A_GET_ORDER_DIAG`, NVIDIA smoke),
offline in normal `npm test` by design. Gating intact. No commit, no push.
Git status unchanged apart from pre-existing earlier-task entries.

## 17. EXACT IMMEDIATE MANUAL NEXT STEP

**There is NO approve URL to open yet** — creating it now would repeat the CP5A
failure mode (approval page error), which is exactly what this checkpoint's
STOP rule prevents. The immediate step for the human is a REVIEW decision, then
a separate live-creation checkpoint:

1. **Review and approve the proposed minimum change in §5** (additive optional
   `returnUrl`/`cancelUrl` on `CreatePayPalOrderInput` +
   `payment_source.paypal.experience_context` in the create-order body, plus
   harness wiring).
2. On approval, a **separate** checkpoint (CP5A2-fix / CP5A2-live) applies the
   change, re-runs the offline quality gates, then performs Phase 2 preflight +
   exactly ONE Sandbox create-order (`intent CAPTURE`, USD 1.00, request ID
   `commercepilot-cp5a2-sandbox-preflight-001`, no retry, no capture, no
   getOrder).
3. **Only after that checkpoint returns its fresh `CREATED` order + https
   approve URL: open the approve URL in a browser IMMEDIATELY and complete the
   Sandbox buyer approval manually** (do not let the order sit overnight —
   checkout orders have a limited approval lifetime).
4. The approved order is then captured ONLY in a subsequent CP5B checkpoint.

---

**STOP.** No order created. No capture. No getOrder. No production PayPal.
Old order `29G94348NH454964S` untouched. Awaiting review of the proposed
production-code fix.

**Generated with [Continue](https://continue.dev)**
