# Deployment

WinAgent is deployed **from source** on one Windows 11 PC using the PowerShell scripts in
`scripts\` (quick start below). There is no MSI/EXE installer for the server stack. All
services bind to `127.0.0.1`; remote access with TLS is not implemented (see [SECURITY.md](SECURITY.md)).

## Quick start (scripts)

Run from the project folder in Windows PowerShell. `-ExecutionPolicy Bypass` applies to that
one command only.

| Step | Command |
|---|---|
| Check prerequisites | `powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -CheckOnly` |
| Install (first time or repair) | `powershell -ExecutionPolicy Bypass -File scripts\install.ps1`. Add `-InstallPrerequisites` to install missing Node/Python/MySQL/Edge with winget, and `-Desktop` to fetch the Electron runtime. |
| Start / stop | `scripts\start.ps1` (`-Agent` also starts the paired agent; `-Headless` hides its browser) / `scripts\stop.ps1` |
| Update | `scripts\update.ps1 -Source <new release folder or .zip>` |
| Roll back | `scripts\rollback.ps1` (newest snapshot) or `-Release <yyyyMMdd-HHmmss>`; `-SkipDatabase` keeps the current database |

What they do:

- **install.ps1** checks prerequisites, runs `npm ci`, creates `.venv` and installs the Python
  packages. On first install it creates the MySQL user `winagent` with a **random password**,
  stored only in `server\.env`, and the `winagent`, `winagent_shadow` and `winagent_test`
  databases. This needs the MySQL root password once: set `WINAGENT_MYSQL_ROOT_PASSWORD` for
  unattended runs, or type it at the secure prompt. It is never stored. The script then writes
  the `.env` files, migrates and builds. Re-running keeps existing configuration and data.
- **start.ps1** runs the AI service and the built server (which also serves the dashboard) in
  the background. Output goes to `logs\<component>.log`; process IDs go to `data\run.json`. It
  waits for both health checks. Starting never runs tasks: interrupted tasks wait for an
  explicit Resume.
- **update.ps1** stops WinAgent and snapshots the current release into
  `backups\releases\<timestamp>`: source code, both `.env` files and a full `mysqldump`. It then
  mirrors the new source over the installation. `node_modules`, `.venv`, the root `backups`,
  `logs`, `data` and `storage` folders, `.env` files and key files are never touched. Then it
  installs dependencies, migrates, builds, starts and health-checks. **If any step fails, it
  rolls back automatically** and exits with an error.
- **rollback.ps1** restores a snapshot's code and `.env` files, **drops and recreates the
  database from the snapshot's dump**, rebuilds and starts. Data recorded after the snapshot is
  lost, so it asks you to type `YES` unless `-Force` is given.

The numbered sections below describe the same work by hand, for troubleshooting or custom setups.

## 1. Prerequisites

- Windows 11, normal (non-administrator) user account
- Node.js 22+ and npm 11 (tested with Node 24.22.1)
- Python 3.11-3.13 (tested with 3.13.17; 3.14+ not supported yet: no prebuilt wheels for the pinned packages)
- MySQL 8.0 server on `127.0.0.1:3306`, plus client tools (`mysql.exe`, `mysqldump.exe`;
  default path `C:/Program Files/MySQL/MySQL Server 8.0/bin`) for backups
- Microsoft Edge (Playwright browser channel for the agent and e2e tests)
- Optional: Ollama with a local model

## 2. MySQL user and databases

Run once as a MySQL administrator (choose your own strong password):

```sql
CREATE USER 'winagent'@'localhost' IDENTIFIED BY '<strong password>';
GRANT ALL PRIVILEGES ON `winagent%`.* TO 'winagent'@'localhost';
CREATE DATABASE winagent        CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE winagent_shadow CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE winagent_test   CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

- `winagent_test` is used only by server integration tests; `winagent_e2e` is created by the
  e2e setup; `winagent_restore_check` is created and dropped by backup verification. All
  match the `winagent%` grant.
- `scripts/setup-env.mjs` builds URLs as `mysql://winagent:<pw>@127.0.0.1:3306/<db>`, so the
  user must be named `winagent` unless you write `server/.env` by hand.

## 3. Install dependencies

```powershell
npm install                                   # root + server, web, electron workspaces
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements-dev.txt
```

The agent's browser uses the installed Microsoft Edge (`browser_channel: "msedge"` in the
agent config). Using Playwright's bundled Chromium instead (`python -m playwright install
chromium` and `"browser_channel": ""`) is suggested by the agent's error message but is
NOT VALIDATED.

## 4. Configuration

Option A — generated (recommended):

```powershell
# server/.env.dbcreds (git-ignored), one line:
#   DB_PASSWORD_URLENC=<URL-encoded MySQL password>
npm run setup:env
Remove-Item server\.env.dbcreds
```

`setup:env` writes `server/.env` and `ai-service/.env` (both git-ignored), generates a random
`AI_SERVICE_TOKEN` shared by both, never prints values, and preserves existing values on
re-run. Instead of the file you may set `WINAGENT_DB_PASSWORD_URLENC` in the environment.

Option B — by hand: copy `server/.env.example` → `server/.env` and
`ai-service/.env.example` → `ai-service/.env` and fill in the placeholders.

Server variables (validated at startup, `server/src/config/config.ts`; invalid keys are
reported by name only):

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `production` for production-style runs |
| `HOST` / `PORT` | `127.0.0.1` / `3710` | non-loopback `HOST` only logs a warning — do not use without TLS |
| `DATABASE_URL` | required | `mysql://...` |
| `SHADOW_DATABASE_URL`, `TEST_DATABASE_URL` | — | dev migrations / integration tests |
| `AI_SERVICE_URL` | `http://127.0.0.1:8710` | |
| `AI_SERVICE_TOKEN` | required, ≥ 32 chars | must equal the AI service value |
| `SESSION_TTL_HOURS` / `SESSION_IDLE_MINUTES` | 12 / 60 | |
| `WEB_ORIGIN` | `http://127.0.0.1:5173` | allowed WebSocket origin (dev dashboard) |
| `STORAGE_DIR`, `BACKUP_DIR` | required | backup files are written to `BACKUP_DIR` |
| `MYSQL_BIN_DIR` | MySQL 8.0 default path | location of `mysql.exe` / `mysqldump.exe` |
| `WEB_DIST_DIR` | `web/dist` | built dashboard served by the server |
| `APPROVAL_TTL_MINUTES`, `OPERATION_TIMEOUT_MS`, `ORCHESTRATOR_TICK_MS`, `LOGIN_RATE_LIMIT_PER_MIN` | 30, 120000, 1000, 10 | optional |

AI service variables: `AI_HOST` (127.0.0.1), `AI_PORT` (8710), `AI_SERVICE_TOKEN`,
`OLLAMA_URL` (`http://127.0.0.1:11434`), `SECRET_STORE_PATH` (DPAPI store for cloud keys).

## 5. Database migrations

```powershell
npm run db:migrate        # prisma migrate deploy (server/prisma/migrations)
```

Roles and permissions are seeded automatically on server start; there is no separate seed step.

## 6. Build

```powershell
npm run build             # nest build (server/dist) + tsc && vite build (web/dist)
```

## 7. Production-style run

Start each in its own terminal, in this order:

```powershell
# 1. AI service (127.0.0.1:8710)
cd ai-service; ..\.venv\Scripts\python -m app.main

# 2. Server, also serves the built dashboard at http://127.0.0.1:3710
#    (set NODE_ENV=production in server/.env for production logging/cookie settings)
node server\dist\main.js          # or: npm run start --workspace server
```

Health: `GET http://127.0.0.1:3710/api/health` (`ok` / `degraded`) and
`GET http://127.0.0.1:8710/health`. The dashboard **Diagnostics** page shows DB, migrations,
AI service, agents and queue.

On startup, tasks that were PLANNING/QUEUED/RUNNING are marked **INTERRUPTED** and are never
resumed automatically. A persisted emergency stop stays active across restarts.

## 8. Agent pairing and running

1. Dashboard → first run: create the administrator.
2. **Agent devices → Create pairing code** (valid 10 minutes, single use).
3. On the PC, as the normal user:

```powershell
cd agent
..\.venv\Scripts\python -m winagent pair --code <CODE>      # optional: --server http://127.0.0.1:3710 --name <name>
..\.venv\Scripts\python -m winagent run                     # optional: --headless
..\.venv\Scripts\python -m winagent status                  # config path, paired, roots, apps, stop file
```

- The first `run`/`pair`/`status` creates `%LOCALAPPDATA%\WinAgent\agent-config.json` with
  roots `workspace` = `Documents\WinAgentWorkspace` and `test` = `...\WinAgentWorkspace\test`
  and apps notepad, calculator, paint. Edit this file to change approved folders/apps
  (root/app names: lower case `[a-z][a-z0-9_-]{0,31}`; absolute local paths only), then
  restart the agent.
- The device token is stored DPAPI-encrypted in `%LOCALAPPDATA%\WinAgent\device-token.dpapi`.
  `WINAGENT_AGENT_HOME` overrides the agent home folder.
- The agent refuses to run as Administrator unless `--allow-elevated` is given (not
  recommended). It reconnects with exponential backoff (max 30 s).

## 9. Optional: Ollama

Install Ollama, pull a model (tested: `qwen2.5:3b`), keep it on `127.0.0.1:11434`, then
dashboard **AI & models → Add model**: provider `ollama`, model `qwen2.5:3b`, endpoint
`http://127.0.0.1:11434`, local. Without a model only rule-planned requests work. Cloud
providers (`openai_compatible`, `anthropic`) need an `https://` endpoint and an API key saved
under **AI & models** (stored in the DPAPI secret store); not validated against live accounts.

## 10. Windows startup

- Server, AI service and agent: **manual start only**. No service, scheduled task or Run-key
  registration exists in the code.
- Electron shell: the tray menu has **"Start with Windows (does not start tasks)"**, using
  `app.setLoginItemSettings({ openAtLogin })` (`electron/src/main.ts:102-110`). It starts only
  the desktop shell, not the server, AI service or agent.
- **NOT VALIDATED:** the Electron binary could not be downloaded in the development
  environment (GitHub release CDN returned `ECONNRESET`), so the desktop shell, tray, tray
  emergency stop and open-at-login were never run. To try it: `npm run start --workspace
  electron` (expects the server at `http://127.0.0.1:3710`, override with `WINAGENT_URL`).
  The `package` script calls `electron-builder`, which is not a declared dependency.

## 11. Backup and restore

Backups (admin only, dashboard **Diagnostics**, or API):

| Action | API | Result |
|---|---|---|
| Database backup | `POST /api/backups/database` | `mysqldump --single-transaction` to `BACKUP_DIR\winagent-db-<time>.sql`, SHA-256 recorded |
| Config export | `POST /api/backups/config` | models, policies, preferences as JSON (no secrets) |
| Verify restore | `POST /api/backups/<id>/verify-restore` | checks the checksum, restores into scratch DB `winagent_restore_check`, compares tables, migrations and row counts, drops the scratch DB |
| List | `GET /api/backups` | |

There is **no restore endpoint**. Manual restore (stop the server first):

```powershell
$env:MYSQL_PWD = '<password>'   # avoid putting it on the command line
& "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe" -u winagent -h 127.0.0.1 --default-character-set=utf8mb4 winagent -e "source C:/path/to/backups/winagent-db-<time>.sql"
Remove-Item Env:MYSQL_PWD
```

(PowerShell has no `<` input redirection, hence `source`.) This manual procedure is
NOT VALIDATED; only the scratch-database verification is covered by tests.

Not covered by these backups — copy separately if needed: `ai-service/.env`, `server/.env`,
`SECRET_STORE_PATH` (DPAPI blobs only decrypt for the same Windows user on the same PC), and
`%LOCALAPPDATA%\WinAgent\` (agent config, token, journal, evidence, file backups/quarantine).
Backup files are unencrypted; protect `BACKUP_DIR`.

## 12. Upgrade

Use `scripts\update.ps1` and `scripts\rollback.ps1` (see Quick start). Manual equivalent:

1. Create and verify a database backup (section 11). Copy `.env` files and the secret store.
2. Stop the agent, server and AI service.
3. Replace the source tree with the new version (keep `.env`, `data/`, `backups/`).
4. `npm install` and `.venv\Scripts\python -m pip install -r requirements-dev.txt`.
5. `npm run db:migrate`, then `npm run build`.
6. Start AI service, server, agent. Review any INTERRUPTED tasks and resume them explicitly.

Manual rollback = restore the previous source tree, the `.env` files and the pre-upgrade database dump.

## 13. Remote agents over TLS (optional, NOT VALIDATED)

By default everything listens on `127.0.0.1`. To let an agent on another PC connect:

1. On the server PC: `powershell -ExecutionPolicy Bypass -File scripts\new-tls-cert.ps1 -HostName <name or IP agents will use>`.
   This creates `data\tls\server.pfx` (private) and `data\tls\server.pem` (public), and sets
   `HOST=0.0.0.0`, `TLS_PFX_FILE`, `TLS_PFX_PASSPHRASE` and `PUBLIC_ORIGIN` in `server\.env`.
2. Open the server port (default 3710) in Windows Firewall and in any cloud security group,
   **for trusted source addresses only**.
3. `scripts\stop.ps1`, then `scripts\start.ps1`. The server now serves `https://` and `wss://`.
4. Copy `server.pem` (never the `.pfx`) to the agent PC and pair:
   `python -m winagent pair --code <CODE> --server https://<HostName>:3710 --ca-file C:\path\server.pem`
5. Browsers warn about a self-signed certificate. For production, set `TLS_PFX_FILE` /
   `TLS_PFX_PASSPHRASE` to a certificate from your organisation's CA instead.

Without TLS settings, the server refuses to start on any non-loopback `HOST`.

## 14. Optional features

- **OCR** (`desktop.ocr`, `screen_contains_text`) uses the Windows OCR engine. It needs at
  least one Windows display language with OCR support (Settings → Time & language → Language).
  Windows 11 desktop editions normally have one; Windows Server may not.
- **Screenshot attachments** need a model with the `vision` capability (AI & models), e.g. a
  local Ollama vision model. They are stored under `STORAGE_DIR\attachments`.
- **Research** uses DuckDuckGo through the agent's browser; a model is optional (without one,
  the sources are listed without a summary).
- **Integrations** (Policies page → Integrations, admin only):
  1. If the service needs a key, store it under AI & models → Secrets.
  2. Add the integration with its base URL, allowed paths (REST) or tools (MCP), and the
     secret name.
  3. For MCP, use **Show tools** to see what the server offers, then allow only what tasks need.
