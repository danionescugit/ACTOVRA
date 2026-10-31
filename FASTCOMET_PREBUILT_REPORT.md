# CommercePilot — verified FastComet prebuilt release

Date: 2026-10-29. Preparation complete; no upload, deployment, FastComet access, DNS change or PayPal API call.

1. Backup Gate

First action was the canonical backup, with all env variants and `.continue` excluded:

```text
BACKUP_GATE=PASS
VERIFICATION=PASS
DESTINATION=/mnt/f/!SAAS Succes!/CommercePilot_Backup_2026-10-29_113652_pre_fastcomet_prebuilt
FILES=94
```

2. Local environment

Node.js `v22.21.0`, npm `10.9.4`, Linux x64, glibc 2.39. FastComet target supplied by user: Node.js 24.22.1, Passenger, Production mode. No remote environment was accessed.

3. Chosen architecture

Normal prebuilt Next.js production output plus traced runtime dependencies, served by the existing verified Next public programmatic API/Passenger server. The installed Next.js 16.4 custom-server guide explicitly says the custom server and generated standalone server cannot be combined. Its output-tracing guide documents assembling deployments from the emitted `.nft.json` files. No standalone switch or unsupported replacement of its generated server was used.

The root release entry `server.js` forwards to `runtime/server.js` in the same process. That nested file is byte-for-byte the existing project Passenger entry. It prepares Next in production from its own directory, forwards every request, and uses the provided numeric PORT or Passenger's automatic binding when PORT is omitted. No fixed hostname/service port, extra framework, process manager, proxy or infrastructure was introduced.

All packaged dependencies reside under `runtime/node_modules`. The existing cPanel-managed root `node_modules` symlink can stay untouched and is not used by this bundle. This avoids both the host's module-symlink build problem and root Selector directory ownership assumptions.

4. Changes

- Source `next.config.ts`, source `server.js`, `package.json`, `package-lock.json`, and application/domain/store/orchestrator code: unchanged.
- Staged config only: equivalent CommonJS `runtime/next.config.js`, generated from the source TypeScript config; retains `cacheComponents: true` and `partialPrefetching: true`. No TypeScript compilation is needed at startup.
- Staged metadata only: minimal root package with `start: node server.js`; runtime package metadata and required traced dependencies.
- Project documentation: this report, permissions journal entry, and a supersession note in `PASSENGER_DEPLOYMENT_PREPARATION.md` directing away from the now-invalid remote-build procedure.
- Checked 64 pre-existing source/config/package/CP2-CP4 report files against the fresh backup: all unchanged.

5. Required gates

| Gate | Result |
| --- | --- |
| `npm test` | PASS — 374 passed, 5 skipped; 14 test files passed, 5 live suites skipped |
| `npm run lint` | PASS — exit 0 |
| `npm run typecheck` | PASS — exit 0 |
| `npm run build` | PASS — exit 0; four operation API routes and both callbacks dynamic |

All gates ran locally. Secret env files were hidden from tooling; provider credential variables were unset for the build; live test switches were zero. The release contains real production font assets (11 valid WOFF2 files), not the previous validation-only font fixtures. No provider calls were needed.

6. Staged and extracted production verification

Original stage: `/tmp/commercepilot-fastcomet-release-ROWRYH`.
Fresh archive extraction tested independently: `/tmp/commercepilot-fastcomet-extracted-1tp6zzz3`.

Both passed with process NODE_PATH empty, source-project filesystem/module access blocked, external Node-package resolution blocked, worker-process creation blocked, and fetch blocked. Startup/readiness was tested from each release directory itself. Counters after startup, requests and restart: source accesses 0; external modules 0; worker spawns 0; fetch calls 0.

Verified:
- `/` → 200; all 9 referenced static assets → 200; all 11 bundled fonts → 200.
- Public SVG and favicon → 200.
- `/paypal/return` without token → 400; `/paypal/cancel` without token → 303; unknown return token → 404.
- Missing operation → 404; injected create input → 400.
- Synthetic operation POST → 201 with decision/policy/awaiting approval; durable GET → 200/no-store with audit.
- Execute before owner approval → 409; sanctioned owner approval → 200.
- Restart retained APPROVED state and four audit entries in an external temporary SQLite file.
- Temporary smoke data was outside the release, used clearly fake process configuration, and was removed after stopping both local processes.

Approved execution/capture was not invoked. Existing offline domain/application/orchestrator suites remain green. No actual Passenger instance or Node 24 process is claimed tested.

7. Exact archive

`/tmp/commercepilot-fastcomet-prebuilt-2026-10-29-095604.tar.gz`

Timestamp in filename is UTC. Portable checksum and manifest sidecars:

- `/tmp/commercepilot-fastcomet-prebuilt-2026-10-29-095604.tar.gz.sha256`
- `/tmp/commercepilot-fastcomet-prebuilt-2026-10-29-095604.tar.gz.manifest.json`

8. Size

31,317,291 bytes; approximately 29.87 MiB compressed. 2,428 regular files.

9. SHA-256

```text
18b6d40b8b0984118282b713eb809449a81798b2ffddd81b9f502f6d41fb3adb
```

10. Concise archive manifest

```text
package.json                 minimal startup metadata
server.js                    same-process forwarder into runtime/server.js
runtime/
  server.js                  existing Passenger-compatible server
  package.json               runtime metadata
  next.config.js             equivalent runtime JS configuration
  .next/                     compiled routes/server output and static assets
  node_modules/              traced runtime dependency files, no external links
  public/                    required public assets
```

These entries are at archive root. There is no extra enclosing release/project directory. Next's dynamic production configuration aliases were included alongside the standard server/route traces and the custom entry trace, then validated in isolation. Unneeded package documentation/headers/type declarations were removed; third-party license notices were retained.

11. Exclusion audit

PASS: no `.env` or `.env.*` files, operator/provider credential values, SQLite headers/files/WAL/SHM, `.git`, `.continue`, tests, project source, project reports, development packages such as TypeScript/ESLint/Vitest, caches, source maps, old archives or symlinks. The temporary fake smoke credentials also do not appear in release files. Runtime framework build metadata remains part of the compiled Next application.

No env/credential files were read or copied. `.continue/`, `NVIDIA_AGENT_TEST.md` and Task 09 evidence remain untouched. No LICENSE choice or application architecture change.

12. Exact future extraction procedure — not executed

- In cPanel, stop the CommercePilot Node application before replacing runtime files.
- Upload the `.tar.gz` and `.sha256` sidecar to `/home/kzvmedia/`, outside the application directory.
- If an earlier `runtime/` release already exists, retain/move it aside for rollback while the application is stopped; do not merge stale runtime files. Do not move or replace `/home/kzvmedia/commercepilot-data`.
- In the hosting Terminal, perform:

  ```sh
  cd /home/kzvmedia
  sha256sum -c commercepilot-fastcomet-prebuilt-2026-10-29-095604.tar.gz.sha256
  cd /home/kzvmedia/commercepilot
  tar --no-same-owner -xzf /home/kzvmedia/commercepilot-fastcomet-prebuilt-2026-10-29-095604.tar.gz
  test -f server.js
  test -f runtime/.next/BUILD_ID
  test -d runtime/node_modules/next
  test -d /home/kzvmedia/commercepilot-data
  test -w /home/kzvmedia/commercepilot-data
  ```

  All checks must succeed. Files must be owned/readable by the hosting account. Preserve the existing root `node_modules` link and Selector environment; the packaged runtime uses its own dependency directory. Previous root source/build files are unused by the new root forwarder and need not be destructively cleaned.
- Retain `NODE_ENV=production`, `COMMERCEPILOT_PUBLIC_BASE_URL=https://commercepilot.toolspacehub.com`, `COMMERCEPILOT_DB_PATH=/home/kzvmedia/commercepilot-data/commerce.db`, `PAYPAL_ENVIRONMENT=SANDBOX`, and the existing securely managed runtime variables. The archive transfers no secret values. Leave any PAYPAL_API_BASE override unset or pointing only to the Sandbox host.

13. npm install/build on FastComet

**Neither is required. The archive is self-contained.** Do not click Run NPM Install, run npm ci, run next build, or upload a different dependency tree over this runtime. The native module/worker failures from building on the hosting account are bypassed by the prebuilt artifact. Source package scripts remain unchanged locally; the deployed minimal package starts the root forwarder.

14. Exact cPanel restart

cPanel → Setup Node.js App → select CommercePilot (`commercepilot`, URL `https://commercepilot.toolspacehub.com`) → confirm Node 24.22.1, Production mode and startup file `server.js` → **Start App** if stopped, otherwise **Restart**.

Use Selector controls, not a separate shell-launched background server. Once started, check the root (200), tokenless return (400), tokenless cancel (303, do not follow its redirect), and missing operation API (404). These probes make no PayPal calls. The operation detail page remains Task 11. Stop before any live execute/buyer/capture action without its separate authorization.

15. Remaining compatibility risks

The artifact is verified on Node 22.21.0, not the host's Node 24.22.1. It packages JavaScript/Next runtime files rather than a Node executable; host `node:sqlite` supplies SQLite, so no local Node-22-specific SQLite addon is shipped. Actual Node 24/Passenger/HTTPS execution still needs the host smoke check after a separately authorized extraction.

Native image dependencies target Linux x64/glibc; their included metadata requires glibc ≥2.28 and Node ≥20.9.0. FastComet must match that platform. No assumption is made that native binaries work on another architecture/libc. No server-side dependency install or build should be used as an automatic workaround. Other hosting limits could still affect runtime traffic even though the isolated release needed zero worker processes.

No PayPal E2E, deployment or backend freeze was performed. No commit/push/destructive Git action. Stop at this prepared archive.

```text
PROJECT: CommercePilot
DIRECTORY: /home/dan/Paypal app
TASK: Local prebuilt production archive for FastComet/Passenger
STATUS: PASS
NEXT STEP: Review archive, then separately authorize extraction and host smoke verification
```

STATUS: PASS — PREBUILT DEPLOYMENT READY
