# Architecture

Diagrams: `WinAgent_System_Architecture.pdf` and `WinAgent_Agent_Architecture.pdf` in the project root.

## Overview

```
 User ──► Web dashboard (React) ─┐
      └─► Electron shell ────────┤  HTTP /api + WS /ws (session cookie, CSRF header)
                                 ▼
                     API server (NestJS, 127.0.0.1:3710) ◄──► MySQL 8 (Prisma)
                        │                     ▲
     X-Service-Token    ▼                     │ outbound WS, device bearer token
          AI service (FastAPI, 127.0.0.1:8710)│
             ├─► Ollama (local)               │
             └─► cloud LLM (redacted)    Windows agent (Python, normal user)
                                              └─► files · Edge/Playwright · UI Automation
```

| Component | Folder | Responsibility |
|---|---|---|
| Dashboard | `web/` | 13 pages + login; live updates over `/ws`; emergency-stop button; voice input/output via the browser Speech API |
| Desktop shell | `electron/` | Loads the same dashboard; sandboxed renderer; tray emergency stop writes the agent's local stop file; optional open-at-login |
| API server | `server/` | Auth/RBAC, tasks, planning requests, policy, approvals, sequential orchestrator, verifier, agent hub, audit, memory/skills, notifications, backups, retention, diagnostics |
| AI service | `ai-service/` | Rule planner → model routing (privacy, complexity, cost, resources, connectivity) → Ollama / OpenAI-compatible / Anthropic, with fallback; redaction; DPAPI secret store |
| Agent | `agent/` | Executes whitelisted operations in locally approved folders/apps; journal idempotency; local approval check; emergency stop |

## Task lifecycle

1. **Request** — `POST /api/tasks` creates a `Task` (idempotency key supported).
2. **Plan** — server calls the AI service with the instruction, the device's roots/apps, the operation catalogue and the models. The rule planner handles common requests without any model; otherwise a model is chosen. The plan is validated against the whitelisted catalogue (`server/src/operations/operations.ts`). A clarification-only plan moves the task to `NEEDS_CLARIFICATION`.
3. **Policy** — `evaluateStep` (`server/src/policy/policy.ts`) assigns risk and applies FOLDER / WEBSITE / APPLICATION / ACTION rules (DENY > REQUIRE_APPROVAL > ALLOW). It runs at planning time and again right before dispatch.
4. **Approval** — approvals are bound to a SHA-256 hash of the exact action. The agent separately refuses `file.delete`, `browser.submit`, `browser.click` and `desktop.type_text` without an approval hash.
5. **Orchestration** — one task at a time, by queue position, honouring dependencies. Only idempotent, non-external steps are retried (up to `maxAttempts`). After a timeout, the server asks the agent's journal (`op_status`) before deciding anything; uncertain operations are never repeated blindly. Each verified step writes a `TaskCheckpoint` in the same transaction.
6. **Verification** — success criteria (`file_exists`, `file_content_equals`, `file_contains`, `step_succeeded`, `page_contains_text`, `window_exists`) are re-checked with fresh read-only probes. Outcome: `SUCCEEDED`, `PARTIAL` or `FAILED`, with evidence rows and an audit event.
7. **Restart** — planning/queued/running tasks become `INTERRUPTED`. Resume re-inspects checkpoints on disk through the agent first and redoes steps whose files changed.

Task states: `PENDING, PLANNING, NEEDS_CLARIFICATION, AWAITING_APPROVAL, QUEUED, RUNNING, PAUSED, INTERRUPTED, BLOCKED, SUCCEEDED, PARTIAL, FAILED, CANCELLED, REJECTED`. Allowed transitions live in `server/src/tasks/task-state.ts`.

## Agent internals

`__main__` (pair / run / status / estop) → `AgentClient` (connection, hello, 15 s heartbeat, stop-file watcher, back-off reconnect up to 30 s) → `Executor` (journal dedupe → emergency stop → approval hash → params → single lock → handler → journal) → `FileOps` / `BrowserOps` / `DesktopOps` / `ops_system`. Local state lives in `%LOCALAPPDATA%\WinAgent\` (config, DPAPI token, journal, evidence, backups, `EMERGENCY_STOP`).

## Additions on 2026-10-28 (NOT VALIDATED)

| Capability | Where | Flow |
|---|---|---|
| Screenshot attachments (FR-01) | `server/src/tasks/attachments.service.ts`, `ai-service/app/planner.py` | `POST /api/tasks` → signature check → `STORAGE_DIR\attachments\<task>` + `TaskAttachment` rows → at planning, images go to a `vision` model (local-only under CLOUD_REDACTED) |
| Deadlines (FR-03) | `orchestrator.service.ts` `nextRunnable` | Past-deadline QUEUED task → BLOCKED + notification; Resume clears the deadline (audited) |
| OCR (FR-04) | `agent/winagent/ocr.py`, `verifier.ts` | `desktop.ocr` = screenshot (screen or window) → Windows OCR via a constant PowerShell script; `screen_contains_text` criterion re-reads the screen |
| Offline planning (FR-14) | `tasks.service.ts` `retryWaitingPlans` | AI service reports `retryable` → task BLOCKED with `retryPlanningAt` → re-planned every 60 s (not during emergency stop) |
| Integrations (FR-17) | `server/src/integrations/*`, `ai-service/app/integrations.py` | Plan step `integration.*` → policy (registered, enabled, allowed path/tool) → approval for POST/MCP → **server** executes (no agent) → AI service calls the REST/MCP endpoint with the DPAPI credential |
| Research (FR-18) | `agent/winagent/research.py`, `ops_browser.py`, `ai-service/app/research.py` | `browser.research` on the agent (server adds WEBSITE DENY as `blockedDomains`) → sources → server calls `/v1/research/synthesize` → claims marked verified / single-source by rules → shown in task detail |
| Install / update / rollback (FR-19) | `scripts/*.ps1` | `update.ps1`: stop → snapshot (code, `.env`, mysqldump) → mirror new source → `npm ci`, pip, migrate, build, start, health → on failure `rollback.ps1` |
| TLS (FR-20) | `config.ts` `tlsOptions`, `main.ts`, agent `config.py` | HTTPS/WSS when `TLS_*` set; non-loopback `HOST` refused without TLS; agent trusts `ca_file` |

Operations now carry an `executor` (`agent` by default, `server` for integrations). The
orchestrator dispatches agent operations over the agent WebSocket and runs server operations
itself. Server operations have no journal, so a timeout becomes UNCERTAIN and is never retried.

## Key design choices

See [DECISIONS.md](DECISIONS.md). Data model: [DATABASE.md](DATABASE.md). API: [API.md](API.md). Security: [SECURITY.md](SECURITY.md).
