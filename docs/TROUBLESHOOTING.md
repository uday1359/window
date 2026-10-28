# Troubleshooting

Messages below are quoted from the code. Commands assume PowerShell in the project root.

## Agent

| Symptom | Cause | Fix |
|---|---|---|
| `Refusing to run elevated (Administrator)` | Agent started from an Administrator terminal. | Start it from a normal terminal. `--allow-elevated` exists but is not recommended. |
| `Not paired. Create a pairing code in the dashboard…` | No DPAPI token in `%LOCALAPPDATA%\WinAgent\device-token.dpapi`. | Dashboard → **Agent devices → Create pairing code**, then `cd agent; ..\.venv\Scripts\python -m winagent pair --code <CODE>`. |
| `Pairing failed: HTTP 401 Pairing code is invalid, expired or already used` | Code mistyped, expired or reused. | Create a new code. |
| `Pairing failed: HTTP 429 Too many pairing attempts` | Pairing rate limit. | Wait a few minutes, then retry. |
| `Pairing failed: server unreachable` | Server not running or wrong URL. | Start the server; pass `--server http://127.0.0.1:3710` if needed. |
| Agent log: `server rejected the device token (revoked?)` and it exits | Device revoked in the dashboard, or the database was reset. | Pair again. |
| Agent log: `device access revoked by server` | Revoked while connected; token is deleted. | Pair again if access should be restored. |
| Agent keeps logging `connection lost …; retrying in Ns` | Server down or restarting. | Start the server; the agent reconnects by itself (back-off up to 30 s). |
| Operations fail with `EMERGENCY_STOP` | Emergency stop is active on the server or locally. | Admin clears it in the dashboard. Local stop: `python -m winagent estop --clear`. Check with `python -m winagent status`. |
| Browser steps fail: `browser could not be started … install Microsoft Edge or run 'playwright install chromium'` | Edge missing or Playwright cannot find it. | Install Microsoft Edge, or set `browser_channel` in `agent-config.json` and run `.venv\Scripts\python -m playwright install chromium`. |
| A path is refused as outside the approved folder, reserved, or executable | The path sandbox: root + relative path only; no `..`, device names or executable extensions. | Use an approved root. To add one, edit `roots` in `%LOCALAPPDATA%\WinAgent\agent-config.json` and restart the agent. |
| App launch refused | App not in the agent's allow-list. | Add it to `apps` in `agent-config.json` and restart the agent. |

## Tasks

| Symptom | Cause | Fix |
|---|---|---|
| BLOCKED: `The agent has not reported its approved folders yet…` | No connected agent when planning. | Start the agent, then press **Resume**. |
| BLOCKED: `Agent is not connected. Start the agent and press Resume.` | Agent went offline during the task. | Start the agent, then **Resume**. Resume first checks the real state through the agent. |
| BLOCKED: `Planner unavailable (…)` | AI service down, or no model could plan the request. | Start the AI service (`cd ai-service; ..\.venv\Scripts\python -m app.main`). For requests the rule planner cannot handle, add a model under **AI & models**. |
| Planner reason mentions `privacy policy forbids cloud processing` or all models excluded | Task is `LOCAL_ONLY` and no local model is available, or cloud models are offline / over the cost limit. | Add a local Ollama model, or choose a less strict privacy level if appropriate. Use **AI & models → route preview** to see why each model was excluded. |
| BLOCKED with `HUMAN_VERIFICATION_REQUIRED` | The page shows a CAPTCHA, OTP, MFA or identity check. These are never bypassed. | Complete the check yourself in the automation browser window, then **Resume**. |
| Step fails with `APPROVAL_MISMATCH` | A sensitive operation reached the agent without a matching approval. | Resume the task; approve the new request in **Approvals**. |
| `The action changed after approval was requested; a new approval is required` | The step changed after you saw it. | Review and approve the new request. |
| `Approval request has expired…` | Not decided in time. | Resume the task to request a new approval. |
| Resume refused: `Step N … may have run already and is not safe to repeat` | Outcome of a non-idempotent step is unknown (UNCERTAIN). | Check the result yourself, then resume with the confirmation option. |
| Tasks show INTERRUPTED after a restart | By design: nothing resumes automatically after the server restarts. | Review each task and press **Resume**. |
| `Emergency stop is active. An administrator must clear it first.` | Emergency stop is on. | An administrator clears it on the dashboard. Paused tasks stay paused until resumed individually. |
| Task created with `400 … appears to contain a password, token or key` | Secrets are never stored or sent to models. | Remove the secret from the instruction. |
| Task FAILED on verification | The real result did not match the success criteria. | Open the task: the evidence table shows expected versus actual values. |

## Server, database and dashboard

| Symptom | Cause | Fix |
|---|---|---|
| Server exits on start with a configuration error | `server/.env` missing or incomplete. | Run `npm run setup:env` (see DEPLOYMENT.md), or copy `server/.env.example`. |
| Prisma `P1001` / cannot reach database | MySQL service not running or wrong credentials. | Start the MySQL80 service; check `DATABASE_URL` in `server/.env`. |
| Prisma reports pending migrations | Schema is newer than the database. | `npm run db:migrate`. |
| Dashboard requests fail with 403 | Missing CSRF header (non-dashboard client) or insufficient role. | Send `x-winagent-csrf: 1`; ask an admin for the required permission. |
| Dashboard shows `AI service unavailable` (502/503) | AI service down or failing. | Start or restart the AI service; check its console. |
| Login refused after several attempts | Login rate limit or account lockout. | Wait and retry. |
| `/ws/events` keeps reconnecting | Session expired or the page origin is not allowed. | Sign in again; use the URL served by the server or the Vite dev server. |
| Restore verification fails | `mysqldump` / `mysql` not found, or the restored copy differs from the live database. | Put the MySQL `bin` folder on `PATH`; read the reported differences. |

## Local model (Ollama)

| Symptom | Fix |
|---|---|
| Model listed as offline | Start Ollama and check `http://127.0.0.1:11434`; confirm the model is pulled (`ollama list`). |
| Planning is slow (~1 min) | Expected for `qwen2.5:3b` on CPU. Common requests use the instant rule planner instead. |

## Collecting diagnostics

- Dashboard → **Diagnostics** (server, database, AI service, agents, queue).
- `python -m winagent status` on the PC.
- Audit history: **Security** page, or `GET /api/tasks/:id/audit` for one task.

## Added on 2026-10-28

| Symptom | Cause | Fix |
|---|---|---|
| Server exits: `Refusing to listen on … without TLS` | `HOST` is not loopback and no certificate is configured. | Run `scripts\new-tls-cert.ps1`, or set `HOST=127.0.0.1`. |
| Agent: `ca_file … does not exist`, or an SSL certificate error | Wrong path, or the server uses another certificate. | Copy the current `data\tls\server.pem` and pass it with `pair --ca-file`. |
| Task BLOCKED: `Waiting for an AI model or the AI service to become available` | No permitted model is reachable right now. | Nothing to do: planning is retried every 60 s. Start Ollama, restore connectivity, or Cancel the task. |
| Task BLOCKED: `Deadline passed (…)` | It was still queued at its deadline. | Resume to run it anyway (recorded in the audit log) or Cancel. |
| OCR step fails with `no Windows OCR language is installed`; verification INCONCLUSIVE | No OCR-capable language pack. | Add a language with OCR support in Windows Settings. |
| Research fails: `no usable sources found` | Search results were all blocked, private, unreachable or behind CAPTCHAs. | See the `skipped` list in the step result; rephrase the question or relax WEBSITE DENY rules. |
| Research has sources but no claims: `no model could summarise them` | No permitted model for the task's privacy level. | Add a local model, or review the sources directly. |
| Creating a task with screenshots: `not a valid image/png file` | The file is not really a PNG/JPEG. | Save the screenshot as PNG or JPEG. |
| Screenshot task BLOCKED: `Planner unavailable … lacks capability 'vision'` | No vision-capable model. | Add one (AI & models) with the `vision` capability, or remove the screenshots. |
| Integration step: `not registered or is disabled` / `not allowed` | The plan used an integration, path or tool outside the allow list. | Enable the integration or add the path/tool (admin), then Resume. |
| Integration step UNCERTAIN: `did not answer in time` | The external service may or may not have acted. | Check the external service yourself, then Resume. The step is never repeated automatically. |
| `update.ps1` reports `failed and was rolled back` | A step of the update failed. | Read the error printed before the rollback; the previous version is running again. |
