# CommercePilot — Task 10 CP4 offline report

Date: 2026-10-28.

CP4 implementation and offline validation: PASS.
Checkpoint gate: DEPLOYMENT_REQUIRED_FOR_E2E.
Full CP4/E2E status: PARTIAL — live validation intentionally not started under the latest user instruction.
HACKATHON_BACKEND_FREEZE = NOT_RECOMMENDED until deployed Sandbox E2E passes.

The canonical hostname is a future configuration target. Its deployment/reachability has not been assumed or tested. No live PayPal calls, credentials requested, tunnel, deployment, DNS change, commit, push or Task 11 work.

Baseline and fresh Backup Gate

Inspected Git status, CP2/CP3 reports, actual application/composition/API code, store/domain/orchestrator APIs and relevant tests before editing. CP3 code and working-tree state match the supplied baseline. Existing CP2/CP3 work preserved; HEAD remains `122d4f9`. Compared 53 pre-existing source/report/ignore files against the fresh backup checksums: unchanged (excluding the two explicitly extended application files).

Before edits, ran the approved canonical utility:

```sh
/home/dan/bin/backup-project '/home/dan/Paypal app' CommercePilot pre_task10_cp4_post_cp2_cp3 --seconds --exclude .continue
```

```text
BACKUP_GATE=PASS
VERIFICATION=PASS
DESTINATION=/mnt/f/!SAAS Succes!/CommercePilot_Backup_2026-10-28_225248_pre_task10_cp4_post_cp2_cp3
FILES=88
BYTES=1170774
```

Canonical defaults excluded secret env files; `.continue` was additionally excluded from traversal. Backup copied/verified source without changing it.

CP4 changes

- Created `src/app/paypal/return/route.ts` and `src/app/paypal/cancel/route.ts`.
- Created `src/server/paypalCallbacks.ts`: correlation, named application call and minimal UI handoff.
- Modified `src/server/commercePilotApp.ts`: added read-only `findOperationByPayPalOrderId`, scanning the existing list of persisted operations. Exact single matches only; duplicates fail closed.
- Created `src/server/paypalCallbacks.test.ts`: 20 offline cases.
- Modified `src/server/commercePilotApp.test.ts`: updated the sanctioned method-surface assertion to include the new read method.
- Updated `AGENT_PERMISSIONS.md`; created this report.

Return: requires exactly one nonempty token, maximum 200 characters; correlates the exact persisted order to an operation, then invokes `application.captureOperation(operation.id)`. The unchanged CaptureOrchestrator rereads the persisted order, verifies provider APPROVED, claims capture durably, attempts capture once, and validates evidence before recording completion. Browser token/PayerID/status/operationId/payment fields never authorize or select a capture target. Unknown or ambiguous correlation returns 404; missing/invalid/duplicate token returns 400.

Cancel: optional token correlates for presentation only. No events, payment-state changes or provider calls. Missing token redirects to the home route with an informational indicator; unknown token returns 404.

Known callbacks return a 303 redirect to `/operations/{id}?paypal=returned`, `review-required`, or `approval-not-completed`. These indicators are presentation hints, never payment evidence. Responses have `Cache-Control: no-store` and `Referrer-Policy: no-referrer`; callback tokens and PayerID are not forwarded. Unexpected errors return a fixed 500 error code without provider/configuration details. The future detail page is intentionally not built; it belongs to Task 11, and currently returns 404 even if callback processing has completed. Final truth is available through the existing GET operation API.

Capture/reconcile application wiring already existed and was reused unchanged. No capture/reconcile HTTP endpoint or automatic reconciliation was necessary. Ambiguous captures remain CAPTURE_EXECUTING; repeated returns cannot recapture. Manual sanctioned reconciliation remains available through the existing application service if later needed.

Offline evidence

20 new tests use actual route exports, the real composition/application/store/orchestrators and fake PayPal boundary methods. They prove unknown/fabricated/duplicate token refusal, PayerID-only refusal, exact persisted correlation despite foreign selectors, rejection of browser-supplied authorization/events/state/results, provider non-APPROVED/wrong-order/read-error refusal, provider-approved completion, provider verification before capture, truthful payment evidence/audit, persistence after restart, concurrent/repeated return safety, no double capture after resolution, ambiguity without retry/reconcile, cancel without mutation/provider traffic, ambiguous stored correlation failure, and safe error output. Every new test asserts zero fetch traffic.

| Final gate | Result |
| --- | --- |
| `npm test` | PASS: 374 passed, 5 skipped; 14 test files passed, 5 live suites skipped |
| `npm run lint` | PASS, exit 0 |
| `npm run typecheck` | PASS, exit 0 |
| `npm run build` | PASS, exit 0; both callbacks and four existing API routes dynamic |

All 354 baseline tests remain green. Installed Next.js 16.4 guidance was read; Cache Components uses Node.js by default and disallows explicit runtime exports. Request URL access occurs outside the callback error adapter to allow correct dynamic rendering. No domain states, schema, orchestrator logic, dependencies or HTTPS rules changed.

Validation reused the CP3 temporary external guard and local-only font mocks. Secret env files were hidden from tooling, live smoke switches explicitly zero, telemetry disabled for build, no outbound provider calls. Only the existing node:sqlite experimental warnings remain.

Live evidence: operation/order/capture IDs, pre-capture provider status, final live durable status and live audit are all NOT YET AVAILABLE. createOrder calls = 0; capture calls = 0; production PayPal calls = 0. No live attempt consumed. No backend feature blocker identified offline; deployment and actual buyer/capture validation remain required before freeze.

Deployment handoff — exactly five items

1. **What must be deployed.** Deploy this complete CP2+CP3+CP4 Next.js checkout as a Node.js application (validated on Node 22.21.0), with the four existing operation APIs and both callback routes on `https://commercepilot.toolspacehub.com`. Use one application/store installation with a persistent writable SQLite directory, retained across restarts. Terminate valid public HTTPS and forward both callback paths to this application. Do not deploy local Task 09 evidence, runtime databases, `.continue`, or secret env files as source artifacts. No final UI is needed to validate callbacks; operation detail UI remains Task 11.

2. **Required non-secret environment variable names.** Set `COMMERCEPILOT_PUBLIC_BASE_URL=https://commercepilot.toolspacehub.com`, `COMMERCEPILOT_DB_PATH` to the deployment's persistent writable database file (for example `/srv/commercepilot-data/commerce.db`), and `PAYPAL_ENVIRONMENT=SANDBOX`. Leave the optional `PAYPAL_API_BASE` override unset, or ensure an existing override is exactly `https://api-m.sandbox.paypal.com`. Runtime must already have its Sandbox-only configuration through the deployment operator; no credential values are requested or included here. Do not read/copy `.env` or `.env.save` to perform this checkpoint.

3. **PayPal Sandbox Dashboard return/cancel configuration.** No Dashboard callback configuration is introduced or required by this implementation: the existing Orders create request supplies both URLs per order via `payment_source.paypal.experience_context.return_url` and `cancel_url`. The exact values must be `https://commercepilot.toolspacehub.com/paypal/return` and `https://commercepilot.toolspacehub.com/paypal/cancel`. These are buyer redirect URLs, not webhook endpoints. No Dashboard change has been performed.

4. **Exact deployment verification steps (no PayPal calls).** On the deployment host, verify Node version, install locked dependencies, run the four validated quality gates with live smoke switches disabled, and start the production app using `npm start` behind HTTPS. Ensure the configured DB directory is writable by that app and persists across restart. From a client, run the following without `-L` (do not follow redirects):

   ```sh
   curl --proto '=https' --silent --show-error --include 'https://commercepilot.toolspacehub.com/'
   curl --proto '=https' --silent --show-error --include 'https://commercepilot.toolspacehub.com/paypal/return'
   curl --proto '=https' --silent --show-error --include 'https://commercepilot.toolspacehub.com/paypal/cancel'
   curl --proto '=https' --silent --show-error --include 'https://commercepilot.toolspacehub.com/api/operations/cp4-deployment-probe-nonexistent'
   curl --proto '=https' --silent --show-error --include --request POST --header 'Content-Type: application/json' --data '{}' 'https://commercepilot.toolspacehub.com/api/operations'
   curl --proto '=https' --silent --show-error --include --request POST --header 'Content-Type: application/json' --data '{}' 'https://commercepilot.toolspacehub.com/api/operations/cp4-deployment-probe-nonexistent/approve'
   curl --proto '=https' --silent --show-error --include --request POST --header 'Content-Type: application/json' --data '{}' 'https://commercepilot.toolspacehub.com/api/operations/cp4-deployment-probe-nonexistent/execute'
   ```

   Expected: root 200; return 400/INVALID_CALLBACK; cancel 303 to `/?paypal=approval-not-completed`; missing operation GET/approve/execute 404/OPERATION_NOT_FOUND; invalid create body 400/INVALID_INPUT. Operation/callback responses must be no-store. Valid TLS must succeed without `--insecure`. A 500 on operation reads indicates runtime/store configuration is not ready: stop there. These probes must make zero PayPal calls. Confirm the deployed callback source/build is this checkpoint. No deployment verification was executed in this turn.

5. **Exact next E2E command/step after deployment.** Once deployment verification passes and live execution is authorized again, create one synthetic operation through the real API:

   ```sh
   curl --proto '=https' --fail-with-body --silent --show-error --request POST --header 'Content-Type: application/json' --data '{"opportunityId":"opp-001"}' 'https://commercepilot.toolspacehub.com/api/operations'
   ```

   Retain the returned `operationId`. Invoke POST `/api/operations/{operationId}/approve` with `{}` for owner approval, then POST `/api/operations/{operationId}/execute` with `{}` exactly once to create one Sandbox order. Require the returned actionable Sandbox approval URL; stop at HUMAN_ACTION_REQUIRED and provide the operation ID, order ID and approval URL. The human must open that URL, approve with a Sandbox buyer, and let PayPal redirect through the configured `/paypal/return`. Do not simulate approval, retry order creation/capture, manually substitute an arbitrary order, or poll. After human confirmation, read GET `/api/operations/{operationId}` and verify durable COMPLETED, matching PayPal capture evidence and audit sequence `DECISION_PROPOSED → POLICY_APPROVED → REQUEST_HUMAN_APPROVAL → HUMAN_APPROVED → EXECUTION_STARTED → PAYPAL_ORDER_CREATED → CAPTURE_STARTED → PAYMENT_COMPLETED`. If ambiguous, stop capture activity and use only the existing sanctioned read/reconcile path. Recommend backend freeze only after this evidence exists.

Preservation and stop

`.env` and `.env.save` were not read, printed, copied or modified. Secret variants remain ignored and `.env.example` remains trackable. `.continue/`, `NVIDIA_AGENT_TEST.md` and Task 09 evidence remain untouched. No LICENSE added. No new production infrastructure, UI/AG Grid, webhook, connector, proprietary intelligence or background processing.

Final Git status is recorded below. CP2/CP3 source changes remain uncommitted, and no destructive Git command was run.

```text
 M .gitignore
 M src/orchestrator/commerceExecutionOrchestrator.test.ts
 M src/orchestrator/commerceExecutionOrchestrator.ts
 M src/orchestrator/index.ts
 M src/services/paypal/paypalService.test.ts
 M src/services/paypal/paypalService.ts
?? .continue/
?? .env.example
?? AGENT_PERMISSIONS.md
?? NVIDIA_AGENT_TEST.md
?? TASK_10_CP2_FINAL_REPORT.md
?? TASK_10_CP3_FINAL_REPORT.md
?? TASK_10_CP4_REPORT.md
?? docs/
?? src/app/api/
?? src/app/paypal/
?? src/config/
?? src/server/
```

```text
PROJECT: CommercePilot
DIRECTORY: /home/dan/Paypal app
TASK: TASK 10 CP4 — return/cancel wiring and offline validation; live E2E deployment gate
STATUS: PARTIAL
NEXT STEP: Deploy canonical HTTPS application, then authorize the single Sandbox E2E
```
