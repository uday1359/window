# Changelog

## 1.0.0 — 2026-10-28 (unreleased, not yet committed)

First implementation of the PRD.

### Added
- **Server** (NestJS 11, Prisma 7, MySQL 8): authentication with first-admin bootstrap, sessions, CSRF header, rate limiting, RBAC; tasks with queue, dependencies, idempotency keys, pause/resume/cancel/reorder, clarification; policy engine; hash-bound approvals; sequential orchestrator with checkpoints, bounded retries and journal reconciliation; evidence-based verifier; agent pairing and WebSocket hub; dashboard events; audit log; memory, preferences and validated workflow skills; notifications; MySQL and configuration backups with restore verification; retention; diagnostics; emergency stop. One migration (`init`).
- **AI service** (FastAPI): rule planner, LLM planner (Ollama, OpenAI-compatible, Anthropic) with fallback, model router, redaction, DPAPI secret store.
- **Agent** (Python): file, browser (Playwright + Edge), desktop (UI Automation) and resource operations; path sandbox; backups; human-verification and prompt-injection detection; journal idempotency; local emergency stop; DPAPI device token.
- **Dashboard** (React 19): 13 pages plus login; live updates; voice input/output; emergency-stop button.
- **Desktop shell** (Electron 45): hardened window loading the dashboard, tray menu with emergency stop (runtime not validated).
- **Tests**: server unit + integration, web component, AI service, agent, and real end-to-end acceptance test.
- **Docs**: README, ARCHITECTURE, API, DATABASE, SECURITY, TESTING, DEPLOYMENT, TROUBLESHOOTING, DECISIONS, KNOWN_ISSUES, REQUIREMENTS_TRACEABILITY, IMPLEMENTATION_PLAN; architecture PDFs.

### Fixed during development
- Agent could receive work before its `hello` (handlers now registered before awaiting; device is "ready" only after hello).
- `TaskStep.idempotent` was never set, which disabled safe retries.
- Restore verification failed on Windows because MySQL reports table names in lowercase.
- Orphaned Jest worker processes after integration runs.

### Fixed in the final audit
- Agent disconnect bookkeeping could raise an unhandled promise rejection (crashing Node) if the database was unavailable; a replaced agent connection was reported as "disconnected".
- Agent heartbeats without resource data (`resources: null`) were rejected, so `lastSeenAt` went stale.
- FAILED tasks never got `finishedAt`, so retention never purged them.
- A disabled workflow skill could still be run.
- Long instructions plus clarifications exceeded the AI service's input limit; clarification history now keeps the newest text.
- AI-service errors (e.g. unknown secret) surfaced as generic 500s; now 404/400/502/503.
- Route preview ignored the user's cloud cost limit.
- Removed seed scripts that pointed at a non-existent file; removed dead code.

### Security
- Upgraded NestJS 11.1.6 → 11.2.8, ws 8.18.3 → 8.22.0, react-router-dom 7.9.1 → 7.18.5, @nestjs/cli 11.0.10 → 11.0.24 to resolve high-severity advisories.
- Major upgrades: Prisma 6.16 → 7.10.1 (new `prisma-client` generator, `prisma.config.ts`, `@prisma/adapter-mariadb` driver adapter), zod 3 → 4.6.7, vitest 3 → 4.1.12, Electron 37 → 45.1.0; vite 6.4.5; `multer` pinned to 2.5.0 via npm `overrides`. Production dependencies now report 0 vulnerabilities.

## 1.0.0 additions — 2026-10-28 (implemented, NOT VALIDATED)

### Added
- **Install / start / stop / update / rollback scripts** (`scripts\*.ps1`): `update.ps1` snapshots code, `.env` files and a full database dump, and rolls back automatically on failure. Also `validate.ps1` (all checks and one report) and `test-lifecycle.ps1`.
- **Optional TLS** (`TLS_PFX_FILE`/`TLS_CERT_FILE`, `PUBLIC_ORIGIN`, `scripts\new-tls-cert.ps1`); the agent can trust a self-signed certificate (`ca_file`, `pair --ca-file`). The server now refuses non-loopback listening without TLS.
- **Deadline enforcement:** past-deadline queued tasks are BLOCKED with a notification; Resume is an audited override.
- **Offline planning retries:** tasks wait (BLOCKED, `Task.retryPlanningAt`) while no model is reachable and are re-planned every 60 s.
- **Windows OCR:** `desktop.ocr` operation and `screen_contains_text` success criterion.
- **Internet research with citations:** `browser.research` operation, trust-ranked sources, rule-based verified/single-source claims, research findings in the task page.
- **Screenshot attachments** on tasks (stored in `STORAGE_DIR`, vision-model planning, privacy-aware).
- **REST and MCP (HTTP) integrations** with an admin allow list, policy enforcement and mandatory approval for data-changing calls.
- Migrations `20261028120000_task_retry_planning`, `20261028130000_task_attachments`, `20261028140000_integrations`.

### Changed
- `browser.download` refuses redirects to a different private/local host.
- AI-service model calls are refactored (`_complete`, `call_json_model`) and support images for all three providers.
- Model routing inputs (enabled models and the user's cost limit) come from one helper (`ai/routing-inputs.ts`).

### Fixed
- `.gitignore` and the update scripts' exclusion list matched `server/src/backups` (source code) because `backups/` was not anchored to the project root.
