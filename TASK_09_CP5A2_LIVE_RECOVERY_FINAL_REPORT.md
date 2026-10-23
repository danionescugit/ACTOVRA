# TASK 09 CP5A2 LIVE RECOVERY — FINAL REPORT

**Read-only diagnostic of the `PAYER_ACTION_REQUIRED` order — no new order, no code changes**

Recovery route selected by the human: **READ-ONLY DIAGNOSTIC** (option 1).
The order ID `8F3829085U864673D` was supplied by the human from the PayPal
developer dashboard (it was created by the single CP5A2 LIVE create-order
attempt with request ID `commercepilot-cp5a2-sandbox-preflight-001`, whose
fresh order ID/approve URL were not captured at the time because the
verification gate aborted on the unexpected status).

---

## 1. STATUS

**RECOVERY DIAGNOSTIC COMPLETE — PayPal CONFIRMS `PAYER_ACTION_REQUIRED`.**

The single read-only call (one OAuth + one `GET
/v2/checkout/orders/8F3829085U864673D`) succeeded, and PayPal's authoritative
read side confirms the order exists in `PAYER_ACTION_REQUIRED` state with
**zero captures**. This is NOT a transient/reporting artifact: the order is
persistently in payer-action state, and the diagnostic captured **no approve
link** (see §3 — PayPal's read response for this order exposes no `approve`
rel link at all).

**Conclusion:** the CP5A2 LIVE order is not approvable as-is; a human decision
on the follow-up checkpoint (CP5A3) is required. No capture, no creation, no
code changes; CP5B NOT started.

## 2. PREFLIGHT

All assertions passed BEFORE any network call (names/presence/public constants
only — never secret values):

| # | Check | Result |
|---|---|---|
| 1 | Credential PRESENCE only | PASS — `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` present |
| 2 | Production config resolves SANDBOX | PASS |
| 3 | Host exactly `api-m.sandbox.paypal.com` | PASS |
| 4 | `PAYPAL_API_BASE` override absent | PASS |
| 5 | Production PayPal forbidden | PASS — ≠ `api-m.paypal.com` |
| 6 | Secrets never printed | PASS |

## 3. DIAGNOSTIC RESULT (normalized, non-secret)

| Field | Value |
|---|---|
| paypalOrderId | `8F3829085U864673D` (echo matches requested order) |
| orderStatus | **`PAYER_ACTION_REQUIRED`** (confirmed by PayPal read side) |
| captures | **0** (no capture evidence — consistent with CP5A2 LIVE having made no capture) |
| environment | SANDBOX |

Additional safety observation: the read-model parse (which tolerates arbitrary
link arrays) surfaced **no `approve` link in the get-order response** —
consistent with the create-time response carrying an approve URL whose use
currently leads to the payer-action/verification step rather than a plain
Pay Now approval. The diagnostic did not follow, fetch, or open any link.

## 4. NETWORK LEDGER

| Call | Count |
|---|---|
| OAuth token | **1** |
| GET order | **1** |
| create-order | **0** ✔ |
| capture | **0** ✔ |
| production PayPal | **0** ✔ |
| non-Sandbox host | 0 |
| forbidden path | 0 |
| Total | 2 |

## 5. SECRET HYGIENE

- Credential variables by PRESENCE only; values never read/printed.
- Ledger records host/path counts only — never headers, tokens, or bodies.
- Output limited to normalized, non-secret order-level fields (order ID, status,
  capture count, environment, counts). No raw response body printed.
- The supplied order ID and the original request ID are public, non-secret.

## 6. FILES CHANGED

**NONE in the repository.** Verified mechanically: post-run
`git status --porcelain` diffed against the pre-live baseline — the only
difference is this checkpoint's own report file
(`TASK_09_CP5A2_LIVE_RECOVERY_FINAL_REPORT.md`, untracked documentation,
created after the run). Production code was executed verbatim from a compiled
`/tmp` copy, **removed after the run** to prevent accidental reruns. No
commit, no push.

## 7. ROOT-CAUSE ASSESSMENT (for the human decision)

The order is persistently `PAYER_ACTION_REQUIRED` with zero captures. In
PayPal's Orders v2 model this status means the payer must complete an
additional verification action before the payment source is usable. Given:

- the request body matched PayPal's current spec exactly
  (`payment_source.paypal.experience_context` with return/cancel + PAY_NOW;
  verified pre-network and by the CP5A2 FIX offline suite), and
- PayPal accepted the request (2xx, fresh order, fresh Sandbox approve URL),

the most plausible causes are **Sandbox-account-side** (e.g. the sandbox
buyer/account country or verification configuration triggering a mandatory
payer action), **not** a malformed request from CommercePilot. This must be
confirmed by the human (e.g. in the PayPal developer dashboard: the order's
payer action details, and the sandbox account's country settings) before any
further live order is created.

## 8. RECOMMENDED NEXT CHECKPOINT (human decision required)

**CP5A3 (proposed, needs human approval before any network):** ONE fresh
create-order with the SAME approved contract, but:

- expectation adjusted to `CREATED` **or** `PAYER_ACTION_REQUIRED` with the
  approve URL verified usable for manual approval, and
- (optionally, if the human changes the sandbox buyer/account configuration)
  creation immediately after that change.

This checkpoint (RECOVERY) is complete: **STOP**. No new order was created
(exactly-zero create-order calls), the dead CP5A order
`29G94348NH454964S` was never touched, and CP5B is NOT started.

**Generated with [Continue](https://continue.dev)**
