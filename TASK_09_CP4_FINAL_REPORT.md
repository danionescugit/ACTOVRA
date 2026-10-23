# TASK 09 CP4 — FINAL REPORT

**Capture Orchestrator (PayPal capture side effect) — offline implementation, quality-gated**

Resumed after computer restart. No CP4 work was restarted or redone. The
pre-existing implementation, test suite, and all unrelated working-tree
changes were preserved.

---

## 1. STATUS

**CP4 COMPLETE — ALL QUALITY GATES PASS**

- Focused offline capture orchestrator suite: **56/56 PASSED** (re-verified after fixes)
- Full test suite: **257 passed / 3 skipped** (skips are the pre-existing live-Sandbox
  smoke tests, which are offline in `npm test` by design)
- Lint: **PASS (0 errors, 0 warnings)**
- Typecheck: **PASS**
- Build: **PASS** (Next.js 16.4.0 Turbopack production build)
- Git status: inspected; CP4 work confined to the three approved files

Three real defects were found by the typecheck/lint gates after restart and were
fixed with minimal, scope-confined changes (see §12 and §20).

## 2. FILES CREATED / CHANGED

CP4 files (untracked, pre-existing from the prior session; NOT recreated):

| File | CP4 role |
| --- | --- |
| `src/orchestrator/captureOrchestrator.ts` | Production implementation (CaptureOrchestrator) |
| `src/orchestrator/captureOrchestrator.test.ts` | Focused offline suite (56 tests) |
| `src/orchestrator/index.ts` | Additive CP4 exports (CP3 exports unchanged) |

Minimum-necessary fixes applied this session (all inside approved scope):

1. `src/orchestrator/captureOrchestrator.ts` — removed the unused
   `PayPalMalformedResponseError` import (lint warning). No behavior change: the
   production classifier already routes malformed-response errors through the
   conservative catch-all (`#classifyCaptureFailure` step 4 → `CAPTURE_AMBIGUOUS`),
   and the test suite proves that behavior with an actual
   `PayPalMalformedResponseError` instance.
2. `src/orchestrator/captureOrchestrator.test.ts` — the `RESOLVED_FAILED` test cast
   used `Extract<CaptureOutcome, { kind: 'RESOLVED_FAILED' }>`, but
   `RESOLVED_FAILED` is a `ReconcileOutcome` variant, so the cast collapsed to
   `never` and hid three property accesses from the compiler. Fixed with
   `Extract<ReconcileOutcome, { kind: 'RESOLVED_FAILED' }>`.
3. `src/orchestrator/captureOrchestrator.test.ts` — the restart-durability test
   called `store.close?.()` on `CommerceOperationStore`, which has no `close`
   method (the closeable is the `StoreDb` handle from `openStoreDb`). The optional
   call was a silent no-op at runtime; the DB was actually closed by `afterEach`.
   Fixed: `makeFileBackedStore()` now also returns the `StoreDb` handle and the
   test closes it explicitly (`storeDb.close()`), matching the real
   process-restart semantics the test intends to simulate.

## 3. PUBLIC API

Additive exports in `src/orchestrator/index.ts` (CP3 surface unchanged):

- `CaptureOrchestrator` (class)
- `PAYPAL_CAPTURE_REQUEST_ID_PREFIX` = `'commercepilot-capture-'`
- `payPalCaptureRequestIdForOperation(operationId)` →
  `'commercepilot-capture-{operationId}'` (deterministic, operation-specific,
  capture-specific, reconstructable after restart)
- `NOT_CAPTURABLE_REASONS`, `NOT_RECONCILABLE_REASONS`,
  `RECOVERY_NOT_APPLICABLE_REASONS` (stable machine-readable reason strings)
- Types: `PayPalCaptureExecutor`, `CaptureOutcome`, `ReconcileOutcome`,
  `CaptureRecoveryResult`, `CaptureOrchestratorOptions`

Methods:

- `captureApprovedOrder(operationId): Promise<CaptureOutcome>`
  — kinds: `CAPTURE_COMPLETED` | `CAPTURE_FAILED` | `CAPTURE_AMBIGUOUS` |
  `CAPTURE_INTEGRITY_FAULT` | `CAPTURE_RECOVERY_REQUIRED` | `NOT_CAPTURABLE`
- `reconcileCapture(operationId): Promise<ReconcileOutcome>`
  — kinds: `RESOLVED_COMPLETED` | `RESOLVED_FAILED` | `UNRESOLVED` |
  `NOT_RECONCILABLE`
- `persistKnownCaptureResult(operationId, result): CaptureRecoveryResult`
  — kinds: `RECOVERED` | `ALREADY_RECOVERED` | `RECOVERY_NOT_APPLICABLE`

## 4. BUYER-APPROVAL GATE

- Buyer approval is verified ONLY against PayPal provider read state
  (`getOrder()`) immediately BEFORE the durable claim:
  - `read.orderStatus === 'APPROVED'` → proceed
  - `CREATED` / anything else → `NOT_CAPTURABLE(BUYER_NOT_APPROVED)`, zero calls
  - read failure (transport/HTTP/malformed) → `APPROVAL_UNVERIFIED`, zero calls
  - read echoing a different PayPal order ID → `APPROVAL_UNVERIFIED`, zero calls
- Owner `approvalStatus`, policy results, browser callbacks, and caller flags are
  NEVER consulted as capture authorization (explicitly tested).
- PayPal reporting `COMPLETED` before capture →
  `NOT_CAPTURABLE(ALREADY_CAPTURED_REMOTELY)` → routes to reconciliation;
  `captureOrder` is never called in that case.
- On ANY doubt: no `CAPTURE_STARTED` event is written and ZERO capture calls occur.

## 5. EXECUTION SEQUENCE

```
load durable operation
→ guards (missing op / CAPTURE_EXECUTING / terminal / wrong status /
  missing persisted paypalOrder / missing decision) — ZERO PayPal calls
→ getOrder() buyer-approval verification (provider evidence only)
→ durable CAPTURE_STARTED claim (single-flight gate)
→ exactly ONE captureOrder() with 'commercepilot-capture-{operationId}'
→ integrity-checked classification
→ durable PAYMENT_COMPLETED / PAYMENT_FAILED (evidence only)
   or operation remains CAPTURE_EXECUTING
```

The capture target PayPal order ID is sourced ONLY from the persisted
`operation.paypalOrder` — never from a caller, callback, or read result.

## 6. SINGLE-FLIGHT / CONCURRENCY

- The store transaction (`BEGIN IMMEDIATE` → transition → snapshot + audit) is
  the authoritative single-flight gate; the invocation whose `CAPTURE_STARTED`
  commits owns the one capture call.
- Claim losers re-read durable state:
  - sees `CAPTURE_EXECUTING` → `NOT_CAPTURABLE(ALREADY_CAPTURING)`, zero calls
  - sees a terminal status (competitor finished first) → `ALREADY_RESOLVED`,
    zero calls — not misreported as a store error
- Proven with two independent store connections over ONE file-backed SQLite DB
  (closest offline simulation of two worker processes): exactly one claim wins,
  exactly one `captureOrder` call.
- Mid-flight test: a second invocation observes the durable claim and makes zero
  capture calls while the first is awaiting its PayPal response.
- A genuine store failure while claiming rethrows and makes ZERO PayPal calls.

## 7. CAPTURE SUCCESS MAPPING

`PAYMENT_COMPLETED` persisted only when ALL integrity checks pass:

- echoed `paypalOrderId` === persisted order ID
- `capture.status === 'COMPLETED'`
- `captureId` non-empty → mapped to BOTH `transactionId` and `captureId`
- `amountMinorUnits` === persisted approved `decision.amount`
- `currency` === persisted approved `decision.currency`

Mapping: captureId → `transactionId` + `captureId`; paypalOrderId →
`paypalOrderId`; amountMinorUnits → `amount`; currency → `currency`;
`success: true`. The exact persisted result is echoed in the
`CAPTURE_COMPLETED` outcome.

## 8. FAILURE CLASSIFICATION

After the durable claim, per error shape:

| Error | Outcome | Durable state |
| --- | --- | --- |
| `ORDER_ALREADY_CAPTURED` (422, prior-capture evidence) | auto-reconcile from read state → `CAPTURE_COMPLETED` or `CAPTURE_AMBIGUOUS`; NEVER FAILED | resolved or stays `CAPTURE_EXECUTING` |
| Definite 4xx rejection | `CAPTURE_FAILED` (caller truth); no capture evidence exists so durable FAILED is impossible per the domain state machine | stays `CAPTURE_EXECUTING` |
| Pre-HTTP local validation / OAuth / config (`PayPalInvalidRequestError`, `PayPalConfigurationError`, `PayPalAuthenticationError`) | `CAPTURE_FAILED` (provably no side effect — no capture request sent) | stays `CAPTURE_EXECUTING` |
| Transport ambiguity (status undefined), 5xx, malformed 2xx, unknown shapes | `CAPTURE_AMBIGUOUS` — remote outcome UNKNOWN | stays `CAPTURE_EXECUTING`; reconcile via getOrder |

No automatic retry, ever. Exactly one capture attempt per successful claim.
2xx results with non-terminal capture status (e.g. PENDING) are also ambiguous.

## 9. AMBIGUOUS OUTCOME BEHAVIOR

`CAPTURE_AMBIGUOUS` / `UNRESOLVED` always mean: remote outcome unknown or not
trustworthy → durable operation remains `CAPTURE_EXECUTING` with `paymentResult`
unset → resolution ONLY through `reconcileCapture()` (getOrder, positive
evidence) or explicit human action. Ambiguity is never mapped to `FAILED`, never
silently swallowed, and never triggers a re-capture.

## 10. RECONCILIATION

`reconcileCapture()` uses `getOrder()` ONLY — it NEVER calls `captureOrder` and
never auto-re-captures. Positive-evidence rules:

- Exactly one COMPLETED capture, integrity-checked vs the persisted decision →
  `RESOLVED_COMPLETED`, durable `COMPLETED`
- Exactly one DECLINED capture with matching amount/currency (equally positive
  evidence funds were NOT captured) → `RESOLVED_FAILED`, durable `FAILED`
- Zero captures / PENDING / multiple captures / foreign-order echo /
  integrity-failing evidence / read failure (transport, 5xx, malformed) →
  `UNRESOLVED`, durable stays `CAPTURE_EXECUTING` ("absence of a capture is not
  proof the capture did not happen")
- Non-capturing / missing operation / incomplete durable data →
  `NOT_RECONCILABLE`

## 11. POST-CAPTURE PERSISTENCE RECOVERY

When PayPal captured but local `PAYMENT_COMPLETED` persistence failed:
- outcome is `CAPTURE_RECOVERY_REQUIRED` carrying the known normalized result;
  durable operation stays `CAPTURE_EXECUTING`
- capture is NEVER repeated
- `persistKnownCaptureResult()` recovers locally with ZERO PayPal calls:
  - same evidence already COMPLETED → idempotent `ALREADY_RECOVERED`
  - conflicting evidence on a COMPLETED operation → refused
    (`CAPTURE_EVIDENCE_CONFLICT`)
  - wrong PayPal order / non-COMPLETED capture / integrity fault / wrong status /
    missing operation → refused with a stable reason
- declined-capture persistence failure stays `CAPTURE_EXECUTING` and is resolved
  by `reconcileCapture()` from the persisted declined capture

## 12. INTEGRITY CHECKS

Every path that could resolve the operation durably checks: echoed order ID
ownership, capture status, captureId presence, amount match, currency match —
against PERSISTED state (order + approved decision), not caller input. Failures
yield `CAPTURE_INTEGRITY_FAULT` (capture path), `UNRESOLVED` (reconciliation
path), or a refusal (`RECOVERY_NOT_APPLICABLE` variants) — never a false
COMPLETED/FAILED. Additional guards: foreign-order echo detection, multiple-
capture distrust, secret redaction in all messages.

## 13. TESTS

`src/orchestrator/captureOrchestrator.test.ts` — 56 tests, offline only, using a
scripted `FakePayPalCaptureExecutor` (records every input, replays scripted
outcomes, supports a held-open capture gate for concurrency tests). Coverage:

1. Deterministic capture request ID (prefix, determinism, capture-specificity, on-wire usage)
2. Happy path (exact typed outcome, exact durable evidence, full audit trail order: claim BEFORE outcome; idempotent re-invocation)
3. Buyer-approval gate (CREATED order, transport failure, 404, foreign-order echo, remote COMPLETED, owner-approval-never-authorizes)
4. Non-eligible statuses (15 durable statuses → correct reason, zero calls, no mutation)
5. Single-flight/concurrency (mid-flight claim, two processes one file DB, lost race to resolved competitor, genuine store failure rethrows)
6. Post-claim failure classification (transport ambiguity, 5xx, malformed 2xx, unknown shape, definite 4xx, pre-HTTP validation, OAuth, config, ORDER_ALREADY_CAPTURED → auto-reconcile resolved & unresolved)
7. Capture result integrity (foreign order, amount, currency, empty captureId, PENDING, DECLINED → durable FAILED with evidence + audit)
8. Remote success + local persistence failure (recovery required, zero-call recovery, idempotent repeat, evidence conflict, wrong order, non-completed, integrity fault, wrong status, missing op)
9. Reconciliation (COMPLETED read, DECLINED read, zero captures, PENDING, transport, 5xx, multiple captures, amount integrity, foreign echo, non-capturing, missing/resolved)
10. Restart durability (CAPTURE_EXECUTING survives reopen; duplicate claims still rejected; reconciliation resolves without re-capture)
11. Secret hygiene (bearer/token/secret redaction in outcomes and snapshots; boundary typing: PayPalService structurally satisfies PayPalCaptureExecutor with placeholder values, no network)

## 14. FULL TEST RESULT

```
npm test
Test Files  9 passed | 3 skipped (12)
     Tests  257 passed | 3 skipped (260)
```

- `captureOrchestrator.test.ts`: 56/56 PASSED (re-verified after fixes)
- The 3 skipped files are the pre-existing live-PayPal-Sandbox smoke tests
  (`commerceExecutionOrchestrator.sandboxSmoke`, `paypalSandboxSmoke`,
  `nvidia.smoke`) — offline by design in `npm test`. No live calls were made.

## 15. LINT

```
npm run lint  →  eslint  →  exit 0, 0 errors, 0 warnings
```
(The one pre-existing warning — unused `PayPalMalformedResponseError` import —
was fixed; behavior verified unchanged by the suite.)

## 16. TYPECHECK

```
npm run typecheck  →  tsc --noEmit  →  exit 0, no errors
```
(Three real defects that vitest does not surface were found and fixed —
see §2 / §12.)

## 17. BUILD

```
npm run build  →  next build  →  PASS
▲ Next.js 16.4.0 (Turbopack) — compiled successfully in 1119ms
TypeScript: OK; static pages: 4/4; routes: / , /_not-found
```

## 18. SECRET HYGIENE

- The orchestrator never reads `.env`, never logs, never stores secrets.
- All failure/ambiguity messages pass through `sanitizeMessage()` (defense in
  depth beyond the PayPal boundary's contract): `sk-…` keys, `Bearer` tokens,
  `access_token=`, `client_secret=`, `Authorization:` headers → `[REDACTED]`.
- Tested: secret-shaped values injected via PayPal errors never appear in
  outcomes or in persisted snapshots; not even in ambiguous/NOT_CAPTURABLE
  messages.
- This session: no `.env` access, no credentials printed, no network calls, no
  PayPal Sandbox calls.

## 19. COMMERCIAL-LIFECYCLE CHECK

The capture orchestrator keys ONLY on the durable `PAYPAL_ORDER_CREATED` status
plus provider evidence. It never reads `approvalStatus` or `policyResult` as
capture authorization, so upstream lifecycle stages (Offer → Owner Approval →
Customer Acceptance → Payment Checkout → Buyer Approval) can be introduced
later without rewriting capture. No webhooks, no UI/API wiring added.

## 20. FILES OUTSIDE ALLOWED SCOPE

None touched by CP4. Git status contains only PRE-EXISTING changes from earlier
tasks (store, package manifests, README, prior task reports, prior
domain/policy/agents/services work). The only modifications made this session
were the three minimal fixes in:

- `src/orchestrator/captureOrchestrator.ts` (removed one unused import)
- `src/orchestrator/captureOrchestrator.test.ts` (type-correct `ReconcileOutcome`
  cast; explicit `StoreDb.close()` in the restart test)

No domain, state-machine, store, PayPal-service, API-route, or UI files were
modified. No `git reset`/`clean`/`restore`/`stash`, no commit, no push.

## 21. GIT STATUS

```
On branch main
Changes not staged for commit:
	modified:   .gitignore          (pre-existing, earlier task)
	modified:   README.md           (pre-existing)
	modified:   package-lock.json   (pre-existing)
	modified:   package.json        (pre-existing)
	modified:   src/store/index.test.ts (pre-existing)
	modified:   src/store/index.ts      (pre-existing)

Untracked files:
	.continue/  NVIDIA_AGENT_TEST.md  TASK_02A_FINAL_REPORT.md
	TASK_02_COMPLETION_REPORT.md  TASK_03_FINAL_REPORT.md
	src/agents/  src/domain/  src/orchestrator/  src/policy/
	src/services/  src/store/db.test.ts  src/store/db.ts
```

CP4 work is confined to `src/orchestrator/captureOrchestrator.ts`,
`src/orchestrator/captureOrchestrator.test.ts`, and the additive CP4 block of
`src/orchestrator/index.ts` (all inside the untracked `src/orchestrator/`
directory; CP3 files in that directory are untouched this session).

## 22. REMAINING RISKS

1. PayPal-side request-ID/idempotency semantics cannot be verified from this
   repository (documented in-code). CP4 safety never depends on PayPal-side
   dedupe: single-flight + at-most-one-attempt are primary; the stable request
   ID is defense in depth.
2. Reconciliation read models may lag PayPal's write side; zero-capture reads
   are treated as UNRESOLVED (never FAILED) — correct but may require operator
   patience for eventual resolution.
3. Definite 4xx capture rejections leave the durable operation
   `CAPTURE_EXECUTING` (domain evidence rule); explicit resolution (operator or
   future policy) is required to terminalize them.
4. Live Sandbox behavior (real auth, real request-ID handling, real read lag) is
   untested by design at this checkpoint — the skipped smoke tests cover it next.

## 23. RECOMMENDED NEXT CHECKPOINT

CP5 (proposed): live PayPal SANDBOX verification — run the already-existing
skipped smoke suites with sandbox credentials to validate end-to-end
create → approve → capture → reconcile against the real API, still making no
production/owner-approval assumptions. Before that: ensure `.env` handling
stays excluded from git (backup gate already verified `.env` excluded) and keep
the pre-CP4 backup
`/mnt/f/!SAAS Succes!/CommercePilot_Backup_2026-10-15_1349_post_task09_cp3_pre_cp4`
as rollback protection only.

---

**Generated with [Continue](https://continue.dev)**
