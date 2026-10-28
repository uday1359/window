# Security

This document describes the threat model and the controls that are **implemented in the
code**. Anything marked NOT VALIDATED was not exercised at runtime. See also
[KNOWN_ISSUES.md](KNOWN_ISSUES.md).

## 1. Scope and trust model

WinAgent is a single-machine, single-Windows-user system:

| Component | Listens on | Trusts |
|---|---|---|
| NestJS server (`server/`) | `HOST:PORT`, default `127.0.0.1:3710` | MySQL, AI service (service token) |
| AI service (`ai-service/`) | `AI_HOST:AI_PORT`, default `127.0.0.1:8710` | Only callers with the service token |
| Windows agent (`agent/`) | nothing (outbound WebSocket only) | The server, but enforces its own local limits |
| Dashboard (`web/`) | served by the server (prod) or Vite on `127.0.0.1:5173` (dev) | — |
| Electron shell (`electron/`) | nothing | Dashboard origin only |

**Assets:** files inside approved folders, the user's browser/desktop session, cloud API
keys, user passwords and sessions, device tokens, task history and audit trail.

**Threats considered:** other local or network users reaching the services; CSRF from web
pages in the same browser; credential stuffing; a malicious or prompt-injected LLM plan;
hostile web pages (prompt injection, drive-by downloads, CAPTCHA/MFA flows); approval
replay or "approve one thing, execute another"; duplicate execution after timeouts or
restarts; secrets leaking into logs, the database or model prompts; a stolen device token.

**Out of scope / not defended:** a compromised Windows user account or administrator on
the same PC (DPAPI blobs, `.env` files and the agent config are readable by that account);
network exposure without TLS (see Residual risks).

## 2. Network binding and transport

- Server: `HOST` defaults to `127.0.0.1`. Since 2026-10-28 the server **refuses to start** on
  any non-loopback address unless TLS is configured (`server/src/main.ts`).
- **Optional TLS (FR-20, NOT VALIDATED):** `TLS_PFX_FILE` + `TLS_PFX_PASSPHRASE` (or
  `TLS_CERT_FILE` + `TLS_KEY_FILE`) make the server serve HTTPS and WSS. `scripts\new-tls-cert.ps1`
  creates a self-signed certificate:
  - the private key bundle is ACL-restricted to the user, SYSTEM and Administrators
  - the passphrase is random and written only to `server\.env`
  - the public `server.pem` is copied to agent PCs, which trust it with `pair --ca-file`
    (`agent-config.json` `ca_file`); certificate validation is never disabled on the agent

  `PUBLIC_ORIGIN` adds the public HTTPS origin to the WebSocket origin allow-list and the CSP.
  Session cookies become `Secure` automatically on HTTPS requests. The AI service always stays
  on loopback.
- AI service: `AI_HOST` defaults to `127.0.0.1` (`ai-service/app/main.py:106`); also
  configurable, not enforced.
- Dev dashboard: Vite binds `127.0.0.1:5173` with `strictPort` (`web/vite.config.ts`).
- Server ↔ agent transport is `ws://` on localhost, or `wss://` when the server uses TLS. The
  agent derives `wss://` from an `https://` `server_url` and refuses a non-loopback `http://`
  server URL.
- Server ↔ AI service: plain HTTP on loopback with a shared token.
- CSP (helmet) restricts `connect-src` to `'self'` and `ws://127.0.0.1:*` / `ws://localhost:*`,
  `frame-ancestors 'none'`, `object-src 'none'` (`server/src/bootstrap.ts:23-38`).
  `x-powered-by` disabled, `trust proxy` false, JSON body limit 2 MB.

## 3. Authentication and sessions (`server/src/auth`)

- **First admin**: `POST /api/auth/bootstrap` works only while no users exist; a
  `SELECT … FOR UPDATE` row lock serialises concurrent attempts (`auth.service.ts:52-65`).
- **Password hashing**: scrypt N=32768, r=8, p=1, 64-byte key, 16-byte random salt;
  constant-time comparison (`server/src/common/crypto.ts:3-26`). Minimum length 12,
  maximum 200 (`auth.controller.ts:10`).
- **User enumeration**: unknown e-mails are verified against a dummy hash so timing matches
  (`auth.service.ts:13, 82-86`); the error message is identical.
- **Lockout**: 5 failed logins lock the account for 15 minutes (`auth.service.ts:9-10, 91-101`).
- **Rate limiting**: in-memory fixed window per IP — login `LOGIN_RATE_LIMIT_PER_MIN`
  (default 10/min, `auth.controller.ts:23,44`), pairing 10/min (`agents.controller.ts:22,56`)
  (`server/src/common/rate-limit.ts`). Single-process only; resets on restart.
- **Sessions**: opaque 32-byte random token; only its SHA-256 is stored
  (`auth.service.ts:103-110`). Cookie `wa_session`: `HttpOnly`, `SameSite=Strict`, `Secure`
  only when `NODE_ENV=production` **and** the request is HTTPS (`auth.controller.ts:49-55`).
  Absolute TTL `SESSION_TTL_HOURS` (default 12), idle timeout `SESSION_IDLE_MINUTES`
  (default 60) (`auth.service.ts:116-131`). Users can list/revoke their sessions; a password
  change revokes every other session (`auth.service.ts:163-176`).
- **Dashboard WebSocket** (`/ws/events`): requires a valid session cookie **and** an
  `Origin` in an allow-list (`server/src/realtime/ws-gateway.service.ts:50-92`); inbound
  messages are ignored; open sockets are re-checked every 60 s and closed if the session was
  revoked or expired (`ws-gateway.service.ts:113-119`).

## 4. CSRF

Global guard (`server/src/auth/auth.guard.ts:25-27`): every non-GET/HEAD/OPTIONS request
must carry `x-winagent-csrf: 1`. Combined with `SameSite=Strict` and **no CORS** being
enabled, cross-origin pages cannot send the header without a preflight that fails.

## 5. Authorisation (RBAC)

- Roles and permissions are defined in code (`server/src/auth/rbac.ts`) and synced to MySQL
  at startup (`auth.service.ts:27-45`). Permissions are always read from the DB per request,
  never from the client (`auth.service.ts:116-141`).
- Roles: `ADMIN` (all), `OPERATOR` (own tasks, approvals, policies, memory, e-stop), `VIEWER`
  (read own tasks/devices/audit, trigger e-stop).
- `@RequirePermissions(...)` on routes; `@Public()` only on status/bootstrap/login/health/pair.
- Ownership: tasks/devices/approvals are filtered by owner unless the user has
  `task:read_all` / `audit:read_all`; deciding another user's approval needs `system:admin`
  (`approvals.service.ts:94`).
- The task owner's `task:create` permission is re-checked immediately before every agent
  dispatch (`orchestrator.service.ts:163`), and the device must still be `ACTIVE` and owned
  by the task owner (`orchestrator.service.ts:165-167`).

## 6. Server ↔ AI service token

- `AI_SERVICE_TOKEN` (≥ 32 chars, enforced on both sides: `config.ts:11`,
  `ai-service/app/main.py:39-40`) is sent as `x-service-token` (`server/src/ai/ai-client.service.ts:55`).
- Every `/v1/*` route requires it; comparison uses `hmac.compare_digest`
  (`ai-service/app/main.py:46-48`). `/health` is unauthenticated (reports Ollama reachability
  and model names only). OpenAPI/docs endpoints are disabled.
- Generated randomly by `scripts/setup-env.mjs` (32 random bytes, base64url) and written only
  to the git-ignored `.env` files; existing values are preserved on re-run.

## 7. Device pairing and token storage

- An `agent:manage` user creates a one-time 10-character code (unambiguous alphabet,
  `crypto.ts:37-41`), valid 10 minutes; only its SHA-256 is stored
  (`server/src/agents/agents.controller.ts:42-50`).
- `POST /api/agents/pair` atomically marks the code used (single use) and issues a
  32-byte random device token; only its hash is stored (`agents.controller.ts:53-74`).
  Failures are audited.
- Agent WebSocket (`/ws/agent`) requires `Authorization: Bearer <token>`; the device must be
  `ACTIVE` (`ws-gateway.service.ts:94-111`). The agent receives work only after it sends a
  schema-validated `hello` (`agent-hub.service.ts:48-77,155-168`). Max payload 8 MB.
- Revocation sets the device `REVOKED`, sends `revoked` and closes the socket
  (`agents.controller.ts:76-85`); the agent then deletes its local token
  (`agent/winagent/client.py:124-127`).
- On the PC the token is stored at `%LOCALAPPDATA%\WinAgent\device-token.dpapi`, encrypted
  with Windows DPAPI (current-user scope, entropy `winagent-device-token`)
  (`agent/winagent/token_store.py`, `agent/winagent/dpapi.py`).

## 8. Policy engine (`server/src/policy/policy.ts`)

Pure function `evaluateStep`, evaluated at planning time **and** again immediately before
dispatch (`orchestrator.service.ts:170`):

- Unknown operations are denied (only the 22 whitelisted operations in
  `server/src/operations/operations.ts` exist; plans are schema-validated with `.strict()`).
- Folder roots must be among the roots the **agent reported** from its local config; server
  policies can never widen them (`policy.ts:82-83`).
- Precedence: `DENY` > `REQUIRE_APPROVAL` > `ALLOW` for folder, website, application and
  action rules.
- Websites: only `http(s)` URLs without embedded credentials; cloud metadata hosts blocked
  (`operations.ts:28-40`); private/local hosts raise risk to HIGH unless explicitly allowed;
  unknown sites require approval (except the fixed search host).
- Applications must be in the agent's local allow list.
- HIGH/CRITICAL risk and operations with external effects (`browser.click`,
  `browser.submit`) **always** require approval; an `ALLOW` rule cannot waive this
  (`policy.ts:131-139`). Optional user preference makes MEDIUM risk require approval.

## 9. Approvals bound to an action hash

- `actionHash = SHA-256(canonicalJson({taskId, stepId, operation, params}))` with sorted keys
  (`server/src/common/crypto.ts:43-56`).
- Requests expire after `APPROVAL_TTL_MINUTES` (default 30). A changed action supersedes
  older requests (`approvals.service.ts:46`).
- When deciding, the client must submit the hash it displayed; it must equal the stored hash,
  and the hash is recomputed from the current step to detect changes
  (`approvals.service.ts:100-106`). The decision is a conditional update (no double decision).
- An approval is usable once: it is ignored after an execution with that hash finished
  (`approvals.service.ts:28-38`).
- Voice is deliberately not an accepted approval channel (`approvals.controller.ts:11-12`).

## 10. Agent-side checks (defence in depth)

- **Refuses to run elevated** unless `--allow-elevated` (`agent/winagent/__main__.py:50-53`).
- **Approval hash required** for `file.delete`, `browser.submit`, `browser.click`,
  `desktop.type_text` (`AGENT_APPROVAL_REQUIRED`, `agent/winagent/executor.py:161,243-244`).
  Note: the agent only checks that a well-formed 64-hex hash is present; it cannot verify it.
- **Idempotency journal** (`agent/winagent/journal.py`): an operation id runs at most once;
  operations running when the agent died are reported as unknown, never re-run.
- **One action at a time** (executor lock); cancellation and emergency stop cancel running work.
- **Path sandbox** (`agent/winagent/paths.py`): root-relative paths only; rejects absolute
  paths, drive letters, UNC, `..`, ADS (`:`), reserved device names, trailing dots/spaces;
  resolves symlinks/junctions on both sides before the containment check; executable/script
  extensions refused for writes/downloads.
- File writes back up originals before overwrite; deletes move to a quarantine folder in the
  agent home (`agent/winagent/ops_files.py:31-35`).
- **Browser** (`agent/winagent/ops_browser.py`): ephemeral Playwright context (no persisted
  cookies); CAPTCHA/OTP/MFA detection → `HUMAN_VERIFICATION_REQUIRED`, never bypassed
  (`:23-34, 92-101`); prompt-injection phrases in extracted text are flagged in
  `injectionWarnings` and the text is marked `untrusted` (`:35-44, 136`); password/payment/OTP
  fields are never filled (`:40, 151-153`); unrequested downloads are cancelled (`:78`);
  requested downloads reject executable extensions, executable `Content-Disposition`, `MZ`/ELF
  content, and exceed-size (`:181-216`).
- Approved folders and allowed apps live only in `%LOCALAPPDATA%\WinAgent\agent-config.json`.

## 11. Redaction

- Server: `server/src/common/redact.ts` removes private keys, bearer tokens, `sk-`/`sk-ant-`
  keys, AWS keys, GitHub tokens, JWTs, `password=`-style pairs, MySQL URL credentials and
  13–19 digit numbers; object keys matching password/secret/token/api key/cookie/etc. are
  replaced. Applied to audit details, error logs, step results, evidence and agent errors.
- Instructions, clarification answers and memory content that appear to contain secrets are
  **refused** (`tasks.service.ts:60,274`, `memory.controller.ts:23`).
- AI service: `ai-service/app/redaction.py` mirrors the secret patterns; `CLOUD_REDACTED`
  additionally removes e-mails, phone numbers, IPv4 addresses and `C:\Users\<name>`.

## 12. Privacy levels and cloud gating

- Each task has `LOCAL_ONLY`, `CLOUD_REDACTED` or `CLOUD_ALLOWED`.
- Deterministic rule planner runs first; no model is called for rule-planned requests
  (`ai-service/app/planner.py:53-55`).
- Router hard-filters cloud models for `LOCAL_ONLY` and excludes disabled, over-cost,
  key-less or offline models (`ai-service/app/router.py:296-312`).
- Planner re-checks: a cloud model under `LOCAL_ONLY` raises `NoModelAvailable`
  ("privacy policy forbids cloud processing") (`planner.py:75-78`). Secrets are always
  redacted; PII additionally under `CLOUD_REDACTED` (`planner.py:73-80`).
- Cloud endpoints must be `https://` (only loopback may use `http://`)
  (`server/src/settings/settings.controller.ts:50`).

## 13. Secret storage

- Cloud API keys are stored by the AI service in `SECRET_STORE_PATH` (default
  `data/secrets.dpapi`), each value DPAPI-encrypted (current user, entropy `winagent-secrets`)
  (`ai-service/app/secrets_store.py`). Only names are listed; values never go to MySQL,
  logs, API responses or prompts. Writes are atomic (`os.replace`). Storing is refused when
  DPAPI is unavailable (non-Windows).
- Server and AI service configuration secrets (DB password, service token) live in
  git-ignored `server/.env` / `ai-service/.env`. Config validation errors report key names
  only (`config.ts:37-42`). Backups use `MYSQL_PWD`, never the command line
  (`server/src/backups/backups.service.ts:43-45`).

## 14. Emergency stop

- Dashboard button (every page) → `POST /api/system/emergency-stop` (`system:emergency_stop`,
  granted to every role). It persists the flag, aborts the in-flight operation, pauses all
  active tasks, marks running steps `UNCERTAIN`, notifies every agent and fails pending
  operations (`server/src/system/system.controller.ts:31-46`,
  `agent-hub.service.ts:277-289`).
- The flag survives restarts (`orchestrator.service.ts:52-54`); the queue does not run and
  resume is refused while it is active. Only `system:admin` can clear it, with explicit
  confirmation; paused tasks stay paused.
- Agent local stop file `%LOCALAPPDATA%\WinAgent\EMERGENCY_STOP` (`python -m winagent estop`)
  works without the server; polled every second (`client.py:69-75`).
- Electron tray: calls the API and writes the stop file (`electron/src/main.ts:62-86`) —
  NOT VALIDATED (Electron could not be run).

## 15. Electron hardening (`electron/src/main.ts`) — NOT VALIDATED at runtime

`contextIsolation`, `sandbox`, no `nodeIntegration`, `webSecurity`, no insecure content;
navigation locked to the dashboard origin; new windows denied (only `https://` links opened
externally); all permission requests denied except `media` (voice) for the dashboard origin;
single IPC channel (`winagent:notify`) that checks the sender origin and argument types;
single-instance lock. `electron/package.json` requests `asInvoker` (no elevation).

## 16. Audit logging

`server/src/audit/audit.service.ts` writes `AuditEvent` rows for auth, pairing, device
connect/disconnect, approvals, policy denials, step success/failure/retry/reconcile,
verification, emergency stop, backups, settings and secret changes (names only). Details
are always redacted. Events written inside a transaction commit atomically with the change;
standalone failures are logged, not thrown. Users see their own events; `audit:read_all`
sees all.

## 17. Data collected, stored and transmitted (privacy)

**Collected:** user e-mail, display name, password (hashed), session user-agent; task
instructions, plans, step parameters/results, verification evidence; agent hostname, OS
version, approved root names, allowed app names, resource heartbeats (CPU/memory/battery);
browser and desktop screenshots when a plan requests them; voice input is transcribed by the
browser's Speech API (that API may use an online service, depending on the browser).

**Stored:**
- MySQL (`server/prisma/schema.prisma`): users, sessions (token hashes), tasks, steps,
  executions, checkpoints, evidence, approvals, devices (token hashes), pairing codes
  (hashes), model configs (no keys), policies, preferences, memory records, skills,
  notifications, audit events, backup metadata.
- Agent home `%LOCALAPPDATA%\WinAgent\`: `agent-config.json`, `device-token.dpapi`,
  `journal.jsonl` (operation results in **plain text**, up to 2000 entries, may include file
  content read or page text extracted), `evidence\` screenshots, `backups\` and
  `quarantine\` copies of changed/deleted files.
- `data/secrets.dpapi`: DPAPI-encrypted cloud keys.
- `BACKUP_DIR`: unencrypted MySQL dumps (contain password hashes and task data) and config
  exports (no secrets).
- Retention: finished tasks are purged after each user's `historyRetentionDays` (default 365)
  and notifications after 90 days, checked daily (`server/src/system/retention.service.ts`).
  Audit events are not purged by this job.

**Also stored (since 2026-10-28):** task screenshot attachments in
`STORAGE_DIR\attachments\<taskId>\`, unencrypted, ACL-protected by the Windows account. Their
SHA-256 is in MySQL and they are deleted with the task by retention. Research source text,
integration responses and OCR text are kept in step results.

**Transmitted:** all traffic is on loopback by default. Off-machine traffic happens only:

- (a) to websites the plan opens, searches, researches or downloads (DuckDuckGo for search)
- (b) to a configured cloud model when the task's privacy level allows it: the instruction
  after redaction, the operation catalogue, root and app names; for research, redacted page
  text; for screenshots, the images, **only under `CLOUD_ALLOWED`**, because images cannot be
  redacted
- (c) to Ollama on its configured URL
- (d) to administrator-registered integrations: the request path, query and body of approved
  steps, plus the stored credential
- (e) to agent PCs over TLS when remote access is configured

OCR runs locally with the Windows engine. There is no telemetry or analytics.

## 18. Residual risks

- **Remote access depends on correct TLS setup.** The server refuses non-loopback listening
  without TLS. A self-signed certificate protects the agent connection, which pins it through
  `ca_file`, but browsers will warn. Use an organisational certificate for real deployments,
  and restrict the port to trusted source addresses. `AI_HOST` must stay on loopback (not
  enforced). NOT VALIDATED.
- Agent approval check is presence-only; a compromised server could send a fabricated hash.
- `isLocal` on a model config is an admin-set flag, not derived from the endpoint; a cloud
  endpoint marked `isLocal: true` would bypass the `LOCAL_ONLY` gate and PII redaction.
- `browser.download` follows redirects. Since 2026-10-28, a redirect to a *different* host
  that is private or local is refused, but redirects to other public hosts are still
  followed without a per-hop WEBSITE policy check.
- Integrations: a REST GET sends its query parameters to the external service without
  approval (medium risk). Set "approve medium-risk actions", or add ACTION rules, if that
  matters. Approval texts show the exact path, query and body.
- Research reads pages chosen by a search engine. Content is untrusted and only summarised;
  claim classification is rule-based but depends on the model citing honestly.
- Prompt-injection and CAPTCHA detection are pattern-based; false negatives/positives are
  possible. The plan is still bounded by the whitelist, policy and approvals.
- Rate limits and lockout are in-memory/per-account; no CAPTCHA or MFA for dashboard login.
- Plain-text agent journal, evidence and DB backups on local disk; protection relies on the
  Windows account and file-system ACLs.
- Any process running as the same Windows user can decrypt DPAPI blobs and read `.env` files.
- DB user `winagent` has `ALL PRIVILEGES` on `winagent%` databases.
- Electron hardening and tray emergency stop are NOT VALIDATED at runtime.
- Dependency scan (`npm audit`, 2026-10-28) after the security upgrades (NestJS 11.2.8, ws 8.22.0, react-router-dom 7.18.5, zod 4.6.7, Prisma 7.10.1, vitest 4.1.12, vite 6.4.5, Electron 45.1.0, `multer` pinned to 2.5.0 through npm `overrides`):
  - **Production dependencies: 0 vulnerabilities.**
  - **All dependencies: 8 low**, all in the dev-only `deepmerge` chain under jest / @nestjs/cli. npm's suggested "fix" is a downgrade to 2019 releases, so they are accepted.
  - Python dependencies were not scanned (`pip-audit` is not installed): NOT VALIDATED.

## 19. Features added on 2026-10-28 (NOT VALIDATED)

| Feature | Controls |
|---|---|
| Integrations (FR-17) | Admin-only registry (`settings:manage`). Only registered, enabled integrations can be used, and only their allowed path prefixes (REST) or tool names (MCP); the policy engine denies everything else. REST POST and every MCP tool call are HIGH risk with external effects, so they **always** need approval, even with an ALLOW rule. Credentials stay in the AI service's DPAPI store; only the secret name is in MySQL. The AI service re-checks the limits, refuses redirects, allows only `https://` (or loopback `http://`), times out after 30 s and caps responses at 1 MB. A timeout becomes UNCERTAIN and is never retried. MCP over stdio is unsupported by design (no local program is ever started). |
| Research (FR-18) | Read-only. Sources are public http(s) hosts only (no private/loopback addresses, no executables), one page per domain. The user's WEBSITE DENY rules are passed to the agent and enforced on every page. CAPTCHA pages are skipped and listed, never bypassed. Page text is untrusted and flagged for injection phrases. Claims are kept only if they cite fetched sources; "verified" is decided by fixed rules, not by the model. In the dashboard, only http(s) source URLs become links (`rel="noopener noreferrer"`). |
| Screenshot attachments (FR-01) | At most 3 PNG/JPEG, 1.5 MB each; the declared type must match the file signature, otherwise nothing is stored. Files are stored outside the web root and served only to the task owner (or `task:read_all`) with `nosniff` and `no-store`. Paths are generated server-side and resolved inside `STORAGE_DIR` only. Images go only to vision-capable models; under `CLOUD_REDACTED` only to local ones. |
| OCR (FR-04) | Windows' built-in OCR engine, locally. The PowerShell script is a constant run by full path; the image path is passed in an environment variable, so task data cannot reach the command line. |
| TLS (FR-20) | See section 2. |
| Offline planning retries (FR-14) | Re-planning only produces a plan; policy and approvals still apply. Paused during emergency stop. Cancel ends the wait. |
| Update / rollback scripts (FR-19) | Snapshots include `.env` files and a full database dump in `backups\releases`: protect that folder like the database. The MySQL root password used by `install.ps1` is read from a secure prompt or `WINAGENT_MYSQL_ROOT_PASSWORD`, sent to `mysql.exe` on stdin and never stored. The generated `winagent` password exists only in `server\.env`. |
