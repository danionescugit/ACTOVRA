# TASK 09 — E1 STEP 1 LIVE RESULT (CP5E — ONE FRESH ORDER CREATED)

> **UPDATE (post-E1):** This order was subsequently buyer-approved, verified
> `APPROVED` by the authoritative getOrder, and captured exactly once — final
> durable state `COMPLETED`, captureId `4TC56487BS291381N`. See
> `TASK_09_E1_FINAL_REPORT.md`. The sections below are historical.

**Status: STEP 1 COMPLETE — STOPPED AND WAITING FOR HUMAN BUYER APPROVAL.**
Exactly ONE fresh order created with the **current production shape, unchanged**
(no CP5D-FIX, no `payment_method_preference`). No getOrder, no capture, no code
changes, no commit/push. This is the LAST order Task 09 creates.

## Provider Evidence (sanitized; from PayPal's own response)

- **Order ID:** `2TR541296B4116148`
- **Provider status:** `PAYER_ACTION_REQUIRED`
- **Link rel:** `payer-action` (no `approve` rel)
- **Actionable approval URL:**
  `https://www.sandbox.paypal.com/checkoutnow?token=2TR541296B4116148`
- **Self link:** `https://api.sandbox.paypal.com/v2/checkout/orders/2TR541296B4116148`
- `payment_source.paypal` present in response: yes
- Service-normalized `approveUrl`: none (correct — only `approve` rel is normalized)

## Discipline Ledger

- **Request ID:** `commercepilot-cp5e-sandbox-001` (caller-owned, sent verbatim as PayPal-Request-Id)
- **OAuth token calls:** 1
- **Create calls:** 1
- **getOrder calls:** 0
- **Capture calls:** 0
- **Production PayPal calls:** 0 (all traffic to `api-m.sandbox.paypal.com`; preflight-asserted)
- **Retries:** none; single attempt
- **Amount / intent:** USD 1.00 (100 minor units), `intent: CAPTURE`
- **Request shape (dry-run verified byte-for-byte before send):**
  `purchase_units[0].amount {USD 1.00}` +
  `payment_source.paypal.experience_context {return_url, cancel_url, user_action: PAY_NOW}`

## Preflight (all PASS, before any network)

no `PAYPAL_API_BASE` override; environment `SANDBOX`; base
`https://api-m.sandbox.paypal.com`; `PAYPAL_CLIENT_ID` present;
`PAYPAL_CLIENT_SECRET` present. Secrets never printed.

## Process

1. Zero-network **dry-run**: intercepted the exact create request before send; repo untouched (verbatim-compiled production `PayPalService` in `/tmp`).
2. **Live**: one create → 200, `PAYER_ACTION_REQUIRED`, actionable `payer-action` URL.
3. **Order lock**: `/tmp/cp5e_prod/E1_ORDER_LOCK` written; re-running `live` is BLOCKED (exit 3, zero network) — a second create is forbidden for E1.

## Observation (not a root cause — per B′ constraints)

`PAYER_ACTION_REQUIRED` + `payer-action` rel recurs with the unchanged shape,
consistent with prior runs. Per the E1 correction this is **NOT a stop
condition**: this exact shape previously produced a valid payer-action URL and
a completed buyer flow. Whether the order survives to post-approval `APPROVED`
is precisely what STEP 2 will establish.

## NEXT: Human buyer approval (do now, immediately)

Open the URL above in a browser, log in with the **Sandbox Personal account
(RO)**, and complete the purchase exactly as in CP5A2. Then report back —
only then will STEP 2 run: ONE authoritative getOrder (must be `APPROVED`),
then exactly ONE `CaptureOrchestrator` capture (deterministic request ID
`commercepilot-capture-{operationId}`), durable `COMPLETED`, then STOP.

**Dead orders — never to be touched again:** `29G94348NH454964S` (CP5A),
`8F3829085U864673D` (CP5A2). **E1 order:** `2TR541296B4116148` (awaiting approval).

**Generated with [Continue](https://continue.dev)**
