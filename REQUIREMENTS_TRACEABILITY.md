# Requirements Traceability

Status values: **DONE**, **PARTIAL**, **NOT DONE**, **N/A**. Source: [PRD.md](PRD.md). Evidence points to code or tests.

**NOT VALIDATED** marks work implemented on 2026-10-28 that has passed static checks (typecheck, lint, schema validation) but whose tests have not yet been run. Run `scripts\validate.ps1` on the target system; until then those items are implemented, not proven. Everything else was validated by the 164-test run recorded in TESTING.md.

## Functional requirements

| ID | Requirement | Status | Evidence / gap |
|---|---|---|---|
| FR-01 | Task input and planning | DONE (screenshots NOT VALIDATED) | Text and voice input; structured plans with risks, dependencies and success criteria; clarification flow. Screenshot attachments: up to 3 PNG/JPEG per task, signature-checked, stored in `STORAGE_DIR` (`tasks/attachments.service.ts`), planned by vision-capable models only. |
| FR-02 | Hybrid AI routing | DONE | Ollama, OpenAI-compatible and Anthropic providers; routing by complexity, privacy, capability, cost, resources and connectivity; redaction; LOCAL_ONLY blocks cloud. Real Ollama `qwen2.5:3b` planning verified. Cloud providers NOT VALIDATED against live accounts. |
| FR-03 | Task management | DONE (deadlines NOT VALIDATED) | Sequential queue, pause/resume/cancel/reorder, dependencies, retries, checkpoints, resume inspects state first. Deadlines: a queued task past its deadline is BLOCKED with a notification; resuming it is an explicit, audited override. |
| FR-04 | Desktop automation | PARTIAL (OCR NOT VALIDATED) | UI Automation (list windows, launch allow-listed apps, read text, type, screenshot); crash and unexpected-dialog detection. OCR fallback with the built-in Windows engine (`desktop.ocr`, `screen_contains_text` criterion). **Gap:** no mouse automation or image-based clicking. |
| FR-05 | Browser automation | DONE | Playwright + Edge: open, search, extract, fill, click, submit, download; CAPTCHA/OTP/MFA detection; prompt-injection detection; executable downloads blocked; approval for submit/click; fresh isolated browser context. |
| FR-06 | File management | DONE | Approved roots only; backups before overwrite/move/delete; executable and reserved names refused; SHA-256 verification; acceptance test `e2e/hello.e2e.ts`. |
| FR-07 | Risk and approval | DONE | Risk scoring; hash-bound approvals showing operation, target, parameters and reasons; decisions recorded and audited. |
| FR-08 | Security and credentials | DONE (TLS NOT VALIDATED) | Least privilege; folder, website, application, action and integration policies; DPAPI secret storage; redaction; device revocation; optional TLS for remote access (FR-20). |
| FR-09 | Failure recovery | DONE | Timeouts, error codes, bounded retries for idempotent steps only, journal reconciliation, checkpoints, INTERRUPTED on restart; integration timeouts become UNCERTAIN, never retried. |
| FR-10 | Verification | DONE | Evidence-based verifier; SUCCEEDED / PARTIAL / FAILED / BLOCKED distinguished; no success without evidence. |
| FR-11 | Memory and workflows | DONE | Memory CRUD, delete-all, JSON export, validated skills (disabled skills cannot run), secret redaction. |
| FR-12 | Dashboard and monitoring | DONE | 13 pages; live monitor, approvals, history, evidence, agent and AI status, resources; pause/resume/cancel/emergency stop. |
| FR-13 | Voice interaction | PARTIAL | Browser Speech API for input and spoken progress; voice never approves anything. **Gap:** depends on browser support. NOT VALIDATED with a real microphone. |
| FR-14 | Offline operation | DONE (NOT VALIDATED) | Rule planner and local models work offline. If no model is reachable, the task waits (BLOCKED with `retryPlanningAt`) and planning is retried automatically every 60 s, never during emergency stop. |
| FR-15 | Resource management | PARTIAL | CPU, RAM, disk, battery, NVIDIA GPU; routing avoids large local models under pressure. **Gap:** CPU temperature unavailable on Windows; concurrency fixed at one task. |
| FR-16 | Audit logging | DONE | Redacted audit trail, including integration changes, research synthesis and deadline overrides. |
| FR-17 | External integrations | DONE (NOT VALIDATED) | Administrator allow list of REST APIs and MCP servers (HTTP) with allowed paths/tools; policy-enforced; POST and MCP tool calls always need approval; credentials stay in the DPAPI store; calls made by the AI service with no redirects, a size cap and a timeout. Stdio MCP is deliberately unsupported. |
| FR-18 | Internet research | DONE (NOT VALIDATED) | `browser.research`: trust-ranked, one-per-domain public sources (official > reference > general); website DENY rules applied; CAPTCHA pages skipped, never bypassed. Claims are cited and marked verified (2+ independent domains or an official source) or single-source (uncertain) by fixed rules, not by the model. |
| FR-19 | Updates and diagnostics | DONE (update/rollback NOT VALIDATED) | Diagnostics; MySQL backups with restore verification; `scripts\update.ps1` snapshots code, configuration and database and rolls back automatically on failure; `scripts\rollback.ps1`. |
| FR-20 | Remote access | DONE (TLS NOT VALIDATED) | Pairing, device tokens, session expiry, revocation, audit, emergency stop. Optional HTTPS/WSS (`scripts\new-tls-cert.ps1`); the server refuses non-local listening without TLS; the agent refuses http:// to remote servers and can trust a self-signed certificate. |
| FR-21 | Startup and sessions | PARTIAL | Manual start (`scripts\start.ps1`); pending tasks never run at startup; agent refuses elevation. Electron open-at-login NOT VALIDATED. |

## Acceptance criteria (PRD §13)

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Submit and track tasks in the web app | DONE | Web tests, e2e |
| 2 | Task records in MySQL | DONE | Server integration tests |
| 3 | Prisma validation and migrations | DONE (new migrations NOT VALIDATED) | 4 version-controlled migrations; the 3 added on 2026-10-28 were checked against Prisma's generated SQL |
| 4 | Dashboard shows status and progress | DONE | e2e drives the dashboard |
| 5 | Agent executes a low-risk task | DONE | e2e with the real agent |
| 6 | File-creation task passes content verification | DONE | `e2e/hello.e2e.ts` (exactly 23 bytes) |
| 7 | Browser automation for supported workflows | DONE | `agent/tests/test_browser_desktop.py` (real headless Edge) |
| 8 | Local/cloud routing respects privacy | DONE | Router, redaction, image-privacy and research tests |
| 9 | Sensitive operations need explicit approval | DONE | Policy, integration and executor tests |
| 10 | Checkpoints support safe recovery | DONE | Restart recovery + resume inspection tests |
| 11 | Duplicate external actions prevented | DONE | Agent journal tests; integration timeouts become UNCERTAIN |
| 12 | Outputs in dedicated local folders | DONE | Approved roots; evidence, backups and attachment folders |
| 13 | Audit and evidence without secrets | DONE | Redaction tests |
| 14 | Emergency stop prevents further actions | DONE | Integration and agent tests; planning retries pause too |
| 15 | Identity checks pause for the user | DONE | `HUMAN_VERIFICATION_REQUIRED` → BLOCKED; research skips such pages |
| 16 | Transactions and authorization keep state consistent | DONE | Auth and task integration tests |
| 17 | Memory review and deletion | DONE | Memory endpoints and tests |
| 18 | Database backup and restoration tested | DONE | `mysqldump` + automated restore verification, integration-tested |
| 19 | Installation, updates and rollback tested | DONE (NOT VALIDATED) | `scripts\install.ps1` passed in an isolated sandbox here; `scripts\test-lifecycle.ps1` (update, rollback, automatic rollback) to be run on the target system |
| 20 | Electron reuses the web interface | PARTIAL | Loads the same dashboard and compiles on Electron 45; runtime NOT VALIDATED |
| 21 | Security, recovery and e2e tests pass | Pending re-run | 164 tests passed before the 2026-10-28 additions; the extended suite must be re-run (`scripts\validate.ps1`) |
| 22 | No unresolved critical security issues | DONE | No known critical or high issues; `npm audit`: 0 production vulnerabilities (8 low, dev-only) |
