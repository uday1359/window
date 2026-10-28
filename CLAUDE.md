# CLAUDE.md — WinAgent

Windows 11 AI desktop-control agent. Read README.md, ARCHITECTURE.md and KNOWN_ISSUES.md first; requirements are in PRD.md and their status in REQUIREMENTS_TRACEABILITY.md.

## Layout
- `server/` NestJS 11 + Prisma 7 (MariaDB driver adapter, client generated into `server/src/generated`) + MySQL 8 (API, orchestrator, policy, approvals, agent hub)
- `ai-service/` FastAPI planner/router (Python 3.13)
- `agent/` local Windows agent (Python 3.13, Playwright/Edge, pywinauto)
- `web/` React 19 + Vite dashboard; `electron/` desktop shell; `e2e/` Playwright acceptance tests
- Python venv at `.venv` (shared by ai-service and agent)

## Commands (PowerShell, project root)
- Lint / typecheck: `npm run lint`, `npm run typecheck`; Python: `.venv\Scripts\python -m ruff check ai-service agent`
- Tests: `npm run test --workspace server`, `npm run test --workspace web`, `cd ai-service; ..\.venv\Scripts\python -m pytest`, `cd agent; ..\.venv\Scripts\python -m pytest`, `npm run test:e2e`
- Build: `npm run build`; migrations: `npm run db:migrate` (`prisma migrate deploy`)

## Rules for changes
- New agent capabilities must be added to BOTH `server/src/operations/operations.ts` (whitelist, risk, schema) and `agent/winagent/executor.py` (handler table). Sensitive ones also go in `AGENT_APPROVAL_REQUIRED`.
- Never let the server widen approved folders/apps; they belong to the agent's local config.
- Never retry uncertain external operations; never auto-resume tasks at startup.
- Never log or persist secrets; use the existing `redact` helpers and DPAPI stores.
- Do not run `prisma migrate reset`. Tests only TRUNCATE `winagent_test` / `winagent_e2e`.
- Real `.env` files are git-ignored; never print or commit them.
- Server-side operations (integrations) set `executor: 'server'` in `operations.ts`; they have no agent journal, so a timeout must stay UNCERTAIN, never be retried.
- Schema changes need a migration in `server/prisma/migrations`; copy the SQL from `npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script` (Windows lowercases table names, so other diffs are noisy).
- Installation-state folders (`backups`, `data`, `logs`, `storage`) exist only at the project root; never exclude those names elsewhere (`server/src/backups` is source code).
- Full validation: `powershell -ExecutionPolicy Bypass -File scripts\validate.ps1` (report in `logs\validation-*`).
- Keep docs in sync: update REQUIREMENTS_TRACEABILITY.md, KNOWN_ISSUES.md and CHANGELOG.md with behaviour changes.
