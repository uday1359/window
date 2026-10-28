# WinAgent database

This file is written from the source code: `server/prisma/schema.prisma`, the migration
`server/prisma/migrations/20261027123502_init/migration.sql`, and the server services that use
them. If this file and the code disagree, the code is correct.

- **Engine:** MySQL 8.0 through Prisma 7 (`provider = "mysql"`) and the official `@prisma/adapter-mariadb` driver adapter. The client is generated as CommonJS into `server/src/generated/prisma` (git-ignored); `npm run build`, `typecheck` and `test` regenerate it first. All timestamps are `DATETIME(3)` in UTC. Every primary key except `AuditEvent` and `SystemState` is a `CHAR(36)` UUID.
- **Connection:** `DATABASE_URL`. `createAdapter()` in `prisma.service.ts` adds `connectionLimit=10` and `allowPublicKeyRetrieval=true` (needed for MySQL 8 password auth without TLS; localhost only) when the URL does not set them. The Prisma CLI reads `DATABASE_URL` / `SHADOW_DATABASE_URL` through `server/prisma.config.ts`, which loads `server/.env` unless the variables are already set. `SHADOW_DATABASE_URL` is used only by `prisma migrate dev`.
- **Migrations:** four version-controlled migrations: `20261027123502_init` (all original tables), and from 2026-10-28 (NOT VALIDATED: their SQL matches Prisma's generated output, but they have not yet been applied with `migrate deploy`): `20261028120000_task_retry_planning`, `20261028130000_task_attachments`, `20261028140000_integrations`. See section 10.

## 1. Databases

| Database | Used by | How it is configured |
|---|---|---|
| `winagent` | The application (dev and production) | `DATABASE_URL` in `server/.env`, written by `scripts/setup-env.mjs` |
| `winagent_shadow` | `prisma migrate dev` (shadow database used to detect drift) | `SHADOW_DATABASE_URL` |
| `winagent_test` | Server integration tests (`npm run test --workspace server`) | `TEST_DATABASE_URL`. `server/test/env.ts` refuses to run unless the URL ends in `/winagent_test`. `global-setup.ts` runs `prisma migrate deploy`. `helpers.ts` `resetDatabase()` truncates every table except `_prisma_migrations` and refuses to run against any other database. |
| `winagent_e2e` | Playwright end-to-end test (`npm run test:e2e`) | `e2e/stack.ts` derives the URL from `DATABASE_URL` by replacing `/winagent` with `/winagent_e2e`. `e2e/global-setup.ts` runs `CREATE DATABASE IF NOT EXISTS`, `migrate deploy`, then truncates every table. |
| `winagent_restore_check` | Scratch database used by backup restore verification | `BackupsService` creates it and drops it again (`RESTORE_DB`) |

The README creates `winagent`, `winagent_shadow` and `winagent_test` by hand and grants the `winagent` user ``ALL ON `winagent%`.*``. The other two databases are created by the code.

## 2. Migration commands

| Command | Script | Effect |
|---|---|---|
| `npm run db:migrate` (root) | → `npm run prisma:migrate --workspace server` → `prisma migrate deploy` | Applies pending migrations without creating new ones. Use this for normal setup. |
| `npm run prisma:migrate:dev --workspace server` | `prisma migrate dev` | Creates or applies migrations during development (needs the shadow database) |
| `npm run prisma:generate --workspace server` | `prisma generate` | Regenerates the Prisma client |
| `npm run prisma:validate --workspace server` | `prisma validate` | Validates `schema.prisma` |
| (no seed command) | – | Roles, permissions and the `SystemState` row are seeded at server startup (`AuthService.seedRbac`). |

## 3. Enums

| Enum | Values |
|---|---|
| `TaskStatus` | `PENDING`, `PLANNING`, `NEEDS_CLARIFICATION`, `AWAITING_APPROVAL`, `QUEUED`, `RUNNING`, `PAUSED`, `INTERRUPTED`, `BLOCKED`, `SUCCEEDED`, `PARTIAL`, `FAILED`, `CANCELLED`, `REJECTED` |
| `PrivacyLevel` | `LOCAL_ONLY`, `CLOUD_REDACTED`, `CLOUD_ALLOWED` |
| `RiskLevel` | `LOW`, `MEDIUM`, `HIGH`, `CRITICAL` |
| `StepStatus` | `PENDING`, `AWAITING_APPROVAL`, `RUNNING`, `SUCCEEDED`, `FAILED`, `UNCERTAIN`, `SKIPPED`, `CANCELLED` |
| `ExecutionStatus` | `DISPATCHED`, `RUNNING`, `SUCCEEDED`, `FAILED`, `TIMED_OUT`, `CANCELLED`, `UNCERTAIN` |
| `EvidenceOutcome` | `PASS`, `FAIL`, `INCONCLUSIVE` |
| `ApprovalStatus` | `PENDING`, `APPROVED`, `REJECTED`, `EXPIRED`, `SUPERSEDED` (also used for `ApprovalDecision.decision`, which is only ever `APPROVED` or `REJECTED`) |
| `DeviceStatus` | `ACTIVE`, `REVOKED` |
| `PolicyKind` | `FOLDER`, `WEBSITE`, `APPLICATION`, `ACTION` |
| `PolicyEffect` | `ALLOW`, `DENY`, `REQUIRE_APPROVAL` |

Some columns hold enum-like values as plain strings, with no database enum. The values in this table are the ones the code writes:

| Column | Values |
|---|---|
| `AuditEvent.actorType` | `USER`, `AGENT`, `SYSTEM` |
| `AuditEvent.outcome` | `SUCCESS`, `FAILURE`, `DENIED`, `INFO` |
| `WorkflowSkill.validationStatus` | `VALID`, `INVALID`, `UNVALIDATED` |
| `ConfigBackup.kind` | `database`, `config` |
| `ModelConfig.provider` | `ollama`, `openai_compatible`, `anthropic` |
| `MemoryRecord.kind` | `preference`, `fact`, `recovery_strategy`, `task_summary` |
| `ApprovalDecision.channel` | `web`, `desktop` |

Task status transitions are allowed only as listed in `server/src/tasks/task-state.ts` (`TRANSITIONS`). `TERMINAL` is `SUCCEEDED`, `PARTIAL`, `CANCELLED` and `REJECTED`. `FAILED` is not terminal, because a failed task can be resumed.

## 4. Models

Foreign keys use `ON UPDATE CASCADE` throughout. The `onDelete` rule is given in each model's Relations row.

### Identity and access

**User**: a dashboard account.

| | |
|---|---|
| Key fields | `email` (unique, stored lower-case), `displayName`, `passwordHash` (scrypt), `isActive`, `failedLogins`, `lockedUntil` |
| Relations | Owns roles, sessions, tasks, preferences, policies, skills, memories, notifications, devices and pairing codes (all `Cascade` on user delete). `approvalDecisions` uses `Restrict`. |
| Unique / indexes | `email` unique |

**Role** / **Permission** / **RolePermission** / **UserRole**: RBAC. These tables are synced from `server/src/auth/rbac.ts` at every startup.

| Model | Key fields | Constraints |
|---|---|---|
| `Role` | `id` `VARCHAR(32)` (`ADMIN`, `OPERATOR`, `VIEWER`), `description` | PK `id` |
| `Permission` | `id` `VARCHAR(64)` (for example `task:create`), `description` | PK `id` |
| `RolePermission` | `roleId`, `permissionId` | PK (`roleId`, `permissionId`). Both FKs `Cascade`. |
| `UserRole` | `userId`, `roleId`, `createdAt` | PK (`userId`, `roleId`). Index `roleId`. FK user `Cascade`, FK role `Restrict`. |

**UserSession**: dashboard login sessions.

| | |
|---|---|
| Key fields | `tokenHash` `CHAR(64)` (sha256 of the cookie token), `userAgent`, `createdAt`, `lastSeenAt`, `expiresAt`, `revokedAt` |
| Relations | `user` (`Cascade`) |
| Unique / indexes | `tokenHash` unique. Indexes (`userId`, `revokedAt`) and (`expiresAt`). |

### Tasks

**Task**: one natural-language request and its life cycle.

| | |
|---|---|
| Key fields | `title`, `instruction` (TEXT), `status`, `statusReason`, `privacyLevel`, `riskLevel?`, `priority`, `queuePosition`, `deadline?`, `idempotencyKey?`, `plan` (JSON), `successCriteria` (JSON), `planSource` (`rules` or `model:<name>`; `skill` when the plan comes from a preset), `clarification`, `progress` (0–100), `version` (incremented on every state transition), `startedAt`, `finishedAt` (set on SUCCEEDED, PARTIAL, FAILED, CANCELLED, REJECTED; cleared when a FAILED task is resumed) |
| Relations | `user` (`Cascade`), `agentDevice?` (`SetNull`), `skill?` → `WorkflowSkill` (`SetNull`). Children: `steps`, `checkpoints`, `approvals`, `executions`, `evidence` (all `Cascade`). `dependsOn` / `dependents` through `TaskDependency`. |
| Unique / indexes | Unique (`userId`, `idempotencyKey`). Indexes (`userId`, `status`), (`status`, `queuePosition`) and (`createdAt`). |

**TaskStep**: one whitelisted operation in a plan.

| | |
|---|---|
| Key fields | `index`, `operation`, `description`, `params` (JSON), `riskLevel`, `requiresApproval`, `idempotent`, `status`, `attempts`, `maxAttempts` (default 2), `result` (JSON), `error`, `startedAt`, `finishedAt` |
| Relations | `task` (`Cascade`). Children: `approvals`, `executions` (`Cascade`). |
| Unique / indexes | Unique (`taskId`, `index`). Index `status`. |

**TaskDependency**: "task A depends on task B".

| | |
|---|---|
| Key fields | `taskId` (dependent), `dependsOnTaskId` (prerequisite) |
| Relations | Both FKs → `Task`, `Cascade` |
| Unique / indexes | PK (`taskId`, `dependsOnTaskId`). Index `dependsOnTaskId`. |

**TaskCheckpoint**: a verified state after each successful step. It is written in the same transaction that marks the step `SUCCEEDED`.

| | |
|---|---|
| Key fields | `stepIndex`, `state` (JSON: `operation`, `target` and an optional `sha256`), `verified` |
| Relations | `task` (`Cascade`) |
| Unique / indexes | Index (`taskId`, `stepIndex`) |

**TaskExecution**: one dispatch attempt of a step to an agent.

| | |
|---|---|
| Key fields | `operationId` (the idempotency id sent to the agent), `attempt`, `status`, `approvalHash?`, `output` (JSON), `error`, `dispatchedAt`, `finishedAt` |
| Relations | `task` (`Cascade`), `step` (`Cascade`), `agentDevice?` (`SetNull`) |
| Unique / indexes | `operationId` unique. Indexes `taskId` and (`stepId`, `attempt`). |

**VerificationEvidence**: the result of checking one success criterion.

| | |
|---|---|
| Key fields | `criterion`, `kind` (for example `file_content_equals`), `outcome`, `expected`, `actual` (redacted), `sha256?`, `storagePath?`, `source` (`agent` or `server`), `isSimulated` |
| Relations | `task` (`Cascade`) |
| Unique / indexes | Index `taskId` |

Nothing in `server/src` writes `storagePath`.

### Approvals

**ApprovalRequest**: a request for the user to approve one exact action.

| | |
|---|---|
| Key fields | `actionHash` `CHAR(64)`, `operation`, `target`, `summary`, `consequences`, `riskLevel`, `status`, `expiresAt` |
| Relations | `task` (`Cascade`), `step` (`Cascade`), `decision?` (1:1) |
| Unique / indexes | Indexes (`taskId`, `status`), (`status`, `expiresAt`) and (`stepId`, `actionHash`) |

**ApprovalDecision**: the user's decision on a request (at most one per request).

| | |
|---|---|
| Key fields | `decision`, `actionHash` (copied from the request), `comment`, `channel` |
| Relations | `request` (`Cascade`), `user` (`Restrict`) |
| Unique / indexes | `requestId` unique |

### Agents

**AgentDevice**: a paired Windows computer.

| | |
|---|---|
| Key fields | `name`, `hostname`, `osVersion`, `agentVersion`, `tokenHash` (sha256 of the device token), `status`, `capabilities` (JSON: `{ apps: [...], files, browser, … }`), `allowedRoots` (JSON array of root names reported by the agent), `lastResources` (JSON), `lastSeenAt`, `revokedAt` |
| Relations | `owner` → `User` (`Cascade`). Children: `sessions` (`Cascade`). `tasks` and `executions` are set to null when the device is deleted. |
| Unique / indexes | `tokenHash` unique. Index (`ownerId`, `status`). |

**AgentSession**: one WebSocket connection of a device.

| | |
|---|---|
| Key fields | `remoteAddr`, `connectedAt`, `endedAt`, `endReason` |
| Relations | `device` (`Cascade`) |
| Unique / indexes | Index (`deviceId`, `endedAt`) |

**PairingCode**: a one-time code for pairing a device. It expires after 10 minutes.

| | |
|---|---|
| Key fields | `codeHash` (sha256 of the code), `expiresAt`, `usedAt` |
| Relations | `user` (`Cascade`) |
| Unique / indexes | `codeHash` unique. Index `expiresAt`. |

### AI, policy, settings

**ModelConfig**: a planner model the AI service may route to. This table is global, not per user.

| | |
|---|---|
| Key fields | `name`, `provider`, `model`, `endpoint`, `isLocal`, `enabled`, `maxComplexity` (1–5), `latencyClass` (1–3), `costPer1kTokens` `DECIMAL(10,5)`, `capabilities` (JSON), `secretRef?` (the *name* of a DPAPI secret) |
| Relations | – |
| Unique / indexes | `name` unique |

**PermissionPolicy**: a user's allow, deny or require-approval rule.

| | |
|---|---|
| Key fields | `kind`, `value`, `effect`, `note`, `revokedAt` (soft delete) |
| Relations | `user` (`Cascade`) |
| Unique / indexes | Index (`userId`, `kind`, `revokedAt`) |

**UserPreference**: whitelisted key/value settings. The allowed keys are listed in `settings.controller.ts` `PREFERENCE_SCHEMAS`.

| | |
|---|---|
| Key fields | `key` `VARCHAR(64)`, `value` (JSON) |
| Relations | `user` (`Cascade`) |
| Unique / indexes | PK (`userId`, `key`) |

**SystemState**: a singleton row with `id = 1`, created by `seedRbac`.

| | |
|---|---|
| Key fields | `emergencyStop`, `emergencyStopAt`, `emergencyStopBy` (user id, no FK), `queueEnabled` |
| Relations | – |
| Unique / indexes | PK `id` (default 1). The bootstrap code also uses this row as a lock (`SELECT … FOR UPDATE`). |

### Memory and skills

**WorkflowSkill**: a reusable plan saved from a verified successful task.

| | |
|---|---|
| Key fields | `name`, `description`, `plan` (JSON), `successCriteria` (JSON), `enabled`, `validationStatus`, `validationError`, `lastValidatedAt`, `useCount`, `sourceTaskId` (no FK) |
| Relations | `user` (`Cascade`). `tasks` reference the skill (`Task.skillId`, `SetNull`). |
| Unique / indexes | Unique (`userId`, `name`) |

**MemoryRecord**: user-managed memory. Content that looks like a secret is rejected.

| | |
|---|---|
| Key fields | `kind`, `content` (TEXT), `source` |
| Relations | `user` (`Cascade`) |
| Unique / indexes | Index (`userId`, `kind`) |

**Notification**: an in-app notification.

| | |
|---|---|
| Key fields | `kind`, `title`, `body`, `link`, `readAt` |
| Relations | `user` (`Cascade`) |
| Unique / indexes | Index (`userId`, `readAt`) |

### Audit and backups

**AuditEvent**: an append-only audit log.

| | |
|---|---|
| Key fields | `id` `BIGINT AUTO_INCREMENT`, `actorType`, `actorId`, `action`, `targetType`, `targetId`, `taskId`, `outcome`, `details` (JSON, always passed through `redact()`), `createdAt` |
| Relations | None. This is deliberate: there are no FKs, so audit rows outlive the tasks, users and devices they mention. |
| Unique / indexes | Indexes `taskId`, (`actorId`, `createdAt`), (`action`, `createdAt`) and `createdAt` |

**ConfigBackup**: metadata for each backup file.

| | |
|---|---|
| Key fields | `kind`, `filePath`, `sizeBytes` (BIGINT), `sha256`, `createdById` (no FK), `restoreTestedAt`, `restoreTestResult` |
| Relations | – |
| Unique / indexes | Index (`kind`, `createdAt`) |

## 5. Transactions (`$transaction` in `server/src`)

| Location | What runs atomically |
|---|---|
| `auth/auth.service.ts` `seedRbac` | Upserts permissions, roles and role-permissions, deletes stale role-permissions, and ensures the `SystemState` row exists |
| `auth.service.ts` `bootstrapAdmin` | `SELECT … FOR UPDATE` on `SystemState`, checks that the user count is 0, creates the admin, writes the audit event |
| `auth.service.ts` `createUser` | Creates the user and role, writes the audit event |
| `auth.service.ts` `login` (batch) | Resets the failed-login counter and creates the session |
| `auth.service.ts` `changePassword` | Updates the hash, revokes the other sessions, writes the audit event |
| `agents/agents.controller.ts` `pair` | Consumes the code (conditional `updateMany` on `usedAt IS NULL AND not expired`), creates the device, writes the audit event |
| `approvals/approvals.service.ts` `request` | Supersedes approvals whose hash differs, de-duplicates, creates the request, marks the step `AWAITING_APPROVAL`, writes the audit event |
| `approvals.service.ts` `decide` | Conditional `PENDING` → decided update (the race guard), creates the decision, writes the audit event, updates the step and the task state |
| `settings/settings.controller.ts` `setPreferences` (batch) | Upserts every submitted preference |
| `system/system.controller.ts` `emergencyStop` | Sets the stop flag, pauses every active task, marks `RUNNING` steps `UNCERTAIN`, writes the audit event |
| `tasks/task-state.service.ts` `transition` | Conditional status update (`WHERE status IN allowed sources`), increments `version`, writes the audit event. Runs inside the caller's transaction when one is passed in. |
| `tasks/tasks.service.ts` `create` | Creates the task and its dependencies, writes the audit event |
| `tasks.service.ts` `plan` | Replaces the steps, stores the plan and risk, then transitions to `QUEUED` or `REJECTED` |
| `tasks.service.ts` `cancel` | Transitions to `CANCELLED`, cancels pending steps, supersedes pending approvals |
| `orchestrator/orchestrator.service.ts` dispatch (batch) | Marks the step `RUNNING` and creates the `TaskExecution` row |
| `orchestrator.service.ts` on success | Marks the step `SUCCEEDED`, creates the `TaskCheckpoint`, writes the audit event |
| `orchestrator.service.ts` `verify` | Creates the `VerificationEvidence` rows, writes the audit event, transitions to the final status |

`AuditService.record(input, tx)` writes inside the given transaction. Without a transaction, a failed audit write is logged and does not fail the caller.

## 6. Idempotency and concurrency

| Mechanism | Where | Behaviour |
|---|---|---|
| `Idempotency-Key` header → `Task.idempotencyKey` | `tasks.service.ts` `create`, unique (`userId`, `idempotencyKey`) | A repeated key returns the existing task (`duplicate: true`, HTTP 200). A concurrent duplicate hits P2002, which the code catches before returning the existing task. |
| `TaskExecution.operationId` (unique UUID per attempt) | orchestrator → agent `op` message | The agent's journal (`agent/winagent/journal.py`, `journal.jsonl`) never runs the same `operationId` twice. After a timeout or a restart, the server asks the agent with `op_status` instead of repeating the operation. |
| `TaskStep.idempotent` | Set in `tasks.service.ts` `plan` | `true` only when the operation is marked `idempotent` **and** not `external` in `operations/operations.ts`. `file.move`, `file.delete`, `browser.click`, `browser.submit`, `desktop.launch_app` and `desktop.type_text` are not idempotent. If a non-idempotent step has an unknown outcome, resuming the task needs `confirmUncertain: true`. Automatic retries (up to `maxAttempts`) happen only for idempotent, non-external operations. |
| `Task.version` + conditional `updateMany` | `task-state.service.ts` | Status changes match only rows that are still in an allowed source status, so a lost race returns `false` (or 409 for a user action). |
| Approval binding | `ApprovalRequest.actionHash` / `ApprovalDecision.actionHash`, `TaskExecution.approvalHash` | An approval is usable only for the same hash, while it has not expired, and while no finished execution has consumed it (`findUsableApproval`). |
| Restart recovery | `orchestrator.service.ts` `recoverAfterRestart` | Tasks that were `PLANNING`, `QUEUED` or `RUNNING` become `INTERRUPTED`. Their `RUNNING` steps and their `DISPATCHED`/`RUNNING` executions become `UNCERTAIN`. None of them resume automatically. |
| One-time pairing code | `agents.controller.ts` | Conditional `updateMany(usedAt: null, not expired)` inside the transaction |

## 7. Secret storage

| Secret | Stored as |
|---|---|
| User passwords | `scrypt$32768$8$1$<salt b64>$<key b64>` (N=32768, r=8, p=1, 64-byte key, 16-byte random salt). Verified with `timingSafeEqual` (`common/crypto.ts`). |
| Session tokens | `sha256` hex only (`UserSession.tokenHash`). The raw token exists only in the cookie. |
| Agent device tokens | `sha256` hex only (`AgentDevice.tokenHash`). The raw token is returned once at pairing and stored by the agent with DPAPI (`agent/winagent/token_store.py`). |
| Pairing codes | `sha256` hex only (`PairingCode.codeHash`) |
| Cloud model API keys | **Not in MySQL.** `ModelConfig.secretRef` holds only the secret's *name*. The value lives in the AI service's DPAPI-encrypted file (`SECRET_STORE_PATH`). |
| Free text (instructions, clarifications, memory, skills) | Rejected when `containsSecret()` matches. Audit `details`, dashboard events and agent error strings are passed through `redact()`/`redactString()`. |

## 8. Retention (`server/src/system/retention.service.ts`)

`RetentionService.purge()` runs **every 24 h** on a `setInterval`. It is disabled when `WINAGENT_DISABLE_ORCHESTRATOR=1`, and it does **not** run at startup, so the first purge happens 24 h after boot.

| Data | Rule |
|---|---|
| Tasks | For each user, deletes tasks with `finishedAt < now − historyRetentionDays` (preference, default 365) and status `SUCCEEDED`, `PARTIAL`, `FAILED`, `CANCELLED` or `REJECTED`. Steps, executions, checkpoints, evidence, approvals, decisions and dependencies are deleted with them through FK cascades. |
| Notifications | Notifications older than 90 days (`createdAt`) are deleted for every user |
| Audit event | Writes `retention.purge` when anything was deleted |
| Not purged by any code | `AuditEvent`, `UserSession`, `AgentSession`, `PairingCode`, `ConfigBackup` rows and backup files, revoked `PermissionPolicy` rows |

## 9. Backup and restore (`server/src/backups/backups.service.ts`)

These operations are exposed under `api/backups` and need `system:admin` (see [API.md](API.md) §4.9).

- **Database backup:** runs `mysqldump.exe` from `MYSQL_BIN_DIR` with `--single-transaction --no-tablespaces --routines --default-character-set=utf8mb4 --result-file=BACKUP_DIR/winagent-db-<timestamp>.sql`. The password is passed in the `MYSQL_PWD` environment variable, never on the command line. The code then records size and sha256 in `ConfigBackup` (`kind: database`).
- **Config backup:** writes `winagent-config-<timestamp>.json` with every `ModelConfig`, the active `PermissionPolicy` rows and every `UserPreference`. Secrets are not included. Recorded as `kind: config`.
- **Restore verification:** checks the file's sha256 → `DROP`/`CREATE DATABASE winagent_restore_check` → pipes the dump into `mysql` → compares against the live database (same table list, same `_prisma_migrations` row count, no table with more rows than live, at least one `user` row) → drops the scratch database. The result is stored in `restoreTestedAt` and `restoreTestResult`.
- The code has **no endpoint that restores a backup into the live database**. A real restore has to be done by hand with the `mysql` client. This file does not prescribe a procedure, because none is implemented.
- The restore check needs the `winagent` MySQL user to be allowed to create and drop `winagent_restore_check`. The README's ``GRANT … ON `winagent%`.*`` covers that name.

## 10. Additions on 2026-10-28 (NOT VALIDATED)

| Change | Migration | Purpose |
|---|---|---|
| `Task.retryPlanningAt DATETIME(3) NULL` + index `(status, retryPlanningAt)` | `20261028120000_task_retry_planning` | Set while a BLOCKED task waits for a model or the AI service (FR-14); cleared when planning starts. `TasksService.retryWaitingPlans` re-plans due tasks every 15 s. |
| `TaskAttachment` (`id`, `taskId` → `Task` ON DELETE CASCADE, `mediaType`, `sizeBytes`, `sha256`, `storagePath` relative to `STORAGE_DIR`, `createdAt`; index `taskId`) | `20261028130000_task_attachments` | Screenshot attachments (FR-01). Images live on disk; retention deletes the files before deleting the tasks. |
| `Integration` (`name` unique, `kind` ENUM `REST`/`MCP`, `description`, `baseUrl`, `allowedPaths` JSON, `allowedTools` JSON, `authHeader`, `authScheme`, `secretRef` (a name, never the secret), `enabled`, `createdById`, timestamps) | `20261028140000_integrations` | Administrator allow list of external integrations (FR-17). |

Other changes without schema impact:

- `Task.finishedAt` is now set for FAILED too (cleared when a failed task is resumed), so retention purges failed tasks.
- `TaskExecution.agentDeviceId` is null for integration steps (they run on the server).
- `VerificationEvidence.kind` may now be `screen_contains_text`.
- Prisma 7 requires a driver adapter: `createAdapter()` in `server/src/prisma/prisma.service.ts` (MariaDB driver; `connectionLimit=10`, `allowPublicKeyRetrieval=true` for MySQL 8 on localhost). Test helpers that rely on `SET FOREIGN_KEY_CHECKS` use a pool of 1 connection, because that setting is per connection.

## 11. Offline store (2026-10-28)

| Change | Migration | Purpose |
|---|---|---|
| `AuditEvent.offlineId CHAR(36) NULL`, unique | `20261028150000_audit_offline_id` | Makes replaying a queued audit event idempotent. |

Queued writes live in `OFFLINE_QUEUE_FILE` (default `data/offline-queue.jsonl`, relative to the project folder) until MySQL is reachable. See docs/ARCHITECTURE.md, "Offline store".
