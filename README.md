# WinAgent — Windows 11 AI Desktop-Control Agent (V1.0)

WinAgent lets you describe computer tasks in plain language from a web dashboard. A
planner turns the request into a structured, whitelisted plan with measurable success
criteria; a policy engine decides what may run automatically and what needs your explicit
approval; a local Windows agent executes the authorised operations; and the server verifies
the real outcome with evidence before calling anything "complete".

> Status: see [REQUIREMENTS_TRACEABILITY.md](REQUIREMENTS_TRACEABILITY.md) and
> [KNOWN_ISSUES.md](KNOWN_ISSUES.md). The mandatory acceptance task (create, read back and
> verify `hello.txt`) passes end-to-end with the **real** agent. Features added on
> 2026-10-28 are **NOT VALIDATED** until `scripts\validate.ps1` has been run:
> - OCR
> - web research with citations
> - screenshot attachments
> - REST/MCP integrations
> - deadlines and offline retries
> - TLS remote access
> - the install/update/rollback scripts
>
> Remaining gaps are listed in KNOWN_ISSUES.md.

## Quick start (Windows PowerShell, project folder)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -CheckOnly   # what is missing?
powershell -ExecutionPolicy Bypass -File scripts\install.ps1              # install, configure, migrate, build
powershell -ExecutionPolicy Bypass -File scripts\start.ps1                # dashboard at http://127.0.0.1:3710
powershell -ExecutionPolicy Bypass -File scripts\validate.ps1             # run every test, write a report
```

Update with `scripts\update.ps1 -Source <new release folder or zip>`; it rolls back
automatically if anything fails, and `scripts\rollback.ps1` restores the last snapshot. Details:
[DEPLOYMENT.md](DEPLOYMENT.md). The manual steps below do the same by hand.

## Components

| Folder | What | Stack |
|---|---|---|
| `web/` | Dashboard (13 pages) | React 19, TypeScript, Vite |
| `server/` | API, auth/RBAC, orchestrator, policy engine, approvals, WebSockets, attachments, integrations registry, optional TLS | Node.js 24, NestJS 11, Prisma 7, MySQL 8 |
| `ai-service/` | Rule planner, LLM planner (Ollama / cloud, incl. vision), model routing, redaction, research synthesis, REST/MCP integration calls, DPAPI secret store | Python 3.13, FastAPI |
| `agent/` | Local Windows agent (files, browser, research, UI Automation, Windows OCR, resources) | Python 3.13, Playwright, pywinauto, psutil |
| `scripts/` | Install, start/stop, update/rollback, TLS certificate, validation | Windows PowerShell 5.1 |
| `electron/` | Desktop shell reusing the dashboard, tray emergency stop | Electron 45 (see Known issues) |
| `e2e/` | Real end-to-end acceptance tests | Playwright |

Architecture: [ARCHITECTURE.md](ARCHITECTURE.md) · Data model: [DATABASE.md](DATABASE.md) · API: [API.md](API.md) · Security: [SECURITY.md](SECURITY.md)

## Requirements

- Windows 11, a normal (non-administrator) user account
- Node.js 22+ (tested with 24.22.1) and npm 11
- Python 3.11-3.13 (tested with 3.13.17; 3.14+ is not supported yet: the pinned packages have no prebuilt wheels for it)
- MySQL 8.0 (tested with 8.0 on localhost:3306)
- Microsoft Edge (used by Playwright for browser automation and e2e tests)
- Optional: Ollama with a local model (tested with `qwen2.5:3b`)

## Installation

```powershell
# 1. MySQL: create a restricted user and databases (run once as a MySQL administrator)
#    CREATE USER 'winagent'@'localhost' IDENTIFIED BY '<strong password>';
#    GRANT ALL PRIVILEGES ON `winagent%`.* TO 'winagent'@'localhost';
#    CREATE DATABASE winagent CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
#    CREATE DATABASE winagent_shadow CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
#    CREATE DATABASE winagent_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

# 2. Node dependencies (npm 11 asks before running install scripts; Prisma's are pre-approved in package.json)
npm install

# 3. Python dependencies
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements-dev.txt

# 4. Configuration: put the URL-encoded MySQL password in server/.env.dbcreds as
#    DB_PASSWORD_URLENC=<value>  (or write server/.env by hand from server/.env.example), then:
npm run setup:env          # writes server/.env and ai-service/.env with random service secrets (git-ignored)
#    Delete server/.env.dbcreds afterwards.

# 5. Database schema (version-controlled migrations)
npm run db:migrate
```

## Running (development)

Open four terminals in the project folder:

```powershell
# AI service (127.0.0.1:8710)
cd ai-service; ..\.venv\Scripts\python -m app.main

# API server (127.0.0.1:3710)
npm run dev:server

# Dashboard (http://127.0.0.1:5173, proxies /api and /ws to the server)
npm run dev:web

# Local Windows agent (after pairing, see below)
cd agent; ..\.venv\Scripts\python -m winagent run
```

Production-style: `npm run build`, then `node server\dist\main.js` serves the built
dashboard at http://127.0.0.1:3710.

### First use

1. Open the dashboard and create the first administrator (only possible while no users exist).
2. **Agent devices → Create pairing code**, then on the Windows computer:
   `cd agent; ..\.venv\Scripts\python -m winagent pair --code <CODE>` and `... -m winagent run`.
   The first run creates `%LOCALAPPDATA%\WinAgent\agent-config.json` with two approved folders:
   `workspace` = `Documents\WinAgentWorkspace` and `test` = `Documents\WinAgentWorkspace\test`.
   Edit that file to change approved folders or allowed apps (the dashboard cannot widen them).
3. **New task →** e.g. *Create hello.txt in the approved test folder containing exactly: Hello from my AI agent. Read the file back and verify its contents.*
4. Watch it in **Live monitor**; approve sensitive steps in **Approvals**; review evidence on the task page.

Optional local model: **AI & models → Add model** (`ollama`, model `qwen2.5:3b`,
endpoint `http://127.0.0.1:11434`). Without a model, only rule-planned requests work
(files, folders, websites, web search, allow-listed apps, windows, screenshots, resources).

## Testing

```powershell
npm run test --workspace server      # server unit + integration (MySQL winagent_test, real AI service, SIMULATED agent)
npm run test --workspace web         # dashboard component tests
cd ai-service; ..\.venv\Scripts\python -m pytest     # AI service
cd agent; ..\.venv\Scripts\python -m pytest          # agent (real files, real headless Edge, real UIA)
npm run test:e2e                     # REAL end-to-end acceptance test (winagent_e2e database, real agent)
```

Details and latest results: [TESTING.md](TESTING.md).

## Emergency stop

- Dashboard: the red **Emergency stop** button in the top bar (every page).
- Agent, without the server: `cd agent; ..\.venv\Scripts\python -m winagent estop` (clear with `--clear`).
- Desktop shell tray menu (when Electron can be run).

Emergency stop cancels in-flight agent operations, pauses every active task and refuses new
operations until an administrator clears it. Nothing resumes automatically.

## More

[DEPLOYMENT.md](DEPLOYMENT.md) · [TROUBLESHOOTING.md](TROUBLESHOOTING.md) · [DECISIONS.md](DECISIONS.md) · [CHANGELOG.md](CHANGELOG.md) · [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) · [PRD.md](PRD.md)
