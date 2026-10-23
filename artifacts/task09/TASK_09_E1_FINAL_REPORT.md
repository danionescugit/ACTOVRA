# TASK 09 — E1 FINAL REPORT (CP5E): LIVE CAPTURE PROVEN END-TO-END

**Status: E1 COMPLETE — SUCCESS.** The full CommercePilot pipeline moved real
value in PayPal Sandbox: **one fresh order → human buyer approval → provider
`APPROVED` → exactly ONE capture → durable `COMPLETED` with truthful capture
evidence.** Current production code, unchanged (no CP5D-FIX; no
`payment_method_preference`).

## Authoritative Chain of Evidence

### STEP 1 — Create (single attempt)
- **Order ID:** `2TR541296B4116148` · **Request ID:** `commercepilot-cp5e-sandbox-001`
- Response: HTTP 200, `status: PAYER_ACTION_REQUIRED`, `payer-action` link
  `https://www.sandbox.paypal.com/checkoutnow?token=2TR541296B4116148`
- Zero-network dry-run verified the exact request body first; second create blocked by order lock.
- Human completed the Sandbox buyer flow (RO Personal account); PayPal redirected to
  `return_url` with `token=2TR541296B4116148`.

### STEP 2 — ONE authoritative getOrder (single attempt)
- **Provider status: `APPROVED`** · captures reported: **0** · echoed ID matched exactly.
- First time in Task 09 a payer-action order survived to post-approval `APPROVED`.

### STEP 3 — Production CaptureOrchestrator (single attempt)
- Real `CaptureOrchestrator.captureApprovedOrder()` + real `PayPalService` +
  real file-backed `CommerceOperationStore` (`node:sqlite`). No fakes in the PayPal path.
- The existing order was bound into a durable operation using only sanctioned
  state-machine events (no direct snapshot writes, no invented orders):
  `commercepilot-op-e1-2TR541296B4116148` (opportunity `opp-003`,
  decision USD 1.00 CREATE_PAYMENT → customer-demo-001).
- Orchestrator flow executed exactly as designed:
  durable guards → **internal getOrder verification (`APPROVED`) → durable
  `CAPTURE_STARTED` claim (single-flight) → ONE `captureOrder` with
  deterministic request ID `commercepilot-capture-commercepilot-op-e1-2TR541296B4116148`
  → integrity checks → durable `PAYMENT_COMPLETED`**.

## Complete Capture Result

```json
{
  "kind": "CAPTURE_COMPLETED",
  "operationId": "commercepilot-op-e1-2TR541296B4116148",
  "paymentResult": {
    "success": true,
    "transactionId": "4TC56487BS291381N",
    "captureId": "4TC56487BS291381N",
    "paypalOrderId": "2TR541296B4116148",
    "amount": 100,
    "currency": "USD"
  }
}
```

Integrity verified by the orchestrator before persistence: captureId non-empty;
amount 100 minor units = approved decision amount; currency USD = approved
currency; echoed `paypalOrderId` = persisted order. Evidence-based `COMPLETED` only.

## Final Durable State

- Operation `commercepilot-op-e1-2TR541296B4116148`: **status `COMPLETED`**, paymentResult persisted as above.
- Audit trail (append-only, store-validated):
  `1:DECISION_PROPOSED → 2:POLICY_APPROVED → 3:REQUEST_HUMAN_APPROVAL →
  4:HUMAN_APPROVED → 5:EXECUTION_STARTED → 6:PAYPAL_ORDER_CREATED →
  7:CAPTURE_STARTED → 8:PAYMENT_COMPLETED`
- Store: `/tmp/cp5e_prod/e1_commerce_store.db` (kept — the only local copy of the
  durable capture evidence; harness locks also there prevent any rerun).

## E1 Call Ledger (all to `api-m.sandbox.paypal.com`; production calls: 0)

| Step | OAuth | create | getOrder | capture |
|---|---|---|---|---|
| STEP 1 | 1 | 1 | 0 | 0 |
| STEP 2 | 1 | 0 | 1 | 0 |
| STEP 3 | 2 | 0 | 1 (orchestrator verification) | **1** |
| **E1 total** | **4** | **1** | **2** | **1** |

No retries anywhere. No polling. Every step gated and single-attempt.

## Task 09 Lifetime Live Totals

- Orders created: 2 (`8F3829085U864673D` CP5A2 — dead, silent removal, under
  dashboard debug IDs `f6844911f6f01`/`f344219283ff2`/`f975000ae5404`;
  `2TR541296B4116148` E1 — **COMPLETED**). `29G94348NH454964S` (CP5A) never created by us.
- getOrder: 4 (2 diagnostic + STEP 2 + orchestrator verification).
- **Captures: 1 (successful, evidence-verified).** Production PayPal: 0. Money-equivalent value moved in Sandbox: USD 1.00.

## Findings & Honest Notes

1. **Live capture is now PROVEN against real PayPal Sandbox** — Task 09's last
   unproven element. CP1–CP4 offline gates (269 tests) + this live run = full proof.
2. **The payer-action order lifecycle worked this time**: `PAYER_ACTION_REQUIRED`
   at create did NOT prevent approval→capture. The prior silent 404
   (`8F3829085U864673D`) therefore remains **mechanism-undetermined** (B′
   constraints still apply: expiry/purge/timing vs payer-action retirement —
   not established). Hypothesis landscape is unchanged by this success; we did
   not "fix" anything — same shape, different outcome, cause unknown.
3. Buyer approval occurred **within minutes** of creation this time (vs ~days
   of elapsed time across CP5A2's create→approval cycle) — consistent with, but
   not proof of, the sandbox-expiry hypothesis. Not promoted to root cause.
4. The production `approveUrl` normalization only surfaces `approve` rels;
   payer-action URLs are extracted at the harness layer for this flow. Task 10
   integration should treat `payer-action` as an actionable approval link too.

## Task 09 Verdict (canonical, post-closeout)

**TASK 09 = COMPLETE / PASS / LIVE-PROVEN.**

- **269 offline tests passing** (5 gated live-smoke tests skipped, as designed);
  lint / typecheck / build all clean at closeout.
- **Exactly one successful live Sandbox capture** — order `2TR541296B4116148`,
  captureId `4TC56487BS291381N`, USD 1.00, durable `COMPLETED`.
- **Zero production PayPal calls** across the entire task (all traffic to
  `api-m.sandbox.paypal.com`; host-counted ledger on every run).
- **No retries, no polling** — every live step was preflight-gated,
  single-attempt, and lock-protected (second create/getOrder/capture
  structurally impossible via the harness).
- **Safety gates proven on both failure and success paths:** failure path via
  CP5A2 (payer-action gate refusals; post-approval 404 → abort with zero
  captures) and CP5B (refused browser redirect as authorization); success path
  via E1 (provider `APPROVED` verified → single durable claim → one capture →
  integrity-checked `COMPLETED`).
- Evidence preserved in `artifacts/task09/` (Sandbox-only; secret-hygiene
  verified; DB byte-identical copy).
- No commit, no push (per standing checkpoint rules). Dead orders never to be
  touched again: `29G94348NH454964S`, `8F3829085U864673D`. E1 order
  `2TR541296B4116148`: COMPLETED — final.

**Next: Task 10** (webhooks, real return_url route, UI/API wiring).
Live-capture risk to Task 10 is retired.

**Generated with [Continue](https://continue.dev)**
