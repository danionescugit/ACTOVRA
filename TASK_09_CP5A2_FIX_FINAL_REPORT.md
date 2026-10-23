# TASK 09 CP5A2 FIX — FINAL REPORT

**PayPal manual buyer-approval flow configuration — code-only checkpoint**

---

## 1. STATUS

**CP5A2 FIX COMPLETE — ALL QUALITY GATES PASS. NO NETWORK, NO ORDER CREATED.**

- Focused CP5A2 FIX suite: **12/12 PASSED** (offline, scripted transport only)
- Full test suite: **269 passed | 5 skipped (274)** — skips are the pre-existing
  gated live-Sandbox smokes, offline in normal `npm test` by design
- Lint: **PASS (exit 0)** · Typecheck: **PASS (exit 0)** · Build: **PASS (exit 0)**
- Zero PayPal network calls. No live Sandbox order. No capture. No getOrder.
- No commit, no push.

## 2. ROOT CAUSE

The production `createOrder()` built its request body from `intent` +
`purchase_units` (+ optional `custom_id`) only. It sent **no**
`payment_source.paypal.experience_context` (and no deprecated top-level
`application_context`), therefore no `return_url` / `cancel_url` /
`user_action`. PayPal's Orders v2 contract (verified in the CP5A2 preflight
checkpoint against `paypal/paypal-rest-api-specifications` →
`openapi/checkout_orders_v2.json`) requires redirect-approval configuration at
`payment_source.paypal.experience_context`; without a suitable `return_url`
the buyer-facing redirect approval can fail with the documented
"Things don't appear to be working at the moment" experience — exactly the
Sandbox symptom recorded for the dead CP5A order `29G94348NH454964S`.

## 3. FILES CHANGED

| File | Change |
| --- | --- |
| `src/services/paypal/paypalService.ts` | Additive optional `returnUrl`/`cancelUrl` on `CreatePayPalOrderInput`; pre-HTTP pairing + HTTPS URL validation; `payment_source.paypal.experience_context` in the request body when both are supplied; doc comments. |
| `src/services/paypal/paypalService.test.ts` | New offline `create-order redirect approval flow (CP5A2 FIX)` suite — 12 tests proving all ten required validation points. |
| `src/services/paypal/paypalSandboxCp5aGetOrderDiagnostic.test.ts` | **Gate repair only** (disclosed): `let diagError: PayPalHttpApiError \| undefined` was a pre-existing typecheck error — a plain object literal was assigned where the full error class type was declared. The declaration now matches the sanitized-fields shape the code always intended. **Type-level only; zero runtime change.** |
| `src/services/paypal/index.ts` | **Unchanged** — `CreatePayPalOrderInput` is already re-exported, so no export surface change was required. |

Nothing else touched: domain, state machine, store, capture orchestrator,
commerce execution orchestrator, UI, and API routes are untouched. No `.env`
access. Git state otherwise unchanged; no commit, no push.

## 4. PUBLIC API CHANGE

Additive and fully backward compatible (`src/services/paypal/paypalService.ts`):

```ts
export interface CreatePayPalOrderInput {
  // ...existing fields unchanged...
  /** URL PayPal redirects the buyer's browser to AFTER approval.
   *  MUST be paired with cancelUrl (both or neither). Absolute HTTPS only;
   *  validated BEFORE any network call. */
  readonly returnUrl?: string;
  /** URL PayPal redirects the buyer's browser to on cancellation.
   *  MUST be paired with returnUrl (both or neither). Absolute HTTPS only;
   *  validated BEFORE any network call. */
  readonly cancelUrl?: string;
}
```

- `PayPalCreateOrderResult`, `captureOrder`, `getOrder`, error classes, and all
  existing exports are unchanged. Callers that never pass the new fields see
  byte-identical behavior (proven by the untouched 59 pre-existing service
  tests, all passing).

## 5. REQUEST BODY CHANGE

When BOTH `returnUrl` and `cancelUrl` are supplied, `createOrder()` sends:

```json
{
  "intent": "CAPTURE",
  "purchase_units": [ { "amount": { "currency_code": "USD", "value": "1.00" } } ],
  "payment_source": {
    "paypal": {
      "experience_context": {
        "return_url": "<returnUrl>",
        "cancel_url": "<cancelUrl>",
        "user_action": "PAY_NOW"
      }
    }
  }
}
```

- Current (non-deprecated) PayPal Orders v2 location only. The deprecated
  top-level `application_context` is **never** sent (asserted by test).
- `user_action: "PAY_NOW"` renders an explicit pay button for the buyer.
- With neither URL supplied the body is byte-identical to the pre-change
  behavior (asserted by test).
- Response parsing, `PayPal-Request-Id` handling, single-attempt discipline,
  and the error model are unchanged.

## 6. VALIDATION RULES

All enforced in `createOrder()`'s local-validation block — BEFORE OAuth and
BEFORE any HTTP call; never silently normalized:

1. **Pairing rule:** either both `returnUrl` and `cancelUrl` are absent, or
   both are present. Exactly one supplied → `PayPalInvalidRequestError`
   ("returnUrl and cancelUrl must be supplied together or both omitted
   (half-configured approval flow rejected)"). No default URLs are ever
   invented.
2. **Absolute URL parse:** each supplied value must parse with `new URL()`;
   malformed values → `PayPalInvalidRequestError`.
3. **HTTPS only:** `parsed.protocol !== 'https:'` → `PayPalInvalidRequestError`
   (rejects `http://` and any non-https scheme; case-insensitive per URL spec).
4. **Non-empty strings** when supplied.
5. Errors **name the offending field** (`returnUrl` / `cancelUrl`) but never
   echo the value, credentials, or tokens.

## 7. BACKWARD COMPATIBILITY

- Omitting both fields leaves the request body exactly as before (test proves
  `intent` + `purchase_units` byte-equality and the absence of
  `payment_source`/`application_context`).
- Server-only/non-browser callers are never forced into redirect configuration.
- All 59 pre-existing service tests pass unchanged; the commerce execution
  orchestrator (which calls `createOrder` without the new fields) is untouched
  and its suite passes unchanged.

## 8. FOCUSED TEST RESULT

`create-order redirect approval flow (CP5A2 FIX)` — **12/12 PASSED**, fully
offline (scripted `MockFetch`; violation tests use a transport with zero queued
responses so any HTTP attempt would fail loudly, and assert `mock.calls.length
=== 0`):

1. BOTH URLs supplied → body contains
   `payment_source.paypal.experience_context.return_url` / `.cancel_url` /
   `.user_action === "PAY_NOW"`; deprecated `application_context` absent. ✅
2. NEITHER supplied → no `payment_source`, body identical to before. ✅
3. returnUrl only → rejected pre-network. ✅
4. cancelUrl only → rejected pre-network. ✅
5. Malformed returnUrl → rejected pre-network. ✅
6. Malformed cancelUrl → rejected pre-network. ✅
7. HTTP returnUrl → rejected pre-network. ✅
8. HTTP cancelUrl → rejected pre-network. ✅
9. Validation errors never echo URL values, client secret, or token (invalid
   values and credential-bearing URLs both covered). ✅
   - Plus 9b: a *structurally valid* HTTPS URL containing credential-shaped
     text is accepted by validation (no over-rejection) and any later
     transport failure still exposes no secrets. ✅
   - Plus explicit pairing-message assertion + no-silent-normalization
     (`HTTP://…` upper-case scheme rejected as-is). ✅

## 9. FULL TEST RESULT

```
npm test
Test Files  9 passed | 5 skipped (14)
     Tests  269 passed | 5 skipped (274)
```

(+12 tests vs. the pre-checkpoint 257; 71/71 in `paypalService.test.ts`.)
The 5 skipped files remain the gated live-Sandbox smokes
(`RUN_PAYPAL_SMOKE`, `RUN_PAYPAL_ORCHESTRATOR_SMOKE`, `RUN_PAYPAL_CP5A_SMOKE`,
`RUN_PAYPAL_CP5A_GET_ORDER_DIAG`, NVIDIA smoke) — **normal `npm test` stays
network-free**; gating logic untouched this checkpoint.

## 10. LINT

```
npm run lint  →  eslint  →  exit 0 (no errors, no warnings)
```

## 11. TYPECHECK

```
npm run typecheck  →  tsc --noEmit  →  exit 0
```

(Only after the disclosed type-only repair of the pre-existing
`paypalSandboxCp5aGetOrderDiagnostic.test.ts` defect described in §3; that
error predated this checkpoint and blocked the gate regardless of this fix.)

## 12. BUILD

```
npm run build  →  next build  →  exit 0
▲ Next.js 16.4.0 (Turbopack) — compiled successfully
TypeScript: OK; static pages: 4/4; routes: / , /_not-found
```

## 13. NETWORK REQUEST COUNT — MUST BE ZERO

**0.** All tests use scripted in-process transports. No live PayPal call of any
kind: create-order 0, capture 0, getOrder 0, OAuth 0, production 0. No browser
opened, no order created, no CP5B started.

## 14. SECRET HYGIENE

- No `.env` access; no credential values read anywhere in this checkpoint.
- Test constants are fake (`fake-client-id`, `fake-client-secret`,
  `fake-access-token`), consistent with the file's existing convention.
- URL-validation errors name fields only — proven by tests never to contain
  the secret-shaped values, tokens, or the invalid URL text itself.
- No secrets in this report or in any changed file.

## 15. REMAINING RISKS

1. PayPal-side acceptance of `experience_context` in this exact shape can only
   be proven live (next checkpoint). The shape was verified against PayPal's
   current official OpenAPI specification (`checkout_orders_v2.json`,
   `paypal_wallet_experience_context`), but Sandbox validation is authoritative.
2. The return/cancel targets for the live manual-approval run must still be
   chosen (any absolute HTTPS URL works for a manual Sandbox approval — the
   buyer lands there after approving; the order becomes `APPROVED` regardless).
   The live checkpoint will wire these into the harness explicitly.
3. `user_action: 'PAY_NOW'` changes the button label the buyer sees; this is
   the conventional choice for an explicit one-item manual approval and matches
   the checkpoint contract.
4. The gate repair (§3) is type-only; the diagnostic harness's runtime behavior
   is unchanged, but it remains a gated live tool that has not been re-run.

## 16. EXACT NEXT CHECKPOINT

**CP5A2 LIVE (create the fresh Sandbox order):**

1. Update/clone the CP5A preflight harness (gated, e.g.
   `RUN_PAYPAL_CP5A2_SMOKE=1`, skipped in normal `npm test`) to call
   `createOrder` with `intent CAPTURE`, USD 1.00, a new unique request ID
   (`commercepilot-cp5a2-sandbox-preflight-001`), and BOTH
   `returnUrl`/`cancelUrl` (absolute HTTPS, e.g.
   `https://example.com/commercepilot/paypal/return|cancel`).
2. Re-run Phase 2 safety preflight (credential presence, SANDBOX resolution,
   exact `api-m.sandbox.paypal.com` host, no `PAYPAL_API_BASE` override).
3. Exactly ONE create-order (no retry). Verify fresh order ID, `CREATED`,
   HTTPS approve URL on `www.sandbox.paypal.com`, SANDBOX environment, request
   ID echo; ZERO capture, ZERO getOrder, ZERO production.
4. Return the approve URL and STOP — the human then opens it IMMEDIATELY and
   approves manually (order lifetime is limited; do not let it sit overnight).
   Capture remains CP5B.

**STOP.** Code-only checkpoint complete. No live order created. No capture.
No production PayPal. No commit, no push.

**Generated with [Continue](https://continue.dev)**
