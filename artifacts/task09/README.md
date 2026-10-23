# Task 09 Evidence — PayPal Sandbox Live Verification (E1 / CP5E)

**This is Sandbox-only test evidence.** Every PayPal call behind these
artifacts targeted `api-m.sandbox.paypal.com` / `www.sandbox.paypal.com`.
**No production PayPal transaction occurred** (zero calls to any production
host across all of Task 09).

## What Task 09 proved (complete Sandbox flow)

```
create → buyer approval (human) → provider APPROVED (getOrder) → capture → durable COMPLETED
```

- **Final successful PayPal order:** `2TR541296B4116148`
- **Final capture ID (= transactionId):** `4TC56487BS291381N`
- **Amount:** USD 1.00 (100 minor units)
- **Final durable status:** `COMPLETED`
- Exactly ONE capture attempt; no retries, no polling, single-attempt gates at
  every step (preflight → create → getOrder → orchestrator claim → capture).
- Safety gates were proven on **both** paths: earlier checkpoints exercised the
  failure path (404RESOURCE_NOT_FOUND → abort with zero captures; payer-action
  gate refusals), and E1 proved the success path (APPROVED → one capture →
  evidence-checked COMPLETED).

## Known open item

- The earlier CP5A2 order (`8F3829085U864673D`) was silently removed by PayPal
  after buyer approval (404 RESOURCE_NOT_FOUND, debug ID `f975000ae5404`); its
  **root cause remains undetermined** (dashboard logs showed no expiry/void/
  verification event). The E1 success used the identical request shape, so no
  fix was applied and no cause was promoted to established.

## Contents

| File | Description |
|---|---|
| `e1_commerce_store.db` | Durable SQLite evidence of the E1 capture: operation `commercepilot-op-e1-2TR541296B4116148`, audit trail `DECISION_PROPOSED → POLICY_APPROVED → REQUEST_HUMAN_APPROVAL → HUMAN_APPROVED → EXECUTION_STARTED → PAYPAL_ORDER_CREATED → CAPTURE_STARTED → PAYMENT_COMPLETED`. Byte-identical copy of the run DB (contents never altered). |
| `TASK_09_E1_FINAL_REPORT.md` | Final E1 report: full chain of evidence, call ledger, capture result, durable state. |
| `TASK_09_E1_STEP1_LIVE_RESULT.md` | E1 STEP 1 create-order result (order + payer-action link), updated post-E1. |
| `TASK_09_CP5C_ROOT_CAUSE_AUDIT.md` | Read-only root-cause audit + B′ dashboard-inspection addendum (hypotheses ranked, causes ruled out). |

## Secret hygiene (verified before preservation)

These artifacts were structurally scanned and contain **no credentials or
secrets**: no PayPal client secret, no OAuth access token, no Authorization
header, no `.env` contents. Long byte runs in the DB were proven byte-identical
to an empty same-schema reference database (SQLite schema-serialization
artifacts, not data). Values were never printed during verification.

Note: the repo's `.gitignore` excludes `*.db`, so `e1_commerce_store.db` stays
untracked on disk. If these artifacts are ever committed intentionally, an
explicit ignore exception will be required — deliberate decision, out of scope
for the Task 09 closeout (no commit was made).

**Generated with [Continue](https://continue.dev)**
