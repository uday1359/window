# WinAgent API reference

This file is written from the source code: `server/src/**/*.controller.ts`, `server/src/auth/*`,
`server/src/common/*`, `server/src/realtime/*`, `agent/winagent/client.py` and
`ai-service/app/main.py`. If this file and the code disagree, the code is correct.

- Base URL (development): `http://127.0.0.1:3710` (`HOST`/`PORT` in `server/.env`). The Vite dev server on `:5173` proxies `/api` and `/ws` to it.
- **No global prefix.** `bootstrap.ts` does not call `setGlobalPrefix`. Each controller puts `api/...` in its own path.
- In production the server also serves the built dashboard. Any `GET` that does not start with `/api` or `/ws` gets `index.html` (SPA fallback).
- JSON request body limit: **2 MB**. Helmet sets a CSP: `default-src 'self'`, `connect-src 'self' ws://127.0.0.1:* ws://localhost:*`, `frame-ancestors 'none'`. CORS is **not** enabled.
- Ids are UUIDs. Path parameters named `:id` / `:taskId` go through `ParseUUIDPipe`, so a non-UUID gets **400**.
- Timestamps are ISO-8601 UTC strings. `BigInt` values (audit event ids, backup sizes) are serialised as **strings**.

## 1. Authentication, CSRF and RBAC

### Session
- `POST /api/auth/login` sets the cookie **`wa_session`**: an opaque random token (32 bytes, base64url) with `HttpOnly`, `SameSite=Strict` and `Path=/`. `Secure` is set only when `NODE_ENV=production` and the request arrived over TLS.
- The server stores only `sha256(token)` (`UserSession.tokenHash`).
- Absolute lifetime: `SESSION_TTL_HOURS` (default 12). Idle timeout: `SESSION_IDLE_MINUTES` (default 60). An idle session is revoked the next time it is used. `lastSeenAt` is written at most once a minute.
- Account lockout: after **5** failed passwords the account is locked for **15 minutes** (`auth.service.ts`). Unknown e-mail addresses run a dummy scrypt check, so their response takes about as long as a known address.
- A password change revokes every other session of that user.

### Global guard (`auth.guard.ts`, registered as `APP_GUARD`)
The guard runs these checks in order on every HTTP route:

1. **CSRF.** Any method except `GET`, `HEAD` and `OPTIONS` must send the header **`x-winagent-csrf: 1`**. Otherwise the response is **403 `Missing CSRF header`**. The check runs **before** the public-route check, so it also applies to the public `POST` routes (login, bootstrap, agent pairing).
2. Routes marked `@Public()` stop here.
3. The guard resolves the session from the `wa_session` cookie. If the session is missing, invalid, expired, revoked or idle, or the user is inactive, the response is **401 `Authentication required`**.
4. **Permissions.** `@RequirePermissions(...)` requires **all** listed permissions. The guard reads them from the database through role → permission, never from the client. A missing permission gets **403 `You do not have permission to perform this action`**.

Routes without `@RequirePermissions` accept **any authenticated user**.

### Roles and permissions (`rbac.ts`, synced to MySQL at startup)

| Permission | Meaning | ADMIN | OPERATOR | VIEWER |
|---|---|:-:|:-:|:-:|
| `task:create` | Create tasks | ✔ | ✔ | |
| `task:read` | Read own tasks | ✔ | ✔ | ✔ |
| `task:read_all` | Read every user's tasks | ✔ | | |
| `task:control` | Pause/resume/cancel/reorder own tasks | ✔ | ✔ | |
| `approval:decide` | Approve/reject actions on own tasks | ✔ | ✔ | |
| `agent:manage` | Pair and revoke agent devices | ✔ | | |
| `agent:read` | View agent devices | ✔ | ✔ | ✔ |
| `settings:manage` | Manage AI models and secrets | ✔ | | |
| `policy:manage` | Manage own permission policies | ✔ | ✔ | |
| `memory:manage` | Manage own memory and skills | ✔ | ✔ | |
| `audit:read` | Read own audit events | ✔ | ✔ | ✔ |
| `audit:read_all` | Read all audit events | ✔ | | |
| `system:emergency_stop` | Trigger emergency stop | ✔ | ✔ | ✔ |
| `system:admin` | Clear emergency stop, manage users, backups | ✔ | | |

Ownership rules sit in the services and apply on top of these permissions:
- Tasks are scoped to their owner. `task:read_all` lets a user *read* another user's task, but never *control* it. Control actions call `getOwned(..., forControl=true)` and answer **404** for tasks the caller does not own.
- Devices, policies, memory, skills, notifications, sessions and preferences are always scoped to the caller.

## 2. Error format (`common/errors.ts`, `AllExceptionsFilter`)

| Situation | Status | Body |
|---|---|---|
| Zod validation failure (`parse()`) | 400 | `{ statusCode: 400, message: "Validation failed", issues: [{ path, message }] }` |
| `HttpException` with a string message | as thrown | `{ statusCode, message }` |
| Nest built-in exceptions (`NotFoundException('x')`, …) | as thrown | `{ statusCode, message, error }` |
| Prisma `P2002` (unique constraint) | 409 | `{ statusCode: 409, message: "A record with these values already exists" }` |
| Prisma `P2025` (record not found) | 404 | `{ statusCode: 404, message: "Not found" }` |
| `AiServiceError` (AI-service call failed) | 404 / 400 / 502 / 503 | AI-service 404 → 404 and 400/422 → 400, both with the redacted AI-service message; other statuses → 502, AI service unreachable → 503, both `{ message: "AI service unavailable" }` |
| Anything else | 500 | `{ statusCode: 500, message: "Internal server error" }`. The server logs the details in redacted form and sends no stack trace. |

This applies to the `/api/secrets*` routes and `/api/models/route-preview`. During planning, AI-service failures do not surface as HTTP errors: the task becomes BLOCKED with `Planner unavailable (…)`.

## 3. Rate limits (`common/rate-limit.ts`)

The limiter is a fixed-window, in-memory counter for each process, keyed by `req.ip` (`trust proxy` is `false`). Every attempt counts, including successful ones. The counters reset when the server restarts.

| Route | Limit | Over the limit |
|---|---|---|
| `POST /api/auth/login` | `LOGIN_RATE_LIMIT_PER_MIN` per IP per 60 s (default 10) | 429 `Too many login attempts. Wait a minute and try again.` |
| `POST /api/agents/pair` | 10 per IP per 60 s (hard-coded) | 429 `Too many pairing attempts` |

No other route is rate-limited.

## 4. HTTP endpoints

Abbreviations: **Auth** = any authenticated user; **Public** = no session (the CSRF header is still required for non-GET methods).

### 4.1 Auth: `api/auth` (`auth/auth.controller.ts`)

| Method & path | Permission | Request body | Response | Notable errors |
|---|---|---|---|---|
| `GET /api/auth/status` | Public | – | `{ needsBootstrap: boolean }` (true while no user exists) | – |
| `POST /api/auth/bootstrap` | Public | `email` (valid e-mail, ≤254, trimmed), `displayName` (1–100), `password` (12–200) | `{ id }`. Creates the first ADMIN. Concurrent attempts are serialised with `SELECT … FOR UPDATE` on `SystemState`. | 409 `Setup has already been completed`, 409 for a duplicate e-mail |
| `POST /api/auth/login` (200) | Public, rate-limited | `email`, `password` (1–200) | `{ ok: true, expiresAt }` and sets the `wa_session` cookie | 401 `Invalid email or password`, 401 `Account temporarily locked…`, 429 |
| `POST /api/auth/logout` (200) | Auth | – | `{ ok: true }`. Revokes the current session and clears the cookie. | – |
| `GET /api/auth/me` | Auth | – | `{ id, email, displayName, roles[], permissions[] }` (permissions sorted) | – |
| `GET /api/auth/sessions` | Auth | – | `[{ id, userAgent, createdAt, lastSeenAt, expiresAt, current }]`: the caller's active sessions | – |
| `DELETE /api/auth/sessions/:id` | Auth | – | `{ ok: true }` | 404 `Session not found` (also for another user's session) |
| `POST /api/auth/password` (200) | Auth | `currentPassword` (1–200), `newPassword` (12–200) | `{ ok: true }`. Revokes all other sessions. | 401 `Current password is incorrect` |
| `POST /api/auth/users` (201) | `system:admin` | `email`, `displayName`, `password` (as for bootstrap), `role`: `ADMIN`\|`OPERATOR`\|`VIEWER` | `{ id }` | 409 for a duplicate e-mail |

The code has no endpoint for listing, editing, deactivating or deleting users.

### 4.2 Tasks: `api/tasks` (`tasks/tasks.controller.ts`, `tasks.service.ts`)

| Method & path | Permission | Request | Response | Notable errors |
|---|---|---|---|---|
| `POST /api/tasks` | `task:create` | Body: `instruction` (1–5000, required), `title?` (1–200), `privacyLevel` (`LOCAL_ONLY` default \| `CLOUD_REDACTED` \| `CLOUD_ALLOWED`), `priority` (int −10..10, default 0), `deadline?` (date), `dependsOn` (≤20 UUIDs, default `[]`), `agentDeviceId?` (UUID). Optional header **`Idempotency-Key`**: 8–100 characters from `[A-Za-z0-9_-]`. | **201** with the new task, or **200** with the existing task when the idempotency key was already used by this user. Both carry `duplicate: boolean`. Planning then starts asynchronously. | 400 when the instruction appears to contain a secret, 400 `Dependencies must be your own existing tasks`, 400 `Agent device not found or revoked`, 400 for an invalid Idempotency-Key |
| `GET /api/tasks` | `task:read` | Query: `status` (comma-separated `TaskStatus` values; unknown values are dropped), `search?` (≤200; matches title or instruction), `all` (`0`\|`1`; only takes effect with `task:read_all`), `page` (≥1, default 1), `pageSize` (1–100, default 25) | `{ items: [{ id, title, status, statusReason, progress, riskLevel, privacyLevel, queuePosition, priority, createdAt, finishedAt, planSource, userId }], total, page, pageSize }`, newest first | – |
| `GET /api/tasks/queue` | `task:read` | – | The caller's tasks in `QUEUED`, `RUNNING`, `AWAITING_APPROVAL`, `PAUSED` or `PLANNING`, ordered by `queuePosition`: `[{ id, title, status, queuePosition, progress }]` | – |
| `GET /api/tasks/:id` | `task:read` | – | The full task with `steps`, `approvals` (plus `decision`), `evidence`, `checkpoints`, `executions` (latest 50), `dependsOn`, `agentDevice { id, name, status }` | 404 `Task not found` |
| `GET /api/tasks/:id/audit` | `task:read` + `audit:read` | – | Up to 500 audit events for the task, oldest first | 404 |
| `POST /api/tasks/:id/pause` (200) | `task:control` | – | `{ ok: true }`. Allowed from `PLANNING`, `QUEUED`, `RUNNING` or `AWAITING_APPROVAL`. | 404, 409 `Task cannot move to PAUSED…` |
| `POST /api/tasks/:id/resume` (200) | `task:control` | Body (optional): `confirmUncertain` (bool, default false) | `{ status: "QUEUED" \| "PLANNING", inspected: string[] }`. Before re-queuing, the server re-checks completed `file.write` steps on disk with `file.stat`, asks the agent's journal about `RUNNING`/`UNCERTAIN` steps, and resets failed or cancelled steps. | 409 when not resumable (allowed from `PAUSED`, `INTERRUPTED`, `BLOCKED`, `FAILED`, `AWAITING_APPROVAL`), 409 while the emergency stop is active, 409 when the agent must be connected for the inspection, 409 when a step is still running on the agent, 409 when a non-idempotent step has an unknown outcome and `confirmUncertain` is false |
| `POST /api/tasks/:id/cancel` (200) | `task:control` | – | `{ ok: true }`. Pending steps become `CANCELLED`, pending approvals become `SUPERSEDED`, and the in-flight agent operation is cancelled. | 409 `Task is already finished`, 409 for an invalid transition |
| `PATCH /api/tasks/:id/position` | `task:control` | `queuePosition` (int ±1 000 000) | `{ ok: true }` | 409 `Only waiting tasks can be reordered` (allowed in `QUEUED`, `PAUSED`, `AWAITING_APPROVAL`, `BLOCKED`, `INTERRUPTED`) |
| `POST /api/tasks/:id/clarify` (200) | `task:create` | `answer` (1–2000) | `{ ok: true }`. Appends the answer to `clarification` (the newest 5000 characters are kept) and re-plans **synchronously**. | 409 `Task is not waiting for clarification`, 400 when the answer appears to contain a secret |

### 4.3 Approvals: `api/approvals` (`approvals/*`)

| Method & path | Permission | Request | Response | Notable errors |
|---|---|---|---|---|
| `GET /api/approvals` | `task:read` | Query `status?` (`PENDING`\|`APPROVED`\|`REJECTED`\|`EXPIRED`\|`SUPERSEDED`; any other value is ignored) | Up to 200 requests, newest first, each with `decision { decision, comment, createdAt, userId }`, `task { id, title, status }` and `step { index, params }`. Own tasks only, unless the caller has `task:read_all`. Expires stale `PENDING` requests first. | – |
| `POST /api/approvals/:id/decision` (200) | `approval:decide` | `decision`: `APPROVE`\|`REJECT`; `actionHash`: 64 lowercase hex characters (must equal the request's hash); `comment?` (≤500); `channel`: `web` (default) \| `desktop` (voice is not accepted) | `{ ok: true }`. Approve sets the step to `PENDING` and the task to `QUEUED`. Reject sets the step to `CANCELLED` and the task to `REJECTED`. | 404, 403 when the task belongs to someone else and the caller lacks `system:admin`, 409 when already decided, 410 when expired, 409 when the hash differs from the request, 409 when the action changed since the request (the request becomes `SUPERSEDED`), 409 on a concurrent decision |

`actionHash = sha256(canonicalJson({ taskId, stepId, operation, params }))` (`common/crypto.ts`). Approvals expire after `APPROVAL_TTL_MINUTES` (default 30).

### 4.4 Agent devices: `api/agents` (`agents/agents.controller.ts`)

| Method & path | Permission | Request | Response | Notable errors |
|---|---|---|---|---|
| `GET /api/agents` | `agent:read` | – | The caller's devices: `[{ id, name, hostname, osVersion, agentVersion, status, capabilities, allowedRoots, lastResources, lastSeenAt, createdAt, revokedAt, connected }]` | – |
| `POST /api/agents/pairing-codes` (201) | `agent:manage` | – | `{ code, expiresAt }`. A 10-character code (alphabet without ambiguous characters) that is valid for 10 minutes. Only its sha256 is stored. | – |
| `POST /api/agents/pair` (201) | **Public**, rate-limited, CSRF header required | `code` (10 characters `[A-Z0-9]`, upper-cased), `name` (1–100), `hostname` (1–255), `osVersion?` (≤100) | `{ deviceId, token }`. The device token is returned **once**. Only its sha256 is stored. The device belongs to the user who created the code. | 401 `Pairing code is invalid, expired or already used`, 429 |
| `POST /api/agents/:id/revoke` (200) | `agent:manage` | – | `{ ok: true }`. Marks the device `REVOKED`, sends `revoked` to it and closes its socket. | 404 `Active device not found` |

### 4.5 Preferences, policies, models, secrets: `api` (`settings/settings.controller.ts`)

| Method & path | Permission | Request | Response | Notable errors |
|---|---|---|---|---|
| `GET /api/preferences` | Auth | – | Every whitelisted preference, with defaults filled in: `theme` (`system`), `voiceInput` (false), `spokenFeedback` (false), `approveMediumRisk` (false), `cloudCostLimitUsd` (0.05), `defaultPrivacyLevel` (`LOCAL_ONLY`), `historyRetentionDays` (365) | – |
| `PUT /api/preferences` (200) | Auth | Partial object of whitelisted keys: `theme` `system\|light\|dark`; `voiceInput`, `spokenFeedback`, `approveMediumRisk` bool; `cloudCostLimitUsd` 0–10; `defaultPrivacyLevel` enum; `historyRetentionDays` int 1–3650 | The full preference object after the update (one transaction) | 400 `Unknown preference "<key>"`, 400 validation |
| `GET /api/policies` | `policy:manage` | – | The caller's non-revoked policies | – |
| `POST /api/policies` (201) | `policy:manage` | `kind` `FOLDER\|WEBSITE\|APPLICATION\|ACTION`; `value` (1–500, format checked per kind, see below); `effect` `ALLOW\|DENY\|REQUIRE_APPROVAL`; `note?` (≤255) | The created `PermissionPolicy`. `WEBSITE` values are lower-cased. | 400 `Invalid <kind> value` |
| `DELETE /api/policies/:id` | `policy:manage` | – | `{ ok: true }`. Soft revoke (`revokedAt`). | 404 `Policy not found` |
| `GET /api/models` | `task:read` | – | Every `ModelConfig` row, ordered by name | – |
| `POST /api/models` (201) | `settings:manage` | `name` (1–100), `provider` `ollama\|openai_compatible\|anthropic`, `model` (1–100), `endpoint` (URL ≤500; must be `https://`, or `http://127.0.0.1`/`localhost`), `isLocal` bool, `enabled` (default true), `maxComplexity` 1–5 (default 3), `latencyClass` 1–3 (default 2), `costPer1kTokens` 0–1000 (default 0), `capabilities` ⊆ `planning,vision,ocr,chat` (default `[planning]`), `secretRef?` (`[a-z0-9_-]{1,100}` or null) | The created model | 409 for a duplicate name |
| `PATCH /api/models/:id` | `settings:manage` | Any subset of the fields above | The updated model | 404 (P2025), 409 |
| `DELETE /api/models/:id` | `settings:manage` | – | `{ ok: true }` | 404 (P2025) |
| `POST /api/models/route-preview` (200) | `task:read` | `privacyLevel` (enum), `complexity` (int 1–5), `capability` (default `planning`) | The AI service's `RoutingDecision` (see §7) for the enabled models. The cost limit is hard-coded to `0.05`. | 500 when the AI service fails |
| `GET /api/secrets` | `settings:manage` | – | `{ names: string[] }`, passed through from the AI service. Values are never returned. | 502/503 when the AI service fails |
| `PUT /api/secrets/:name` (200) | `settings:manage` | Path `name` `[a-z0-9_-]{1,100}`; body `value` (1–4096) | `{ ok: true }`. The AI service stores the value encrypted with DPAPI, never in MySQL. | 400 for an invalid name, 500 when the AI service fails (including "DPAPI unavailable") |
| `DELETE /api/secrets/:name` | `settings:manage` | – | `{ ok: true }` | 404 `secret not found`; 502/503 when the AI service fails |

Policy `value` formats: `FOLDER` is `root` or `root:relative/path` (root matches `[a-z][a-z0-9_-]{0,31}`, no `..`). `WEBSITE` is a domain, `*.domain`, or `localhost`. `APPLICATION` matches `[a-z][a-z0-9_-]{0,31}`. `ACTION` is `*` or `family.operation`.

### 4.6 Memory and skills: `api` (`memory/memory.controller.ts`)

Every route below needs `memory:manage`. Content that `containsSecret()` flags is rejected with **400**.

| Method & path | Extra permission | Request | Response | Notable errors |
|---|---|---|---|---|
| `GET /api/memory` | – | – | The caller's `MemoryRecord[]`, most recently updated first | – |
| `POST /api/memory` (201) | – | `kind` `preference\|fact\|recovery_strategy\|task_summary`; `content` (1–5000); `source?` (≤100) | The created record | 400 for secret-like content |
| `PATCH /api/memory/:id` | – | `content` | `{ ok: true }` | 404 |
| `DELETE /api/memory/:id` | – | – | `{ ok: true }` | 404 |
| `POST /api/memory/delete-all` (200) | – | `confirm: true` | `{ deleted: n }` | 400 without the confirmation |
| `GET /api/memory/export` | – | – | `{ exportedAt, memory, skills, preferences }` with `Content-Disposition: attachment; filename="winagent-memory-export.json"` | – |
| `GET /api/skills` | – | – | The caller's `WorkflowSkill[]` | – |
| `POST /api/skills/from-task/:taskId` (201) | – | `name` (1–100), `description` (≤500, default `''`, which falls back to the task title) | The created skill (`validationStatus: VALID`). The plan's task-specific folder is generalised. | 404, 409 `Only verified successful tasks can be saved as skills`, 409 for a duplicate name (P2002) |
| `PATCH /api/skills/:id` | – | `name?`, `description?`, `enabled?` | The updated skill | 404, 409 `Validate the skill successfully before enabling it` |
| `DELETE /api/skills/:id` | – | – | `{ ok: true }` | 404 |
| `POST /api/skills/:id/validate` (200) | – | – | The updated skill. Re-checks the plan against the whitelist and current policy, and disables the skill if the check fails. | 404 |
| `POST /api/skills/:id/run` (201) | `task:create` | – | The new task, created with the stored plan (`privacyLevel: LOCAL_ONLY`). Increments `useCount`. | 404, 409 `Skill failed validation and was disabled: …` |

`run` re-validates the skill first, then refuses a disabled skill with 409 `Skill is disabled; enable it before running it`. Re-validation does not set `enabled` back to true.

### 4.7 Notifications: `api/notifications` (`notifications/notifications.service.ts`)

| Method & path | Permission | Request | Response |
|---|---|---|---|
| `GET /api/notifications` | Auth | Query `unread=1` (optional) | The latest 100 notifications for the caller |
| `POST /api/notifications/read-all` (200) | Auth | – | `{ updated: n }` |
| `POST /api/notifications/:id/read` (200) | Auth | – | `{ updated: 0 \| 1 }`. An unknown id returns `0`, not 404. |

### 4.8 System, diagnostics, audit: `api` (`system/system.controller.ts`)

| Method & path | Permission | Request | Response | Notable errors |
|---|---|---|---|---|
| `GET /api/health` | **Public** | – | `{ status: "ok" }`, or `{ status: "degraded" }` when MySQL is unreachable (still HTTP 200) | – |
| `GET /api/system/state` | Auth | – | `{ emergencyStop, emergencyStopAt, queueEnabled, orchestratorBusy }` | – |
| `POST /api/system/emergency-stop` (200) | `system:emergency_stop` | `source?` `web` (default) \| `desktop` \| `tray` | `{ pausedTasks }`. Sets the stop flag, pauses every task in `PLANNING`/`QUEUED`/`RUNNING`/`AWAITING_APPROVAL`, marks `RUNNING` steps `UNCERTAIN`, cancels in-flight operations and broadcasts to every agent. | – |
| `POST /api/system/emergency-stop/clear` (200) | `system:admin` | `confirm: true` | `{ ok: true, note }`. Paused tasks stay paused. | 400 without `confirm: true` |
| `POST /api/system/queue` (200) | `system:admin` | `enabled` bool | `{ ok: true }`. While false, the orchestrator does not start queued tasks. | – |
| `GET /api/diagnostics` | Auth | – | `{ version, server { uptimeSec, rssMb, heapUsedMb, node, dashboardConnections }, database { ok, latencyMs, migrations[] }, aiService { ok, …/health }, agents[] (own active devices with `connected`), queue { queued, running, blocked, orchestratorBusy } }` | – |
| `GET /api/audit` | `audit:read` | Query: `action?` (prefix match, ≤64), `taskId?` (UUID), `before?` (audit id, cursor), `limit` (1–200, default 100) | `AuditEvent[]`, newest first. Without `audit:read_all`, the list is limited to events the caller performed, events on the caller's tasks, and events performed by the caller's devices. | 400 |

### 4.9 Backups: `api/backups` (`backups/backups.service.ts`)

Every backup route needs `system:admin`.

| Method & path | Request | Response | Notable errors |
|---|---|---|---|
| `GET /api/backups` | – | The latest 50 `ConfigBackup` rows, each with `fileExists` and `currentSize` (the `filePath` on the server is included) | – |
| `POST /api/backups/database` (201) | – | The created `ConfigBackup` (`kind: database`). Runs `mysqldump --single-transaction` into `BACKUP_DIR`. | 500 `Database backup failed; see server logs` |
| `POST /api/backups/config` (201) | – | The created `ConfigBackup` (`kind: config`). A JSON export of models, active policies and preferences, without secrets. | – |
| `POST /api/backups/:id/verify-restore` (200) | – | The updated backup, with `restoreTestedAt` and `restoreTestResult` (`PASSED: …` or `FAILED: …`) | 404 `Database backup not found`, 404 `Backup file is missing` |

## 5. Dashboard WebSocket: `GET /ws/events`

Defined in `realtime/ws-gateway.service.ts` and `events.service.ts`. The HTTP server's `upgrade` event authenticates the connection before the handshake completes. Any other `/ws/*` path gets 404.

| Aspect | Behaviour |
|---|---|
| Origin check | The `Origin` header must be one of: `WEB_ORIGIN`, `http://{HOST}:{PORT}`, `http://localhost:{PORT}`, `http://127.0.0.1:{PORT}`, `http://localhost:5173`, `http://127.0.0.1:5173`. Otherwise **403**. |
| Authentication | The `wa_session` cookie, resolved like an HTTP session. Failure gets **401**. |
| Max inbound frame | 64 KiB |
| Direction | Server → client only. Messages from the client are ignored. |
| Session re-check | Every 60 s. A socket whose session was revoked or has expired is closed with code **4001** `session ended`. Idle timeout is not re-checked here. |
| Scope | Each event goes to the owning user, and to every subscriber who has `task:read_all`. `ownerId = null` means every subscriber. |
| Payload | JSON. Passed through `redact()`, with `at` (ISO time) added. |

Events (every one that `events.publish` sends in `server/src`):

| `type` | Fields | Sent to | Source |
|---|---|---|---|
| `hello` | `userId` | the new socket | ws-gateway (on connect) |
| `task.updated` | `taskId, status, statusReason, progress` | owner | `TaskStateService.transition` |
| `step.updated` | `taskId, step { id, index, status, error? }` | owner | orchestrator via `publishStep` |
| `approval.created` | `taskId, approvalId` | owner | `ApprovalsService.request` |
| `approval.decided` | `approvalId, taskId, approved` | owner | `ApprovalsService.decide` |
| `notification` | `notification` (the full `Notification` row) | owner | `NotificationsService.notify` |
| `agent.status` | `deviceId, connected` | device owner | agent hub (after `hello`, and on close) |
| `agent.resources` | `deviceId, resources` | device owner | agent hub (on a heartbeat that includes resources) |
| `system.emergency_stop` | `active` | everyone | `SystemService` |

## 6. Agent WebSocket: `GET /ws/agent`

Defined in `realtime/agent-hub.service.ts` and `ws-gateway.service.ts`. The agent side is `agent/winagent/client.py` and `executor.py`.

### Connection
- The agent connects **outbound** to `ws_url` with the header `Authorization: Bearer <device token>`. The token must match `[A-Za-z0-9_-]{20,200}`, its sha256 must match an `AgentDevice` row, and the device must be `ACTIVE`. Otherwise the server answers **401**. On a 401 the agent stops and asks to be paired again.
- Max frame size: 8 MiB on both sides.
- A new connection for the same device replaces the old one. The old socket is closed with code `4000` `replaced by a new connection`.
- Each connection creates an `AgentSession` row, which is closed on disconnect.
- The server pings every **20 s** and terminates a connection that missed the previous pong.
- The device does not receive work until it has sent `hello` (`ready = true`).
- The agent reconnects with exponential backoff from 1 s up to 30 s.

### Agent → server (validated with zod. Invalid or non-JSON messages are logged and dropped.)

| `type` | Fields | Server effect |
|---|---|---|
| `hello` | `agentVersion` (≤50), `hostname` (≤255), `osVersion?` (≤100), `roots[]` (≤50 names `[a-z][a-z0-9_-]{0,31}`), `apps[]` (≤100 names), `capabilities?` (record of booleans) | Updates the device (`allowedRoots`, `capabilities = { apps, ...capabilities }`, version, lastSeenAt), marks the connection ready, and publishes `agent.status`. The agent sends `hello` immediately on open, with capabilities `files, browser, uia, screenshots, ocr`. |
| `heartbeat` | `resources?` (object or `null` when the agent could not read them), `emergencyStop?` (bool) | Updates `lastSeenAt` (and `lastResources`) and publishes `agent.resources`. `emergencyStop` is accepted but **ignored** by the server. The agent sends a heartbeat every `heartbeat_seconds`. |
| `op_result` | `operationId` (UUID), `ok`, `output?` (object), `error?` (≤2000), `code?` (≤64) | Resolves the pending dispatch. The error text is redacted. A result that arrives after the timeout is dropped and reconciled later through `op_status`. |
| `op_status_result` | `operationId`, `state` `completed\|running\|unknown`, `result?` `{ ok, output?, error?, code? }` | Answers a `queryStatus` call |

### Server → agent

| `type` | Fields | Agent behaviour |
|---|---|---|
| `emergency_stop` | `active` | Sent right after connect and whenever the stop state changes. The agent's executor stops or resumes accepting operations. |
| `op` | `operationId` (a new UUID for each attempt), `operation`, `params`, `approvalHash` (64 hex characters or null), `timeoutMs`, `taskId` | Runs the operation through `Executor.execute`, one at a time, and replies with `op_result` |
| `cancel` | `operationId` | Cancels the running operation. The server sends this on timeout, on task cancel and on emergency stop. |
| `op_status` | `operationId` | Replies with `op_status_result` from the local journal (`journal.jsonl`). An entry that was interrupted by an agent crash is reported as `unknown`. The server waits up to 10 s, then treats the answer as `unknown`. |
| `revoked` | `reason` | The agent clears its stored token and exits. The server then closes the socket with code `4001`. |

Agent-side safety checks, independent of the server (`executor.py`):
- A repeated `operationId` is never executed twice. The agent returns the stored result, or `UNCERTAIN`.
- While emergency-stopped, every operation gets `EMERGENCY_STOP`.
- `file.delete`, `browser.submit`, `browser.click` and `desktop.type_text` need an `approvalHash` of 64 hex characters, otherwise `APPROVAL_MISMATCH`.
- A local `EMERGENCY_STOP` file in the agent home directory cancels running operations.

Result `code` values that the code base handles include `CANCELLED`, `EMERGENCY_STOP`, `UNCERTAIN`, `APPROVAL_MISMATCH`, `INVALID_PARAMS` and `ERROR`, plus `OpError` codes from the operation modules.

Device pairing uses HTTP (`POST /api/agents/pair`, §4.4). `python -m winagent pair` sends the `x-winagent-csrf: 1` header.

## 7. AI service internal API (`ai-service/app/main.py`, `schemas.py`)

FastAPI service that listens on `AI_HOST`:`AI_PORT` (default `127.0.0.1:8710`). The interactive docs and OpenAPI routes are disabled. Only the WinAgent server calls it (`server/src/ai/ai-client.service.ts`).

- **Auth:** every `/v1/*` route needs the header `X-Service-Token`, equal to `AI_SERVICE_TOKEN` (at least 32 characters; the server and the AI service use the same value). The comparison uses `hmac.compare_digest`. A wrong token gets 401 `{"detail": "invalid service token"}`.
- **Errors:** FastAPI's `{ "detail": … }` (422 for validation). Unhandled errors return 500 `{"detail": "internal error"}` and are logged in redacted form.
- **Server-side timeouts:** `/v1/plan` 90 s, `/health` 5 s, everything else 10 s.

| Method & path | Auth | Request | Response | Errors |
|---|---|---|---|---|
| `GET /health` | **none** | – | `{ status: "ok", ollama: { reachable, models[] }, secretStore: "dpapi"\|"unavailable", ocr: false, vision: false }` | – |
| `POST /v1/plan` | token | `PlanRequest`: `instruction` (1–12000: up to 5000 of instruction plus up to 5000 of clarification), `privacyLevel`, `models[]` (ModelInfo), `roots[]`, `apps[]`, `operations[] { name, description, risk }`, `costLimitUsd` (≥0, default 0.05), `resources?` | `PlanResponse`: `{ plan: object, source: string, routing: RoutingDecision, warnings[] }`. The server treats `plan` as untrusted and validates it against its operation whitelist. | 503 when no model is available (`NoModelAvailable`) |
| `POST /v1/route` | token | `RouteRequest`: `privacyLevel`, `models[]`, `complexity` (1–5, default 2), `capability` (default `planning`), `costLimitUsd`, `resources?` | `RoutingDecision`: `{ model: string\|null, cloud, reason, redacted, candidates[], excluded{name: reason} }` | – |
| `GET /v1/secrets` | token | – | `{ names: string[] }` | – |
| `PUT /v1/secrets/{name}` | token | `{ value }` (1–4096) | `{ ok: true }` | 400 `invalid secret name` (the name must match `^[a-z0-9_-]{1,100}$`), 503 when DPAPI is unavailable |
| `DELETE /v1/secrets/{name}` | token | – | `{ ok: true }` | 400, 404 `secret not found` |

`ModelInfo` fields: `name`, `provider` (`ollama|openai_compatible|anthropic`), `model`, `endpoint`, `isLocal`, `enabled`, `maxComplexity` 1–5, `latencyClass` 1–3, `costPer1kTokens` ≥0, `capabilities[]`, `secretRef?`.

## 8. Unclear or not covered by the code

- No OpenAPI or Swagger document is generated; this file is the only reference.
- The response bodies of the `GET` list endpoints are the raw Prisma rows (all columns) unless a `select` is listed above. Their exact shape follows `server/prisma/schema.prisma` (see [DATABASE.md](DATABASE.md)).
- The list of `OpError` codes per operation lives in `agent/winagent/ops_*.py` and `errors.py`; this file does not list them.

## 9. Additions on 2026-10-28 (NOT VALIDATED)

### HTTP endpoints

| Method and path | Permission | Request | Response / notes |
|---|---|---|---|
| `POST /api/tasks` (changed) | `task:create` | New optional `attachments`: up to 3 × `{ mediaType: "image/png" \| "image/jpeg", data: <base64> }`, ≤ 1.5 MB each. This route accepts bodies up to 7 MB. | 400 if a file's signature does not match its type, or too many / too large. The task is created only if all files are stored. |
| `GET /api/tasks/:id` (changed) | `task:read` | – | Adds `attachments: [{ id, mediaType, sizeBytes, sha256, createdAt }]` |
| `GET /api/tasks/:id/attachments/:attachmentId` | `task:read` (owner, or `task:read_all`) | – | The image bytes with its `content-type`, `content-disposition: inline`, `cache-control: private, no-store`. 404 for another user's task. |
| `POST /api/tasks/:id/resume` (changed) | `task:control` | – | If the deadline has passed, it is cleared (audited `task.deadline_overridden`) and the task runs. |
| `GET /api/integrations` | `settings:manage` | – | All integrations |
| `POST /api/integrations` | `settings:manage` | `name` (`[a-z][a-z0-9_-]{0,31}`), `kind` (`REST`\|`MCP`), `description?`, `baseUrl` (https, or http to loopback; no credentials), `allowedPaths[]` (REST, ≥ 1), `allowedTools[]` (MCP), `authHeader?`, `authScheme?`, `secretRef?`, `enabled?` | The integration (201). Audited. |
| `PATCH /api/integrations/:id` | `settings:manage` | Any field except `name`, `kind` | Updated integration. Audited. |
| `DELETE /api/integrations/:id` | `settings:manage` | – | `{ ok: true }`. Audited. |
| `POST /api/integrations/:id/tools` | `settings:manage` | – | MCP only: `{ tools: [{ name, description }] }` from the server's `tools/list`. |

### Error mapping (changed)

`AiServiceError` from the AI service: 404 → 404 and 400/422 → 400 (with the message); other
statuses → 502; AI service unreachable → 503 `AI service unavailable`.

### New operations (plan steps)

| Operation | Params | Base risk | Runs on |
|---|---|---|---|
| `desktop.ocr` | `titleContains?` | LOW | agent |
| `browser.research` | `query`, `maxSources` (1-5, default 3), `blockedDomains?` (set by the server from WEBSITE DENY rules) | MEDIUM | agent; the server adds `findings` |
| `integration.rest_get` | `integration`, `path`, `query?` | MEDIUM | server, via the AI service |
| `integration.rest_post` | `integration`, `path`, `query?`, `body` | HIGH, external (always approval) | server, via the AI service |
| `integration.mcp_tool` | `integration`, `tool`, `arguments` | HIGH, external (always approval) | server, via the AI service |

New success criterion: `screen_contains_text { text, titleContains? }`. The verifier runs
`desktop.ocr` and compares the text ignoring case and whitespace. If OCR is unavailable, the
result is INCONCLUSIVE.

### AI service

| Method and path | Purpose |
|---|---|
| `POST /v1/plan` (changed) | Optional `images` (≤ 3). With images, the rule planner is skipped and a `vision` model is required; under `CLOUD_REDACTED` only local models get images. A 503 body is now `{ detail: { message, retryable } }`. |
| `POST /v1/research/synthesize` | `{ question, sources[{id,url,title,domain,trust,text}], privacyLevel, models, costLimitUsd }` → `{ claims[{text,sources,status}], model, note, warnings }` |
| `POST /v1/integrations/rest` | `{ integration, method, path, query?, body? }` → `{ status, ok, contentType, body, untrusted }` |
| `POST /v1/integrations/mcp/call` | `{ integration, tool, arguments }` → `{ tool, isError, text, structured, untrusted }` |
| `POST /v1/integrations/mcp/tools` | `{ integration }` → `{ tools[] }` |

Integration errors return 400 (`POLICY_DENIED`, `INVALID_CONFIG`, `INVALID_PARAMS`) or 502
(remote problems: `TIMEOUT`, `UNREACHABLE`, `REMOTE_ERROR`, `TOO_LARGE`, `PROTOCOL`), with
`{ detail: { message, code } }`.

### Agent

- `hello.capabilities.ocr` is now `true`.
- New `agent-config.json` field `ca_file` (PEM to trust for an `https://` server), and
  `winagent pair --ca-file`.
