import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const ROOT = resolve(__dirname, '..');
export const E2E_DIR = join(ROOT, 'e2e', '.run');
export const SERVER_PORT = 3712;
export const AI_PORT = 8712;
export const PYTHON = join(ROOT, '.venv', 'Scripts', 'python.exe');
export const AGENT_HOME = join(E2E_DIR, 'agent-home');
export const APPROVED_TEST_DIR = join(E2E_DIR, 'approved', 'test');
export const WORKSPACE_DIR = join(E2E_DIR, 'approved', 'workspace');

function parseEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** Server env for the isolated e2e database (derived from the local, git-ignored .env). */
export function e2eEnv(): NodeJS.ProcessEnv {
  const file = parseEnv(join(ROOT, 'server', '.env'));
  if (!file.DATABASE_URL) throw new Error('server/.env is missing; run npm run setup:env');
  const dbUrl = file.DATABASE_URL.replace(/\/winagent(\?|$)/, '/winagent_e2e$1');
  if (!/\/winagent_e2e(\?|$)/.test(dbUrl)) throw new Error('could not derive the e2e database URL');
  return {
    ...process.env,
    WINAGENT_SKIP_ENV_FILE: '1',
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(SERVER_PORT),
    DATABASE_URL: dbUrl,
    SHADOW_DATABASE_URL: file.SHADOW_DATABASE_URL,
    AI_SERVICE_URL: `http://127.0.0.1:${AI_PORT}`,
    AI_SERVICE_TOKEN: file.AI_SERVICE_TOKEN,
    STORAGE_DIR: join(E2E_DIR, 'storage'),
    BACKUP_DIR: join(E2E_DIR, 'backups'),
    MYSQL_BIN_DIR: file.MYSQL_BIN_DIR,
    WEB_ORIGIN: `http://127.0.0.1:${SERVER_PORT}`,
  };
}

/** Local agent configuration: the ONLY approved folders are inside the e2e run directory. */
export function writeAgentConfig(): void {
  for (const d of [AGENT_HOME, APPROVED_TEST_DIR, WORKSPACE_DIR]) mkdirSync(d, { recursive: true });
  writeFileSync(
    join(AGENT_HOME, 'agent-config.json'),
    JSON.stringify(
      {
        server_url: `http://127.0.0.1:${SERVER_PORT}`,
        device_name: 'e2e-windows-agent',
        roots: { test: APPROVED_TEST_DIR, workspace: WORKSPACE_DIR },
        apps: { notepad: 'notepad.exe' },
        browser_channel: 'msedge',
        browser_headless: true,
      },
      null,
      2,
    ),
  );
}

export async function waitFor(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timed out waiting for ${url}`);
}
