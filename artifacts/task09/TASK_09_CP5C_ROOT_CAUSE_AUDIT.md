# TASK 09 CP5C — ROOT-CAUSE AUDIT (READ-ONLY)

**Why the Sandbox order returned RESOURCE_NOT_FOUND immediately after successful manual buyer approval — and the smallest safe next experiment**

Zero PayPal API calls, zero code changes, zero commits. Public documentation
only (PayPal's official `checkout_orders_v2.json` OpenAPI specification,
re-fetched to `/tmp` — not a PayPal API call, no credentials).

---

## 1. STATUS

**AUDIT COMPLETE.** Primary root-cause hypothesis established with strong
official-documentation support, several causes definitively ruled out, and a
smallest-safe-next-experiment recommended (Option B′, not implemented).

## 2. VERIFIED FACTS

Treated as authoritative (from the checkpoint + prior checkpoint reports):

1. Create returned **HTTP 200** with `status: "PAYER_ACTION_REQUIRED"`, a
   `self` link and a **`payer-action`** link
   (`https://www.sandbox.paypal.com/checkoutnow?token=8F3829085U864673D`).
2. Pre-approval, a read-only getOrder **succeeded** (same order, same host):
   `PAYER_ACTION_REQUIRED`, `captures = 0` → the order existed on PayPal's
   read side **before** approval, under the exact credentials later used.
3. The human used the **correct Sandbox Personal account (RO)**; login
   succeeded; the PayPal-hosted page showed amount 1.00 USD and the final
   purchase button; the human clicked it.
4. PayPal then redirected the browser to the configured
   `https://example.com/paypal/return` with `token=8F3829085U864673D` and a
   PayerID — i.e. PayPal itself treated the buyer flow as **completed and
   redirected on success**.
5. Immediately after, production `getOrder` for the SAME order ID — after a
   **successful OAuth** on the SAME host — returned **HTTP 404
   RESOURCE_NOT_FOUND**. Capture was correctly not attempted.

The contradiction to explain: **PayPal's own hosted flow says "approved,
here is your payer"** while **PayPal's Orders API says "no such resource."**

## 3. LOCAL CODE FINDINGS

- `PayPalService.getOrder()` builds
  `GET {config.apiBaseUrl}/v2/checkout/orders/{encodeURIComponent(id)}` —
  base URL and path are constants from `config.ts`; the ID is percent-encoded
  but **16-char alphanumeric IDs are unchanged** by `encodeURIComponent`.
  No truncation/transform is possible in this path.
- `getOrder` maps **any** non-2xx to `PayPalHttpApiError` with
  `status` + PayPal's own `name`/`message` extracted from the error body
  (`extractApiErrorNameAndMessage`). It **cannot fabricate** a
  `RESOURCE_NOT_FOUND` name/message from a different provider response: those
  strings were parsed from PayPal's own 404 body. A 2xx response could never
  surface as 404 (2xx → zod-parse → result; a schema miss would be
  `PayPalMalformedResponseError`, not a 404). Conversely a real 200-with-different-ID
  would have thrown a **mismatch**, not a 404 — so the 404 came from PayPal
  for **this** ID.
- OAuth happens per call from the same `config` object as the GET — no
  credential/endpoint divergence is possible inside one service instance.
- Local `.env` untouched since **2026-10-13 13:31** (mtime; key names only:
  `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENVIRONMENT`) — stable
  across the pre-approval diagnostic (success) and the post-approval read
  (404), so credentials did not change between those calls.

## 4. ENVIRONMENT/CREDENTIAL CONSISTENCY

**Consistent — ruled out.** Both the successful pre-approval read and the 404
post-approval read used the same compiled-from-repo `PayPalService`, the same
`loadPayPalConfigFromEnv()` output (`SANDBOX`, `api-m.sandbox.paypal.com`, no
`PAYPAL_API_BASE` override — asserted by preflight in both runs), and the same
`.env` (mtime unchanged). No second application/credential set exists in the
repo. The dashboard log itself shows the same app (`CommercePilot Hackathon`)
serving the create.

## 5. CREATE REQUEST ASSESSMENT

Our recorded request matches the CP5A2 FIX implementation and was **accepted
by PayPal** (200). One deviation from PayPal's official example for this exact
shape exists and is likely **significant**:

- **Official example** (`00_orders_create`, "PayPal Wallet as Payment Source,
  Resulting in PAYER_ACTION_REQUIRED Response") includes
  `payment_method_preference: "IMMEDIATE_PAYMENT_REQUIRED"` and
  `shipping_preference: "GET_FROM_FILE"`.
- **Ours omitted `payment_method_preference`** (schema default:
  `UNRESTRICTED`) — i.e. PayPal had **no guarantee of immediate payment**.

PayPal's spec documents the response shape we received as a **first-class
outcome** of exactly this request family: HTTP 200, `payment_source.paypal: {}`,
and a `payer-action` link (not an `approve` link). `PAYER_ACTION_REQUIRED` is
a documented member of the `order_status` enum
(`CREATED, SAVED, APPROVED, VOIDED, COMPLETED, PAYER_ACTION_REQUIRED`).

## 6. BUYER FLOW ASSESSMENT

The buyer flow the human experienced was **consistent with a
PAYER_ACTION_REQUIRED order**: PayPal's hosted flow for such an order includes
an extra payer-side step (authentication/verification). The human completed
it (correct Sandbox Personal account), clicked the final purchase button, and
PayPal redirected to `return_url` with token + PayerID — a **successful
redirect**. Nothing in the buyer flow indicates user error.

## 7. POST-APPROVAL 404 ANALYSIS

The decisive evidence: **PayPal's own spec carries an `authorize` 422 example
whose response contains BOTH `PAYER_ACTION_REQUIRED` and a `payer-action`
link** — i.e. in Orders v2, when a payer action is outstanding, order-lifecycle
operations do not simply fail; PayPal **points the caller back at the
payer-action URL**. Our pre-approval read confirmed the order sat in
`PAYER_ACTION_REQUIRED`. The post-approval 404 therefore most plausibly means:

- the payer-action path completed a **buyer-side step** (authentication/consent),
  and PayPal moved/retired the order resource out of the readable
  `PAYER_ACTION_REQUIRED` state — without ever producing a normal
  `APPROVED`/capture-able order — because the order's payment method carried
  **no immediate-payment requirement** (`UNRESTRICTED`), leaving the
  payer-action lifecycle in a state that does not map to the standard
  `CREATED → APPROVED → capture` chain; and/or
- PayPal-side expiry/cleanup of payer-action orders that were not completed
  through the expected loop.

What the 404 is **not**: an environment/credential mismatch (§4), a URL/ID bug
(§3), a normalization artifact (§3 — the name/message were PayPal's own), or a
consequence of `example.com` return URLs (§9).

**Explicit limitation:** local evidence cannot establish PayPal's internal
semantics for post-payer-action order retention. The authoritative check is
the **Developer Dashboard API/Event log** for the create/get/capture calls
around the approval — which is exactly what Option B inspects (humans only;
no application API calls).

## 8. POSSIBLE ROOT CAUSES (RANKED)

1. **(PRIMARY) Payer-action order lifecycle divergence** — the order was
   created as a *payer-action* order (`payer-action` link, `payment_source.paypal: {}`),
   partly because `payment_method_preference` defaulted to `UNRESTRICTED`.
   After the buyer-side action, PayPal retired/invalidated the resource
   instead of transitioning it to `APPROVED` — the payer-action flow never
   feeds the standard `APPROVED → capture` lifecycle. *(Spec-supported; fits
   every observed fact.)*
2. **(Contributing) Sandbox-account-side payer verification** (RO personal
   account) forcing the extra step at creation — explains why we got
   `PAYER_ACTION_REQUIRED` instead of `CREATED` in the first place; may be
   co-cause with #1. *(Plausible; dashboard/log check will confirm.)*
3. **PayPal-side expiry/purge of payer-action orders** — order lifetimes are
   real (checkout orders expire; the spec references expiry semantics for
   payment flows); a payer-action order may have a shorter practical
   lifetime. *(Plausible secondary; cannot be confirmed from local evidence.)*

## 9. ROOT CAUSES RULED OUT

- **Host/environment mismatch** — impossible: same compiled service, same
  config object, preflight-asserted `api-m.sandbox.paypal.com`; and the
  pre-approval read on the identical host succeeded. ✔ ruled out
- **Different app/credentials between calls** — `.env` untouched (mtime), key
  names stable, single config source, OAuth succeeded post-approval. ✔ ruled out
- **Order-ID transformation/truncation** — `encodeURIComponent` on a
  16-char alphanumeric token is a no-op; the echoed order ID in the successful
  pre-approval read matched exactly. ✔ ruled out
- **URL-build error in `PayPalService`** — constant `PAYPAL_ORDERS_PATH`
  template; proven by the successful pre-approval read. ✔ ruled out
- **Normalization fabricating a 404** — `RESOURCE_NOT_FOUND` + message were
  parsed from PayPal's own response body; a 2xx cannot map to a 404; a
  valid-2xx-with-foreign-ID would mismatch, not 404. ✔ ruled out
- **`example.com` return/cancel placeholders affecting order availability** —
  return/cancel URLs are redirect targets only; PayPal already used them
  successfully (the redirect carried token + PayerID). They cannot
  invalidate the order resource. ✔ ruled out
- **OAuth credentials changed** — same `.env`; OAuth succeeded immediately
  before the 404. ✔ ruled out

## 10. PAYPAL DOCUMENTATION FINDINGS (public spec only)

1. `PAYER_ACTION_REQUIRED` is a documented `order_status` — not an anomaly.
2. PayPal's **official create example** for a PayPal-wallet `payment_source`
   with `experience_context` (return_url/cancel_url/user_action PAY_NOW) is
   documented as returning **HTTP 200 + `PAYER_ACTION_REQUIRED` + a
   `payer-action` link** — our response matches the documented example
   **field for field**.
3. The spec's `authorize` 422 example shows PayPal responding to lifecycle
   operations on payer-action orders with `PAYER_ACTION_REQUIRED` + the
   payer-action URL — evidence that payer-action orders live outside the
   normal `CREATED → APPROVED` chain until the action resolves.
4. The spec does **not** document post-payer-action order retention or a
   `PAYER_ACTION_REQUIRED → APPROVED` transition — **local evidence is
   insufficient to establish those PayPal semantics** (stated explicitly,
   per the task).
5. `payee_payment_method_preference` defaults to `UNRESTRICTED`;
   `IMMEDIATE_PAYMENT_REQUIRED` is the documented option our request omitted.

## 11. WHETHER COMMERCEPILOT BEHAVED CORRECTLY

**Yes — at every gate.**
- CP5A2 FIX code produced a spec-conformant request PayPal accepted (200).
- The pre-approval read-only diagnostic was correctly gated and correct.
- CP5B refused to treat the browser redirect as capture authorization,
  demanded provider `APPROVED`, got a 404, and **stopped with zero captures**.
- No false durable state was ever recorded; no money moved; secrets never
  surfaced. The safety architecture (provider-evidence gate, single-flight,
  evidence-integrity) performed exactly as designed.

## 12. OPTION A ASSESSMENT

**Repeat create → manual approval → immediate getOrder/capture.**
- Pros: end-to-end proof if it works; tests hypothesis #2 (account config).
- Cons: **repeats everything that failed**, still blind to PayPal-side
  semantics, and repeats the manual buyer flow; highest chance of another
  dead end; if `PAYER_ACTION_REQUIRED` recurs we still won't know why.
- Verdict: **not recommended as the next step** (largest step, least learning).

## 13. OPTION B ASSESSMENT

**Create → manual approval → inspect Developer Dashboard API/Event logs
BEFORE any application getOrder.**
- Pros: the **only** source of PayPal-side truth (server-side statuses,
  debug IDs, event log); directly distinguishes root causes #1 vs #2 vs #3;
  requires **zero additional PayPal API calls** to learn the most; matches
  the audit's "do not assume Sandbox instability without evidence" directive.
- Cons: manual (human) effort; log detail level not guaranteed.
- Verdict: **strongest candidate — but as a two-phase variant (B′, §16)**,
  because a *pre-approval* API-log check can answer the key question without
  any buyer flow at all.

## 14. OPTION C ASSESSMENT

**Real local return_url route; inspect token/PayerID server-side before getOrder.**
- Pros: useful eventually for production integration (and gives a clean place
  to log the redirect); matches checkpoint guidance not to add routes merely
  for a smoke.
- Cons: **cannot explain or prevent the 404** — return/cancel URLs are
  redirect targets only (ruled out as a cause in §9); adds Next.js route work
  (out of the smoke's minimal scope).
- Verdict: **defer to Task 10** (real integration wiring).

## 15. OPTION D ASSESSMENT

**Use PayPal's recommended standard Orders v2 shape if our payment_source flow
causes a lifecycle difference.**
- Pros: directly targets the primary hypothesis. PayPal's own docs describe
  our exact `payment_source.paypal.experience_context` wallet flow as the
  **payer-action** flow; the *standard* redirect-approval integration (which
  yields `CREATED` + an `approve` link + the normal `APPROVED` lifecycle) is
  the **JS SDK** (`@paypal/paypal-js` Smart Buttons) or the legacy
  `application_context` shape. A minimal, spec-aligned candidate fix: add
  `payment_method_preference: "IMMEDIATE_PAYMENT_REQUIRED"` (+ optionally
  `shipping_preference: "NO_SHIPPING"`) to the existing `experience_context` —
  the documented example for exactly our shape.
- Cons: requires a small production-code change (out of CP5C scope; would
  need its own approved checkpoint like CP5A2 FIX); JS SDK route adds a
  client-side dependency (hackathon-scope decision).
- Verdict: **the right direction after B′ confirms the cause** — smallest code
  change first (`payment_method_preference`), JS SDK only if needed.

## 16. RECOMMENDED SMALLEST NEXT EXPERIMENT

**Option B′ — "dashboard-first, then decide" (human-only, minimal app calls):**

1. **Human, zero application API calls:** in the Developer Dashboard for
   `CommercePilot Hackathon`, inspect the **API log** for
   `8F3829085U864673D`: the create (200, `PAYER_ACTION_REQUIRED`), the
   pre-approval getOrder (200), and the post-approval getOrder (404) — plus
   any **Event/Webhook log** entries for the order around the approval.
   Decision point:
   - If the logs show the order was expired/voided/retired after the payer
     action → root cause confirmed as #1/#3 → proceed to the minimal code
     change (Option D: add `IMMEDIATE_PAYMENT_REQUIRED`, then a single
     create→approve→capture run).
   - If the logs show account/verification causes → fix sandbox account
     configuration first, then repeat.
2. **Only if logs are inconclusive:** the minimal API-side probe is a **new
   create-order only** (no approval flow) run twice — once as-is, once with
   `payment_method_preference: "IMMEDIATE_PAYMENT_REQUIRED"` — comparing the
   returned status + link rel (`payer-action` vs `approve`). Two creates,
   zero buyer flow, zero captures; directly proves or refutes hypothesis #1
   with the smallest possible footprint.

No option is implemented in this checkpoint.

## 17. WHETHER LIVE CAPTURE IS REQUIRED BEFORE TASK 10

**Not strictly required — but strongly recommended if it can be achieved in
one bounded attempt.**

- **Not required:** CP1–CP4's durable architecture (provider-evidence gate,
  single-flight claim, evidence integrity, recovery) is fully implemented and
  offline-proven (269 tests); Task 10 integration work (webhooks/UI/API)
  does not depend on a completed live capture, and a real integration (Task 10)
  will exercise the same capture path against Sandbox anyway.
- **Recommended (hackathon value):** one clean **create → approve → capture →
  COMPLETED** run is the demo-worthy proof that the whole CommercePilot
  pipeline moves real money-equivalent value in Sandbox — high signaling value
  for a hackathon, and it retires the biggest known unknown (capture
  integrity against real PayPal). Given the recurring payer-action issue, the
  attempt should be **time-boxed** and abandoned after one more structured try
  following B′'s findings.

## 18. TIME/RISK IMPACT ON HACKATHON

- Time spent so far on the live-capture line is significant (CP5A → CP5B);
  each full cycle requires human-in-the-loop buyer approval.
- Risk of **another failed cycle** is material while the payer-action cause is
  unconfirmed — hence B′ first (cheap, human-only, high information).
- Risk to Task 10 of skipping live capture: low (architecture is complete and
  gated; integration work proceeds independently).
- Recommended budget: **one** B′ dashboard session + **one** bounded CP5D
  attempt (~30–60 min total). If it fails again, document and move to Task 10.

## 19. RECOMMENDED DECISION

1. **Proceed with Option B′ now** (human dashboard inspection; zero app API
   calls; no code changes).
2. Based on B′: approve the **minimal D-fix** (add
   `payment_method_preference: "IMMEDIATE_PAYMENT_REQUIRED"` — plus optionally
   `shipping_preference: "NO_SHIPPING"` — to the existing
   `experience_context`, mirroring PayPal's official example for this shape)
   through its own code checkpoint with offline tests, then **one bounded
   live create → approve → capture** checkpoint.
3. **Do not block Task 10** on live-capture success: if the bounded attempt
   fails again, record findings and proceed to Task 10 (the capture path will
   be exercised by real integration).
4. Never re-attempt on the dead orders (`29G94348NH454964S`,
   `8F3829085U864673D`); always fresh order, immediate approval, immediate
   capture.

## 20. EXACT NEXT CHECKPOINT IF APPROVED

**CP5C-B′ (human, zero network):** inspect the Developer Dashboard API/Event
logs for `8F3829085U864673D` (create 200 + payer-action link; pre-approval
getOrder 200 `PAYER_ACTION_REQUIRED`; post-approval getOrder 404) and report
any order-lifetime/event entries → decision point per §16.

**Then CP5D-FIX (code-only):** add `payment_method_preference:
"IMMEDIATE_PAYMENT_REQUIRED"` (+ optional `shipping_preference:
"NO_SHIPPING"`) to `payment_source.paypal.experience_context` in
`PayPalService.createOrder()` (additive optional fields, same validation
pattern as CP5A2 FIX, offline tests proving body shape + backward
compatibility; all quality gates).

**Then CP5D-LIVE (single bounded run):** preflight → ONE create (fresh unique
request ID, e.g. `commercepilot-cp5d-sandbox-001`) → verify `CREATED` + an
**`approve`** rel link (not `payer-action`) → human approves IMMEDIATELY →
Phase 2 getOrder must return `APPROVED` → production CaptureOrchestrator,
exactly ONE capture → verify durable `COMPLETED` + evidence → STOP. If
`PAYER_ACTION_REQUIRED` recurs or any gate fails: STOP, report, proceed to
Task 10 per §19.3.

---

**STOP.** No PayPal API calls were made in this checkpoint (public spec fetch
from GitHub only). No code changes. No create. No capture. No commit, no push.

---

# ADDENDUM — CP5C-B′ RESULTS (HUMAN DASHBOARD INSPECTION)

**B′ COMPLETE.** Zero application API calls (human Developer Dashboard
inspection only). The findings below are authoritative and **supersede the
pre-B′ hypothesis ranking in §8**.

## B′ Evidence (SANDBOX, app "CommercePilot Hackathon", order 8F3829085U864673D)

1. `POST /v2/checkout/orders` → **200**, debug ID `f6844911f6f01`
2. `GET /v2/checkout/orders/8F3829085U864673D` (pre-approval) → **200**, debug ID `f344219283ff2`
3. `GET /v2/checkout/orders/8F3829085U864673D` (post-buyer-flow) → **404**, debug ID `f975000ae5404`
   - Body: `name: RESOURCE_NOT_FOUND`, `details[0]: { issue: INVALID_RESOURCE_ID, description: "Specified resource ID does not exist. Please check the resource ID and try again." }`, `message: "The specified resource does not exist."`, `debug_id: f975000ae5404`
   - Header: `paypal-debug-id: f975000ae5404`, `status: 404`, `Date: Tue, 20 Oct 2026 18:08:49 GMT`
4. Error logs 20–21 Oct: the **only** entry for this order/app is the same GET 404. No additional reason supplied.
5. Webhook events: **none** displayed for the inspected window.

## Interpretation Constraints (per inspection)

- Dashboard evidence does **NOT** say: expired, voided, payer-verification failed, funding source failed, `payment_method_preference` missing, payer-action-caused retirement, or return_url-caused deletion. **None of these may be promoted to established root cause.**
- There is **NO** dashboard evidence proving that omission of `payment_method_preference` caused the 404.
- Timestamp display discrepancy (list `20/10/26 11:08` vs header `18:08:49 GMT`) is consistent with a timezone display offset; **order lifetime must not be inferred from display timestamps.**
- No webhook subscription was configured for this app during Task 09 (webhooks are Task 10 scope), so webhook silence is expected and carries little evidential weight.

## B′ Verdict

**Non-discriminating on mechanism; conclusive on facts.** The client-side
ledger is complete and accurate (exactly three calls, debug IDs match). The
404 is PayPal's own `INVALID_RESOURCE_ID` — the order was readable at T1 and
did not exist at T2, and PayPal logged **no event, webhook, or error**
explaining the removal. The removal was **silent**. No hidden calls; no
captures; CommercePilot's gates held throughout.

## Updated Hypothesis Ranking (supersedes §8)

1. **Silent PayPal-side order removal, mechanism undetermined** (generic sandbox expiry/purge OR payer-action retirement without event trail) — HIGH confidence the removal was silent and PayPal-side; **LOW** on mechanism.
2. **Payer-action lifecycle divergence** — MEDIUM-LOW (downgraded from primary; no B′ confirmation; the cause of `PAYER_ACTION_REQUIRED` at create is itself unproven).
3. **Sandbox account/instrument state** (RO verification / missing funding source) — LOW, **untested** (B′ Step 2 account-status check was not reported).
4. **`payment_method_preference` omission** — VERY LOW as a 404 cause; a documented spec deviation only.

## `payment_method_preference` Reclassification

**EXPERIMENTAL, not evidence-based.** Zero dashboard evidence connects its
omission to the 404. Its documented purpose is create-time immediate-payment
enforcement; it may plausibly change the create-time status/link rel, but
nothing observed links it to post-approval resource retention. Treat strictly
as a one-variable probe — never as a "fix."

## Smallest Next Experiment: E1 (adaptive create-only probe, folded into the gated live attempt; no code change)

- **Step 1:** ONE `POST /v2/checkout/orders` with the **current production shape** → inspect `status` + link rels only.
  - `CREATED` + `approve` rel → this create IS the attempt's order: human approves immediately → ONE getOrder (must be `APPROVED`) → exactly ONE capture → durable `COMPLETED` → STOP.
  - `PAYER_ACTION_REQUIRED` + `payer-action` rel → STOP this order (no buyer flow, no capture). Fork: (a) zero-call dashboard account check; (b) only if approved, CP5D-FIX then ONE create with `IMMEDIATE_PAYMENT_REQUIRED` (comparison only).
- **Hard caps:** ≤2 creates, ≤1 getOrder, ≤1 capture (+ up to 4 OAuth token requests). Fresh order/request ID. STOP permanently on any gate failure.

## Stop/Go

**CONDITIONAL GO** for ONE final bounded live attempt with the current shape
(**no code change first**). **Task 10 proceeds unconditionally** after E1,
regardless of result.

**B′ network total: ZERO application PayPal calls. No code changes. No
create. No capture. No commit, no push.**

**Generated with [Continue](https://continue.dev)**
