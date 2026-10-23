# TASK 09 CP5A2 LIVE — FINAL REPORT

**Fresh PayPal Sandbox order for immediate manual buyer approval**

---

## 1. STATUS

**⚠️ STOPPED — DEFECT REPORTED, NO USABLE ORDER PRODUCED (single live attempt consumed; NO RERUN).**

The Phase 1 safety preflight passed, the pre-network request-body verification
passed, and exactly ONE live create-order request was performed (plus its one
OAuth request — the only two PayPal requests of this checkpoint). PayPal
responded 2xx with a **fresh order ID** and a **fresh approve URL**, but with
`status: "PAYER_ACTION_REQUIRED"` instead of the checkpoint's required
`status === "CREATED"`. The verification gate correctly aborted before printing
the order details, and per the "Do not rerun" rule the attempt was **not**
repeated. Per "do not patch production code during the live run", the code was
not modified.

**Net result: no order is reported as approved-for-approval. The live attempt
was consumed. CP5B must NOT start. A human decision is required (see §18).**

## 2. SAFETY PREFLIGHT

All assertions passed BEFORE any network call (production code resolution only;
variable NAMES / presence booleans / public constants — never values):

| # | Check | Result |
|---|---|---|
| 1 | Credential PRESENCE only | PASS — `PAYPAL_CLIENT_ID` present, `PAYPAL_CLIENT_SECRET` present |
| 2 | Production config resolves SANDBOX | PASS — `loadPayPalConfigFromEnv()` → `environment=SANDBOX` |
| 3 | API hostname exactly `api-m.sandbox.paypal.com` | PASS |
| 4 | `PAYPAL_API_BASE` override absent | PASS |
| 5 | Production PayPal forbidden | PASS — resolved host ≠ `api-m.paypal.com` |
| 6 | Secrets never printed | PASS — no credential/token/header/.env value emitted |

## 3. REQUEST BODY APPROVAL CONFIG VERIFIED

Verified BEFORE the live request by driving the compiled production
`PayPalService.createOrder()` with a fully in-memory fetch (zero sockets; the
create-order call was stopped locally and its outgoing body captured):

```json
{
  "intent": "CAPTURE",
  "purchase_units": [ { "amount": { "currency_code": "USD", "value": "1.00" } } ],
  "payment_source": {
    "paypal": {
      "experience_context": {
        "return_url": "https://example.com/paypal/return",
        "cancel_url": "https://example.com/paypal/cancel",
        "user_action": "PAY_NOW"
      }
    }
  }
}
```

- `payment_source.paypal.experience_context.return_url` present ✔
- `payment_source.paypal.experience_context.cancel_url` present ✔
- `payment_source.paypal.experience_context.user_action === "PAY_NOW"` ✔
- Deprecated top-level `application_context` absent ✔ (asserted)

## 4. RETURN URL

`https://example.com/paypal/return` (absolute HTTPS placeholder per checkpoint
instructions; sent in the live request; value is public and non-secret).

## 5. CANCEL URL

`https://example.com/paypal/cancel` (absolute HTTPS placeholder per checkpoint
instructions; sent in the live request; value is public and non-secret).

## 6. FRESH SANDBOX ORDER ID

**NOT REPORTED** — the verification gate aborted on the unexpected
`PAYER_ACTION_REQUIRED` status before the (fresh, real) order ID could be
captured into the report. A fresh order ID was assigned by PayPal (the response
was 2xx with an `id`), but emitting it now without being able to verify its
approve URL against this checkpoint's requirements would risk sending the user
to approve an order whose redirect configuration PayPal has not confirmed in
the expected state.

## 7. ORDER STATUS

**`PAYER_ACTION_REQUIRED`** (PayPal's actual response to the single live
create-order) — **NOT** the required `CREATED`.

## 8. APPROVE URL

**NOT REPORTED** — see §6/§7. A fresh https `www.sandbox.paypal.com` approve
URL was returned by PayPal, but the gate aborted before it could be verified
and captured; reporting it unverified is unsafe.

## 9. REQUEST ID

`commercepilot-cp5a2-sandbox-preflight-001` — sent verbatim as
`PayPal-Request-Id` on the single create-order call. Echo verification was not
reached (gate aborted first).

## 10. PAYPAL ENVIRONMENT

SANDBOX (resolved by production code; all traffic to
`api-m.sandbox.paypal.com`; the approve host returned by PayPal was a
`*.sandbox.paypal.com` URL).

## 11. OAUTH REQUEST COUNT

**1**

## 12. CREATE-ORDER REQUEST COUNT

**1** (exactly one attempt; no retry; transport-level retry impossible by
construction — the production service performs one attempt).

## 13. GET-ORDER REQUEST COUNT — MUST BE ZERO

**0** ✔

## 14. CAPTURE REQUEST COUNT — MUST BE ZERO

**0** ✔

## 15. PRODUCTION PAYPAL REQUEST COUNT — MUST BE ZERO

**0** ✔ (ledger: `nonSandboxHostRequests = 0` by construction; only
`api-m.sandbox.paypal.com` was contacted).

## 16. SECRET HYGIENE

- Credential variables checked by PRESENCE only; values never read into output.
- No OAuth token, Authorization header, or `.env` content was ever printed;
  the counting ledger records host/path counts only, never headers/bodies.
- The in-memory dryrun used fake placeholder credentials (`dryrun`), never real
  values.
- Only public, non-secret values appear in this report (request ID, placeholder
  URLs, environment/host names, counts).

## 17. FILES CHANGED — SHOULD BE NONE

**NONE.** Verified mechanically: `git status --porcelain` captured before the
live run and re-diffed after — **identical** (21 baseline entries, all
pre-existing from earlier checkpoints). The production code was executed
verbatim from a compiled copy in `/tmp` (removed after the run to prevent
accidental reruns); the repository working tree was never modified. No commit,
no push.

## 18. EXACT IMMEDIATE HUMAN NEXT STEP

**Do NOT approve anything — there is no verified approve URL.** The immediate
step is a human decision on the observed `PAYER_ACTION_REQUIRED` response:

**Observed behavior:** PayPal accepted the create-order (2xx, fresh order ID,
fresh Sandbox approve URL) but set the order status to
`PAYER_ACTION_REQUIRED` instead of `CREATED`. In PayPal's Orders v2 model this
status means the *payer must perform an additional action* (commonly
non-contiguous-country card/3-D-Secure-style verification) before the payment
source is usable; notably, the checkpoint contract (and the offline suite, and
the CP5A harness) expected `CREATED` for a standard redirect approval order.

**Options for the human (in recommended order):**

1. **Diagnose first (no new order):** the consumed order's details
   (`GET /v2/checkout/orders/{id}` via the existing gated
   `RUN_PAYPAL_CP5A_GET_ORDER_DIAG`-style harness, pointed at the new order ID
   — NOT the dead `29G94348NH454964S`) would reveal which `payer_action`
   PayPal attached (e.g. a verification link) — zero side effects, read-only.
   The order ID exists but was not captured into this report; if the human
   wants it, it must be retrieved from the PayPal developer dashboard
   (Sandbox → transaction/order search) rather than by re-running creation.
2. **If PAYER_ACTION_REQUIRED is judged Sandbox-account-specific** (e.g.
   buyer-country/verification configuration of the Sandbox account rather than
   a code defect): approve a one-line follow-up checkpoint that re-creates the
   order with the SAME contract but an adjusted expectation
   (`CREATED` **or** `PAYER_ACTION_REQUIRED` with the approve URL still
   usable) — or with a different `payment_source` configuration. That is a NEW
   checkpoint (CP5A3), not a rerun of this one.
3. **If it is judged a genuine defect:** stop and redesign per the code-change
   process (the CP5A2 FIX implementation matches PayPal's current spec;
   `PAYER_ACTION_REQUIRED` most plausibly reflects the Sandbox account's
   country/verification settings, not a malformed request — but that must be
   confirmed, not assumed).

**No production code was changed and no fix is proposed inside this live
checkpoint.**

## 19. CONFIRM CP5B NOT STARTED

**CONFIRMED: CP5B NOT STARTED.** No getOrder, no capture, no
CaptureOrchestrator invocation, no polling, no browser automation, no webhook,
no production PayPal. The checkpoint stopped at the verification gate. No
commit, no push. The `/tmp` harness was deleted to make an accidental rerun
impossible; the "do not rerun" rule is enforced by that removal and by this
report.

---

**STOP.**

**Generated with [Continue](https://continue.dev)**
