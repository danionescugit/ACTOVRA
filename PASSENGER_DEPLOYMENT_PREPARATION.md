# CommercePilot — FastComet/Passenger deployment preparation

**Superseded deployment procedure:** FastComet subsequently rejected build workers and Turbopack's external module symlink. Use `FASTCOMET_PREBUILT_REPORT.md` and its verified runtime archive instead of the server-side install/build procedure below. This report is retained as the original startup-preparation record.

Date: 2026-10-29. Preparation: PASS. Deployment/live E2E: not attempted.

Fresh canonical backup completed before edits:

```text
BACKUP_GATE=PASS
VERIFICATION=PASS
DESTINATION=/mnt/f/!SAAS Succes!/CommercePilot_Backup_2026-10-29_104946_pre_passenger_startup_post_cp4
FILES=93
```

Only application source addition: `server.js`. Also added this report and updated `AGENT_PERMISSIONS.md`. Compared 63 pre-existing source/package/configuration/report files against the fresh backup: unchanged. CP2/CP3/CP4 and SQLite/domain/orchestrator code are intact.

1. Exact cPanel startup filename

`server.js`, relative to the application root. Physical path: `/home/kzvmedia/commercepilot/server.js`.

2. Entry point contents/design

The small CommonJS file requires only `node:http` and the existing `next` package. It calls `next({ dev: false, dir: __dirname, port })`, awaits `prepare()`, obtains `getRequestHandler()`, and creates one HTTP server that delegates every request to Next. The project directory comes from the startup file, independently of the process working directory.

Numeric `process.env.PORT` is validated and passed as a number, preventing accidental interpretation as a Unix socket filename. There is no hardcoded hostname or service port. Outside Passenger, PORT is required. If Passenger exposes its standard `PhusionPassenger` global and omits PORT, the HTTP listen argument is left unspecified. Passenger's default automatic integration intercepts the first HTTP server's listen call and substitutes its own Unix socket. No extra proxy/listener, manual Passenger configuration or new framework is introduced. [Passenger reverse port binding](https://www.phusionpassenger.com/docs/advanced_guides/in_depth/node/reverse_port_binding.html)

Startup/listener failures exit nonzero with fixed messages, without printing configuration or exception details. Request failures get a generic 500 or close a response already started. All route selection, callbacks, policy and payment logic remain with Next and the existing application.

This uses Next's documented public programmatic server API, as described in the installed `node_modules/next/dist/docs/01-app/02-guides/custom-server.md`. A CLI file under `node_modules/next/dist/` is not used as a startup shim. The repository does not use standalone output, and no standalone conversion is needed. [Next custom-server documentation](https://nextjs.org/docs/pages/guides/custom-server)

3. package.json

Unchanged, byte-for-byte verified against backup. `npm start` continues to mean `next start`; local development stays unchanged. Passenger directly launches `server.js`. To test this same entry point locally after building, set NODE_ENV=production and PORT to an available local port, then run `node server.js`.

4. Exact cPanel Application Root

Physical directory: `/home/kzvmedia/commercepilot`.

Where the Selector field already prefixes `/home/kzvmedia/`, enter `commercepilot`. Ensure extracted files sit directly in that directory, not inside a second nested project folder. FastComet documents the application-root field as relative to the account home. [FastComet Node Selector](https://www.fastcomet.com/tutorials/nodejs/for-beginners-nodejs-selector)

5. Exact cPanel Application URL

`https://commercepilot.toolspacehub.com`, with no application subdirectory. Select Node.js 24.22.1 and Production mode, as confirmed by the user. HTTPS terminates at the hosting web server; this entry point handles the Passenger HTTP/socket connection.

6. Environment variable names

Runtime non-secret settings:

| Name | Setting |
| --- | --- |
| `NODE_ENV` | `production` (also established by Selector Production mode) |
| `COMMERCEPILOT_PUBLIC_BASE_URL` | `https://commercepilot.toolspacehub.com` |
| `COMMERCEPILOT_DB_PATH` | `/home/kzvmedia/commercepilot-data/commerce.db` |
| `PAYPAL_ENVIRONMENT` | `SANDBOX` |
| `PORT` | Use the hosting-supplied numeric value when present; no manual public port assignment is needed under Passenger |

Required runtime secret names only: `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`. Manage them through the existing cPanel application environment; do not upload/read/copy `.env` or `.env.save` or paste values into commands/logs. No real credentials were accessed in preparation.

Optional `PAYPAL_API_BASE`: leave unset, or ensure an existing override is exactly `https://api-m.sandbox.paypal.com`. `NVIDIA_API_KEY` is not required by the current synthetic proposer. No callback-specific environment variables are needed: return/cancel URLs derive from the public base URL.

Build/install setting: `NPM_CONFIG_INCLUDE=dev` when using the Selector's production-mode NPM Install action, so TypeScript/types/lint/test dependencies are available for the build/gates. This is not an application runtime requirement. npm otherwise omits devDependencies by default with NODE_ENV=production. [npm install configuration](https://docs.npmjs.com/cli/v11/commands/npm-install/)

7. Recommended persistent DB path

`/home/kzvmedia/commercepilot-data/commerce.db`.

Its parent is outside the application upload/replacement directory and outside the web document root. Retain the whole directory across releases, including SQLite WAL/SHM files when present. Do not upload or reuse Task 09 evidence databases.

8. Exact future upload/build procedure — instructions only, not executed

Prepared upload archive of the current working-tree source:

```text
/tmp/commercepilot-passenger-source-2026-10-29.tar.gz
SHA256=0d5d368613c9cf58d5d2de9313811ca16b19931747f95df047ad08227f606627
```

It includes `server.js`, `package.json`, `package-lock.json`, `next.config.ts`, `tsconfig.json`, `eslint.config.mjs`, `src/` and `public/`. Archive inspection verified no secret env files, `.continue`, `.git`, `node_modules`, `.next`, runtime data or Task 09 artifacts. It includes the uncommitted CP2/CP3/CP4 source; using only `git archive HEAD` would omit that work.

When deployment is separately authorized:

- Upload this archive through cPanel File Manager or SFTP and extract its contents directly into `/home/kzvmedia/commercepilot`. Retain existing hosting-managed environment/module directories; no local node_modules or .next is uploaded.
- Configure/create the Node Selector application with root/URL/startup filename above and Node 24.22.1 Production mode. Keep the application stopped during installation/build. If creating the entry auto-starts it before dependencies/build exist, it is not yet ready for traffic.
- Create the persistent directory as the hosting account owner:

  ```sh
  mkdir -p /home/kzvmedia/commercepilot-data
  chmod 700 /home/kzvmedia/commercepilot-data
  ```

- Set the application environment names above in the Selector, including the build-time include setting. Do not copy local secret files.
- Use the Selector's **Run NPM Install** action to install into its managed environment.
- Open cPanel Terminal/SSH and run the **exact environment activation command displayed by the Selector**. Its generated interpreter/virtual-environment path must be used rather than guessed. Then:

  ```sh
  cd /home/kzvmedia/commercepilot
  node --version
  node -e 'const {DatabaseSync}=require("node:sqlite"); const db=new DatabaseSync(":memory:"); console.log(db.prepare("SELECT 1 AS ok").get().ok); db.close();'
  npm run build
  ```

  Expect Node v24.22.1, SQLite probe `1`, and a successful Next build listing all four operation APIs and both callbacks. Dependencies are installed on the host; the normal production build needs npm/package access and Google Fonts downloads. Temporary local offline-test guards/font fixtures are not deployed.
- After a successful build, start/restart using the Selector. Do not run a second background `npm start` or `node server.js` alongside Passenger.
- Once HTTPS routing is separately ready, verify without following redirects: GET `/` → 200; GET `/paypal/return` with no token → 400; GET `/paypal/cancel` with no token → 303; GET `/api/operations/preparation-probe-nonexistent` → 404. These probes make no PayPal calls. Callbacks/API responses should be no-store. The future `/operations/{id}` UI still belongs to Task 11.
- Stop before any execute/buyer approval/live E2E action unless separately authorized. No DNS/hosting/deployment action was performed during this task.

9. cPanel versus terminal dependency installation

For this Selector-managed environment, prefer its **Run NPM Install** action. Build can run from its activated Terminal/SSH environment or an equivalent Selector build-script action. Generic system Node/npm must not be used accidentally. Do not upload a workstation node_modules directory.

`npm ci --include=dev` remains appropriate in an ordinary local/CI environment. Do not blindly run it against a Selector-managed node_modules link: npm ci removes existing node_modules, while the Selector may manage dependencies through its virtual environment. A terminal installation is acceptable only through the host-supported activated environment. The cPanel install action avoids assuming how this host manages that directory. [CloudLinux environment/installation commands](https://docs.cloudlinux.com/cloudlinuxos/command-line_tools/), [npm ci behavior](https://docs.npmjs.com/cli/v11/commands/npm-ci/)

10. Manual persistent-directory creation

Yes. The store creates its database/tables but not the parent directory. The hosting user must create `/home/kzvmedia/commercepilot-data` and make it writable before the first application use case. Do not create a public data directory or expose the SQLite file through the application URL.

11. Offline verification results

| Gate | Result |
| --- | --- |
| `npm test` | PASS: 374 passed, 5 skipped; 14 passed test files, 5 skipped live suites |
| `npm run lint` | PASS, exit 0 |
| `npm run typecheck` | PASS, exit 0 |
| `npm run build` | PASS, exit 0; all existing APIs and callbacks dynamic |

The gates used the existing external env-file/network guard, local-only font fixtures and disabled live switches. No new npm test framework or dependency was added.

Additional manual offline startup-contract checks: supplied PORT becomes numeric; exactly one listener; Passenger without PORT reaches listen without a fixed fallback; local startup without PORT fails safely; invalid port values cannot become socket filenames or appear in logs; all seven representative route requests are forwarded unchanged.

Additional real local production HTTP smoke launched `server.js` with a process working directory outside the project, temporary SQLite, clearly fake configuration and blocked outbound traffic. Results: root 200, static favicon 200, return-without-token 400, cancel 303, unknown callback token 404, synthetic API create 201, durable read/audit 200, execute-before-approval 409, sanctioned owner approval 200. The child process stopped and temporary state was removed. No approved execution/provider call was attempted.

12. FastComet/Passenger blocker and limits

No startup-code blocker was found. The wrapper uses the documented Passenger automatic binding model and Next public API. Local gates and HTTP smoke ran on Node 22.21.0; Node 24.22.1 and the actual installed Passenger loader were not available locally and are not claimed live-proven. The host-side interpreter/SQLite probe, dependency installation/build and real Passenger/HTTPS smoke remain deployment checks, not additional backend work. Any concrete host resource, filesystem or loader failure should be addressed from its actual result rather than preemptively redesigning the application.

ZERO PayPal calls. No secrets read/printed/copied, `.env`/`.env.save` access, deployment, DNS change, commit or push. `.continue/`, `NVIDIA_AGENT_TEST.md`, Task 09 evidence and CP2/CP3/CP4 remain unchanged. No new domain states, storage design, UI, framework or dependency.

```text
PROJECT: CommercePilot
DIRECTORY: /home/dan/Paypal app
TASK: FastComet/Passenger startup and deployment preparation
STATUS: PASS
NEXT STEP: Review preparation, then authorize host upload/build and Passenger verification
```
