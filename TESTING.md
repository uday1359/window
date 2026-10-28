# Testing

All commands run from the project root (`C:\...\WINDOW`) in PowerShell unless noted.
Case counts below were obtained by reading the test files (`it.each` / `parametrize`
rows counted individually); they are not run results.

## Overview

| Suite | Location | Runner | Cases | Needs |
|---|---|---|---|---|
| Server unit | `server/src/**/*.spec.ts` | Jest (project `unit`) | 64 | nothing |
| Server integration | `server/test/*.int.ts` | Jest (project `integration`) | 28 | MySQL `winagent_test`, Python venv (real AI service), MySQL client binaries |
| Dashboard | `web/src/test/*.test.tsx` | Vitest + jsdom | 8 | nothing |
| AI service | `ai-service/tests` | pytest | 27 | Python venv (1 test Windows-only) |
| Agent | `agent/tests` | pytest | 32 | Windows, Microsoft Edge, desktop session |
| End-to-end | `e2e/*.e2e.ts` | Playwright | 2 | MySQL `winagent_e2e`, venv, Edge, built server + web, **real agent** |

## Commands

```powershell
npm test                                  # server (unit + integration) then web
npm run test --workspace server           # jest --runInBand, both projects
npm run test:unit --workspace server      # unit project only (no services)
npm run test:int --workspace server       # integration project only
npm run test --workspace web              # vitest run
cd ai-service; ..\.venv\Scripts\python -m pytest
cd agent;      ..\.venv\Scripts\python -m pytest
npm run test:e2e                          # playwright test --config e2e/playwright.config.ts

# Static checks
npm run lint                              # eslint server + web
npm run typecheck                         # tsc --noEmit server + web
npm run typecheck --workspace electron    # Electron shell types only
.venv\Scripts\python -m ruff check ai-service agent
```

Python test configuration is in `ai-service/pyproject.toml` and `agent/pyproject.toml`
(`asyncio_mode = "auto"`, `testpaths = ["tests"]`). Jest configuration is
`server/jest.config.js` (two projects: `unit` with `rootDir: src`, regex `.spec.ts`;
`integration` with `rootDir: test`, regex `.int.ts`, global setup/teardown and a 60 s
per-test timeout from `server/test/setup-timeout.ts`).

## Server unit tests (65 cases)

| File | Cases | Covers |
|---|---|---|
| `server/src/common/common.spec.ts` | 14 | scrypt hash/verify; action-hash canonicalisation; pairing-code alphabet; redaction of 7 secret formats; nested sensitive keys; normal text untouched; rate limiter window; task state-machine invalid transitions |
| `server/src/operations/operations.spec.ts` | 29 | `validatePlan` accepts the acceptance plan; rejects 9 unsafe plans (unknown op, traversal, absolute path, extra param, executable write, `javascript:` URL, no/out-of-range criteria, too many steps); clarification plan; non-objects; 3 safe + 12 unsafe relative paths; credential-free http(s) URLs; `{task}` folder substitution |
| `server/src/orchestrator/verifier.spec.ts` | 12 | exact-content verification with hash; 5 near-miss contents fail; missing file; hash mismatch; agent unreachable → inconclusive; simulated evidence flagged; step-status and page-text criteria; overall outcome never succeeds without full evidence |
| `server/src/policy/policy.spec.ts` | 10 | low-risk auto-allow; agent-unconfigured roots denied; unknown device denied; folder DENY / sub-path REQUIRE_APPROVAL; copy/move destination roots; overwrite → MEDIUM; HIGH/external always need approval; websites (deny, allow, unknown, private); applications; DENY beats ALLOW, unknown ops denied |

## Server integration tests (30 cases)

Prerequisites:

- `server/.env` with `TEST_DATABASE_URL` pointing at a database named exactly
  `winagent_test` (enforced in `server/test/env.ts:22`). Global setup runs
  `npx prisma migrate deploy` against it; each suite empties only that database.
- `.venv\Scripts\python.exe` with `requirements-dev.txt`: global setup starts the **real**
  AI service on `127.0.0.1:8711` (`server/test/global-setup.ts`) with a scratch secret store.
- The agent is **SIMULATED** by `server/test/fake-agent.ts` (WebSocket client with an
  in-memory file map; every output carries `simulated: true`, recorded on the evidence).
- The backup test needs `mysqldump.exe`/`mysql.exe` in `MYSQL_BIN_DIR` and permission to
  create `winagent_restore_check`.
- Server runs on an ephemeral port with `OPERATION_TIMEOUT_MS=2000`, tick 100 ms.

| File | Cases | Covers |
|---|---|---|
| `server/test/auth.int.ts` | 8 | single admin bootstrap under concurrency; weak password / bad input / missing CSRF header; auth required, no hash leakage; lockout; DB-sourced RBAC and ownership; single-use pairing codes, bad device tokens; revoke disconnects and blocks reconnect; dashboard WebSocket needs session + allowed origin |
| `server/test/tasks.int.ts` | 22 | hello.txt flow with evidence + audit; idempotency key (incl. concurrent); wrong content fails verification (and sets `finishedAt`); heartbeat with `resources: null` still updates `lastSeenAt`; missing file after write; secrets in instruction refused; clarification + replan; approval bound to exact action, stale hashes rejected; rejection stops task; policy at plan and run time; emergency stop propagation and resume block; no blind repeat of timed-out non-idempotent op; journal reconciliation of idempotent op; INTERRUPTED after restart; checkpoint re-check on resume; cancel/pause state machine; LOCAL_ONLY never routes to cloud; memory review/edit/export/delete, secrets refused; save/reuse skill, disabled skill refused; MySQL backup + restore verification; AI-service 404 passed through (unknown secret); audit contains no secrets |

## Dashboard tests (8 cases) — `web/src/test/app.test.tsx`

API client sends the CSRF header only on mutations and surfaces validation issues; reports
an unreachable server; `StatusBadge` conveys status with text; `ApprovalCard` shows the
exact action and submits the displayed hash after confirmation; login page offers first-run
setup and shows server errors; New task submits an idempotency key and privacy level; task
detail shows evidence and labels simulated results. Setup: `web/src/test/setup.ts`
(jest-dom matchers, cleanup). The API is mocked; no server needed.

## AI service tests (27 cases) — `ai-service/tests`

| File | Cases | Covers |
|---|---|---|
| `test_planner_and_api.py` | 9 | rules bypass models; local preferred then cloud fallback with redaction; all models failing raises; LOCAL_ONLY with only cloud models fails; JSON extraction; service token required; plan endpoint; secrets DPAPI-encrypted at rest (**skipped unless Windows**); criteria normalisation |
| `test_router_and_redaction.py` | 8 | LOCAL_ONLY never cloud; complex → cloud when allowed; simple → local; cost limit / offline / missing key; capability / disabled; low memory avoids large local model; complexity heuristic; secret + PII redaction |
| `test_rule_planner.py` | 10 | acceptance instruction → exact plan; quoted content verbatim; clarification for missing content / unknown folder / no default root; dedicated task folder; browser open/search; app launch allow-list; unrecognised falls through; sub-folder paths |

Model calls are injected fakes; Ollama and cloud providers are not contacted.

## Agent tests (32 cases) — `agent/tests`

Fixtures (`conftest.py`) use a temporary agent home (`WINAGENT_AGENT_HOME`) and temporary
approved folders; real files are written there.

| File | Cases | Covers |
|---|---|---|
| `test_files_and_paths.py` | 20 | 11 unsafe paths rejected (traversal, drive, UNC, ADS, device names, trailing dot, `//`); unknown root; junction escape; exact write/read; idempotent rewrite vs refused different content; overwrite backup; delete quarantines; executable types refused; missing/large/binary reads; stat and list |
| `test_executor_journal.py` | 8 | duplicate op id not re-executed; stop file and server e-stop block ops; sensitive ops need approval hash; unsupported/bad params; cancellation stops typing; journal survives restart (running → unknown); device token DPAPI-encrypted |
| `test_browser_desktop.py` | 4 | injection detector; **real headless Edge** against a local `127.0.0.1` test site (open, text extraction, CAPTCHA detection, injection flags, password-field refusal, screenshot); download safety (plain file OK, `MZ` content and `.exe` URL refused); **real UI Automation** window listing and resources |

The browser flow test **skips itself** when Edge cannot be launched (`UNSUPPORTED`); a skip is
not a pass. UIA needs an interactive Windows desktop session.

## End-to-end tests (2 cases) — `e2e/`

`e2e/playwright.config.ts`: Edge (`channel: msedge`), headless, 1 worker, no retries, 180 s
timeout, base URL `http://127.0.0.1:3712`. Nothing is simulated.

Global setup (`e2e/global-setup.ts`, `e2e/stack.ts`):
1. Deletes and recreates `e2e/.run/` and writes an agent config whose only approved folders
   are inside `e2e/.run/approved/`.
2. Creates database `winagent_e2e` (URL derived from `DATABASE_URL` in `server/.env`), runs
   `prisma migrate deploy`, truncates all tables.
3. Runs `npm run build` in `server` and `web` (overwrites `dist/`).
4. Starts the AI service on 8712 and `node server/dist/main.js` on 3712 (`NODE_ENV=production`).
Teardown kills only the recorded PIDs (`e2e/.run/pids.json`, includes the agent).

| Test | Covers |
|---|---|
| hello.txt | first-run admin setup in the dashboard; pairing the **real** agent (`python -m winagent pair` then `run --headless`); submitting the acceptance task; file created, read back and verified on disk |
| policy-denied folder | adds a FOLDER `test:private` DENY policy; task is REJECTED with "denied by policy"; file never created |

Ports 3712 and 8712 must be free.

## How to validate on the target system

```powershell
powershell -ExecutionPolicy Bypass -File scripts\validate.ps1                     # all checks and suites
powershell -ExecutionPolicy Bypass -File scripts\validate.ps1 -IncludeLifecycle   # + install/update/rollback test
```

Run it from a Remote Desktop session (the agent's UI Automation tests need a desktop). It writes
`logs\validation-<timestamp>\report.md` and one log per step; send back the report and any
failed logs.

## Tests added on 2026-10-28 (not yet run: NOT VALIDATED)

| File | New tests |
|---|---|
| `server/src/orchestrator/verifier.spec.ts` | OCR text matching ignoring case/whitespace and window targeting; OCR unavailable → INCONCLUSIVE |
| `server/src/policy/policy.spec.ts` | Research is medium risk behind the search-engine policy; integrations only when registered/enabled, within paths/tools; POST/MCP always need approval |
| `server/src/operations/operations.spec.ts` | Integration operations offered only when integrations exist; path-escape attempts rejected |
| `server/test/tasks.int.ts` | Deadline passed → BLOCKED, resume overrides; offline-only model → waits with `retryPlanningAt`, retries, cancel stops it; attachments stored, hashed, served to the owner, bad signature / too many rejected without creating a task |
| `web/src/test/research.test.tsx` | Claim labels in text; only http(s) source URLs become links |
| `ai-service/tests/test_planner_and_api.py` | Offline failure retryable vs. policy failure not; screenshots go to a vision model and skip rules; never to cloud under CLOUD_REDACTED |
| `ai-service/tests/test_research.py` | Citation rules (verified / single-source / dropped); cloud synthesis receives redacted text; LOCAL_ONLY never uses cloud |
| `ai-service/tests/test_integrations.py` | REST path allow-list, host and traversal protection; secret header; redirects and oversized responses refused; full MCP session over SSE; disallowed tools never sent; MCP errors |
| `ai-service/tests/test_rule_planner.py` | OCR and single-question research phrases |
| `agent/tests/test_ocr.py` | Real Windows OCR on a blank image (skipped with a reason if no OCR language is installed); missing file |
| `agent/tests/test_research.py` | DuckDuckGo link decoding, trust tiers, private hosts, ranking, one page per domain, policy blocking, limit |
| `agent/tests/test_browser_desktop.py` | A download redirected to a private address is refused |
| `scripts/test-lifecycle.ps1` | Install, start, stop, update, rollback (database restored), broken update rolls back automatically |

## Latest results

The run below covers the code **before** the 2026-10-28 feature additions (Phases C-D). It is
kept for reference; the extended suite must be re-run with `scripts\validate.ps1`.

Final audit run on 2026-10-28, Windows 11 Pro, Node 24.22.1, Python 3.13.17, MySQL 8.0, Microsoft Edge.

| Suite | Command | Result |
|---|---|---|
| Server unit | `npm run test --workspace server` | 65 passed |
| Server integration (simulated agent) | same command | 30 passed |
| Dashboard | `npm run test --workspace web` | 8 passed |
| AI service | `cd ai-service; ...venvScriptspython -m pytest` | 27 passed (1 third-party deprecation warning from Starlette's test client) |
| Agent (real files, Edge, UIA) | `cd agent; ...venvScriptspython -m pytest` | 32 passed |
| End-to-end (real agent) | `npm run test:e2e` | 2 passed |
| Lint / typecheck | `npm run lint`, `npm run typecheck`, `ruff check ai-service agent`, `tsc --noEmit -p electron/tsconfig.json` | clean |
| Prisma schema | `npm run prisma:validate --workspace server` | valid |
| Build | `npm run build` | succeeded |

Expected log noise: the server suite prints three `prisma:error … Unique constraint failed` lines. They come from the duplicate-idempotency-key tests and are asserted on, not failures.

NOT VALIDATED: Electron runtime (binary not downloadable), cloud LLM providers against live accounts, voice input with a real microphone.
