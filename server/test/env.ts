import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const AI_TEST_PORT = 8711;

function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** Points the server at the isolated winagent_test database and a test AI service. */
export function applyTestEnv(): void {
  if (process.env.WINAGENT_TEST_ENV_APPLIED) return;
  const file = parseEnvFile(join(__dirname, '..', '.env'));
  const testDb = process.env.TEST_DATABASE_URL ?? file.TEST_DATABASE_URL;
  if (!testDb || !/\/winagent_test(\?|$)/.test(testDb)) throw new Error('TEST_DATABASE_URL must point at the winagent_test database');
  const scratch = mkdtempSync(join(tmpdir(), 'winagent-test-'));
  Object.assign(process.env, {
    WINAGENT_TEST_ENV_APPLIED: '1',
    WINAGENT_SKIP_ENV_FILE: '1',
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: '0',
    DATABASE_URL: testDb,
    SHADOW_DATABASE_URL: file.SHADOW_DATABASE_URL ?? '',
    AI_SERVICE_URL: `http://127.0.0.1:${AI_TEST_PORT}`,
    AI_SERVICE_TOKEN: file.AI_SERVICE_TOKEN ?? 'x'.repeat(48),
    STORAGE_DIR: join(scratch, 'storage'),
    OFFLINE_QUEUE_FILE: join(scratch, 'offline-queue.jsonl'),
    BACKUP_DIR: join(scratch, 'backups'),
    // Empty = the server finds the newest MySQL Server under the Program Files folder.
    MYSQL_BIN_DIR: file.MYSQL_BIN_DIR ?? '',
    OPERATION_TIMEOUT_MS: '2000',
    ORCHESTRATOR_TICK_MS: '100',
    LOGIN_RATE_LIMIT_PER_MIN: '1000',
    WEB_ORIGIN: 'http://127.0.0.1:5173',
  });
}
