# Known Issues and Limitations

Status as of 2026-10-28. See [REQUIREMENTS_TRACEABILITY.md](REQUIREMENTS_TRACEABILITY.md) for the requirement-by-requirement view.

## Not yet validated by a test run

All 208 automated tests passed on 2026-10-28 (docs/TESTING.md). The following have no passing run yet:

- **Update / rollback lifecycle** (`scripts\test-lifecycle.ps1`): `install.ps1` passed in a sandbox, but the full lifecycle needs about 4 GB of free memory. Run `scripts\validate.ps1 -IncludeLifecycle` on a larger machine.
- **TLS remote access** (`scripts\new-tls-cert.ps1`, `TLS_*` settings, agent `ca_file`).
- **`setup-windows.ps1` on a fresh machine.** The installer signature and checksum checks were verified against the real downloads.
- **Live services:**
  - research against live DuckDuckGo results (source selection is unit-tested)
  - vision models for screenshot attachments
  - real MCP servers (the MCP client is tested against a simulated server)
- **Windows Server OCR:** passed on Windows 11. On Windows Server an OCR language may be missing; then the test is skipped and verification is INCONCLUSIVE, not FAIL.

## Not implemented / partial

- **Mouse automation and image-based clicking (FR-04):** desktop control is UI Automation plus OCR reading only.
- **Resource management (FR-15):** CPU temperature unavailable on Windows (psutil); GPU data only for NVIDIA (`nvidia-smi`); concurrency is fixed at one task.
- **Voice (FR-13):** depends on the browser's Speech API; not validated with a real microphone.
- **Cloud model providers:** OpenAI-compatible and Anthropic clients (including image input) are implemented and unit-tested, but not validated against live accounts.
- **MCP over stdio:** deliberately not supported, because it would mean starting arbitrary local programs. Only MCP servers reachable over HTTP(S) can be integrated.
- **No MSI/EXE installer** for the server stack; installation is the `scripts\install.ps1` script. The Electron app has an NSIS target (`npm run package --workspace electron`) that needs `electron-builder`, which is not installed (NOT VALIDATED).

## Not validated

- **Electron desktop shell:** the Electron binary could not be downloaded (GitHub release CDN returned ECONNRESET). `electron/` compiles against Electron 45 types; window, tray, emergency-stop menu and open-at-login were never run.
- **Windows versions other than the development machine** (Windows 11 Pro), and browsers other than Microsoft Edge.

## Dependencies

- `npm audit`: 0 vulnerabilities in production dependencies; 8 low in dev-only tooling (accepted, see SECURITY.md).

## Low-severity findings (accepted for this release)

- Dashboard events for a status change made inside a larger database transaction are published before that transaction commits. If it rolls back, the dashboard briefly shows a status that did not happen until the next refresh (`tasks/task-state.service.ts`).
- Users with `task:read_all` (administrators) receive every user's live dashboard events, including notifications and agent resource data. This is intentional for oversight.
- `/api/system/state` and `/api/diagnostics` have no permission requirement beyond being signed in. Diagnostics shows only the user's own devices and task counts, plus server runtime details (Node version, memory, migrations).
- Retention deleting a very old prerequisite task also deletes its dependency link. A still-queued dependant would then run without that check (only possible if it stayed queued longer than the retention period).
- Retention first runs 24 hours after server start; the 60-second dashboard-socket session check enforces expiry and revocation but not the idle timeout.
- `VerificationEvidence.storagePath` is never written: screenshots taken as evidence stay in the agent's local `evidence` folder. (`STORAGE_DIR` now holds task attachments.)
- Integration responses and research page text are stored with step results (up to 50,000 characters per result) and are subject to the same history retention as tasks.
- Marking an unknown notification as read returns `{ updated: 0 }` instead of 404.

## Operational notes

- The agent must run as a normal user; `--allow-elevated` exists but is not recommended.
- Approved folders and allowed apps can only be changed in `%LOCALAPPDATA%\WinAgent\agent-config.json` on the PC.
- Local LLM planning with `qwen2.5:3b` took about 59 s in testing; the rule planner is instant.
