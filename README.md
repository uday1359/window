# WinAgent — Windows 11 AI Desktop-Control Agent (V1.0)

WinAgent lets you describe computer tasks in plain language from a web dashboard. A
planner turns the request into a structured, whitelisted plan with measurable success
criteria; a policy engine decides what may run automatically and what needs your explicit
approval; a local Windows agent executes the authorised operations; and the server verifies
the real outcome with evidence before calling anything "complete".

> Status: see [docs/REQUIREMENTS_TRACEABILITY.md](docs/REQUIREMENTS_TRACEABILITY.md) and
> [docs/KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md). All 208 automated tests pass (2026-10-28), including
> the mandatory acceptance task (create, read back and verify `hello.txt`) end-to-end with the
> **real** agent, Windows OCR, research, screenshot attachments, integrations (against simulated
> servers), deadlines and offline retries. Not yet validated by a test run:
> - TLS remote access
> - the update/rollback lifecycle test (`install.ps1` itself passed in a sandbox)
> - `setup-windows.ps1` on a fresh machine
> - the Electron runtime
> - live cloud, vision and MCP services

## New computer: one-click developer setup

**One click:** download [`setup-windows.cmd`](https://github.com/uday1359/window/raw/main/setup-windows.cmd)
(GitHub → `setup-windows.cmd` → *Download raw file*) and double-click it as your normal user.
It fetches `setup-windows.ps1` from GitHub by itself and then:

1. **Software** (one administrator approval): installs whatever is missing of:
   - Git, Node.js LTS, Python 3.13 and the Visual C++ runtime
   - MySQL 8.4 LTS, configured as the `MySQL84` service on `127.0.0.1:3306`
   - it also checks that Microsoft Edge is present

   Every installer comes from its official site and is verified (code signature and published
   checksum); winget and the Microsoft Store are not used.
2. **Project**: clones this repository to `%USERPROFILE%\WINDOW`, then installs the npm and
   Python packages, creates the database user and databases, migrates and builds.
3. **Developer tools**: VS Code plus the recommended extensions from `.vscode/extensions.json`.

**Before you double-click:** create `credentials.env` next to `setup-windows.cmd` (see
[Credentials](#credentials)). The setup never prompts for passwords. If the file is missing,
it creates an empty one and stops so you can fill it in.

The same from PowerShell, with options:

```powershell
powershell -ExecutionPolicy Bypass -File setup-windows.ps1 -Developer             # what the .cmd does
powershell -ExecutionPolicy Bypass -File setup-windows.ps1 -Developer -Validate   # + run every test
powershell -ExecutionPolicy Bypass -File setup-windows.ps1 -Developer -WithOllama # + local AI model (~2 GB)
powershell -ExecutionPolicy Bypass -File setup-windows.ps1                        # runtime only, no developer tools
```

## Credentials

Fill these in **before** running the setup. Only the first one goes into a file; everything else
is created for you or entered later in the dashboard, where it is stored encrypted.

| Credential | Needed for | Where to put it | When |
|---|---|---|---|
| **MySQL root password** | Creating (or repairing) the WinAgent database user. On a new computer the setup installs MySQL and makes this the root password. | `credentials.env`, line `MYSQL_ROOT_PASSWORD=…`, in the project folder, or next to `setup-windows.cmd` on a new computer. Copy `credentials.env.example` to start. | Before the first install. You can remove it after a successful install. |
| WinAgent database user (`winagent`) | Normal running | *Nothing to do*: `scripts\install.ps1` generates a random password and writes it to `server\.env`. | Automatic |
| Service token (server ↔ AI service) | Normal running | *Nothing to do*: generated into `server\.env` and `ai-service\.env`. | Automatic |
| First dashboard administrator (e-mail + password) | Signing in to the dashboard | Created on the dashboard's first-run page (`http://127.0.0.1:3710`). | After `scripts\start.ps1` |
| Agent pairing code | Connecting the Windows agent | Dashboard → **Agent devices → Create pairing code**, then in the `agent` folder: `..\.venv\Scripts\python -m winagent pair --code <CODE>`. Its device token is stored encrypted (Windows DPAPI). | After signing in |
| Cloud AI API keys (OpenAI-compatible, Anthropic), *optional* | Cloud models | Dashboard → **AI & models → Secrets**. Stored encrypted with Windows DPAPI; never in a file in the project. | Only if you use cloud models |
| Integration API keys, *optional* | REST/MCP integrations | Dashboard → **AI & models → Secrets**, then name the secret on the integration (Policies → Integrations). | Only if you use integrations |

`credentials.env`, `server\.env` and `ai-service\.env` are git-ignored: they are never committed
or uploaded, and `scripts\update.ps1` never overwrites them.

## Project layout

| Path | Contents |
|---|---|
| `server/` | NestJS API server, Prisma schema and migrations, unit and integration tests |
| `web/` | React dashboard |
| `ai-service/` | Python planner, model router, research synthesis, integrations |
| `agent/` | Python Windows agent |
| `electron/` | Desktop shell |
| `e2e/` | Real end-to-end tests |
| `scripts/` | install, start/stop, update/rollback, TLS certificate, validation |
| `docs/` | Architecture, API, database, security, deployment, testing, troubleshooting, decisions, requirements (PRD) and traceability, known issues, architecture PDFs |
| `setup-windows.cmd` / `.ps1` | One-click setup of a new Windows computer |
| `.vscode/` | Recommended extensions and editor settings |

## Quick start (Windows PowerShell, project folder)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -CheckOnly   # what is missing?
powershell -ExecutionPolicy Bypass -File scripts\install.ps1              # install, configure, migrate, build
powershell -ExecutionPolicy Bypass -File scripts\start.ps1                # dashboard at http://127.0.0.1:3710
powershell -ExecutionPolicy Bypass -File scripts\validate.ps1             # run every test, write a report
```

Update with `scripts\update.ps1 -Source <new release folder or zip>`; it rolls back
automatically if anything fails, and `scripts\rollback.ps1` restores the last snapshot. Details:
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). The manual steps below do the same by hand.

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

Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · Data model: [docs/DATABASE.md](docs/DATABASE.md) · API: [docs/API.md](docs/API.md) · Security: [docs/SECURITY.md](docs/SECURITY.md)

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

Details and latest results: [docs/TESTING.md](docs/TESTING.md).

## Emergency stop

- Dashboard: the red **Emergency stop** button in the top bar (every page).
- Agent, without the server: `cd agent; ..\.venv\Scripts\python -m winagent estop` (clear with `--clear`).
- Desktop shell tray menu (when Electron can be run).

Emergency stop cancels in-flight agent operations, pauses every active task and refuses new
operations until an administrator clears it. Nothing resumes automatically.

## More

[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) · [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) · [docs/DECISIONS.md](docs/DECISIONS.md) · [CHANGELOG.md](CHANGELOG.md) · [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) · [docs/PRD.md](docs/PRD.md)
