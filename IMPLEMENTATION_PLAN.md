# Implementation Plan

Follows the PRD delivery roadmap (§5, §15). Each task went through implement → test → review → fix → validate. Status reflects the code as of 2026-10-28.

## Phase 1 — Web application and server
| Task | Status |
|---|---|
| Repository layout, npm workspaces, env generation (`scripts/setup-env.mjs`) | DONE |
| Prisma schema for all PRD §8 entities, `init` migration, three databases | DONE |
| Auth, sessions, CSRF, rate limiting, RBAC, first-admin bootstrap | DONE |
| Tasks API, task state machine, queue, dependencies, idempotency | DONE |
| Dashboard: 13 pages + login, live WebSocket updates | DONE |

## Phase 2 — Local Windows agent
| Task | Status |
|---|---|
| Pairing, DPAPI token, outbound WebSocket, hello/heartbeat | DONE |
| File operations with path sandbox and backups | DONE |
| Journal idempotency, single-operation lock, emergency stop file | DONE |
| Browser (Playwright/Edge) and desktop (UI Automation) operations | DONE (no OCR/vision) |

## Phase 3 — AI and automation
| Task | Status |
|---|---|
| Rule planner, LLM planner, operation whitelist and plan validation | DONE |
| Model routing, privacy levels, redaction, secret store | DONE |
| Policy engine and hash-bound approvals | DONE |
| Orchestrator, retries, checkpoints, restart recovery, verifier | DONE |
| Memory, workflow skills, notifications, audit, backups, retention, diagnostics | DONE |

## Phase 4 — Desktop application
| Task | Status |
|---|---|
| Electron shell reusing the dashboard, tray emergency stop (Electron 45) | PARTIAL — compiles; runtime NOT VALIDATED |

## Phase 5 — Production readiness
| Task | Status |
|---|---|
| End-to-end acceptance test with the real agent | DONE |
| Documentation set | DONE |
| Final audit and validation report | DONE for the validated scope; re-validation of the additions pending |

## 2026-10-28 continuation (all implemented; NOT VALIDATED until `scripts\validate.ps1` runs)
| Phase | Task | Status |
|---|---|---|
| A | Security upgrades: zod 4, Prisma 7 (driver adapter), vitest 4, Electron 45, multer override | DONE (validated for server/web/e2e before Phases C-D) |
| B | Install, start/stop, update with automatic rollback, rollback scripts | DONE (install.ps1 sandbox-tested; lifecycle NOT VALIDATED) |
| C | Optional TLS for remote agents | DONE (NOT VALIDATED) |
| D | Deadlines, offline planning retries, Windows OCR, research with citations, screenshot attachments, REST/MCP integrations | DONE (NOT VALIDATED) |
| E | `scripts\validate.ps1`, `scripts\test-lifecycle.ps1`, documentation | DONE |
| Remaining | Mouse automation, MSI installer, Electron runtime, live cloud/vision/MCP validation | NOT DONE / NOT VALIDATED |
