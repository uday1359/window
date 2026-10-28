import { execSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { AI_TEST_PORT, applyTestEnv } from './env';

/**
 * Integration prerequisites: applies the version-controlled migrations to the
 * winagent_test database (non-destructive `migrate deploy`; each suite empties only
 * that database via resetDatabase()) and starts the real Python AI service.
 */
export default async function globalSetup(): Promise<void> {
  applyTestEnv();
  const serverDir = join(__dirname, '..');
  execSync('npx prisma migrate deploy', { cwd: serverDir, env: process.env, stdio: 'pipe' });

  const root = join(serverDir, '..');
  const python = join(root, '.venv', 'Scripts', 'python.exe');
  const child = spawn(python, ['-m', 'uvicorn', 'app.main:create_app', '--factory', '--host', '127.0.0.1', '--port', String(AI_TEST_PORT), '--log-level', 'warning'], {
    cwd: join(root, 'ai-service'),
    env: { ...process.env, WINAGENT_SKIP_ENV_FILE: '1', SECRET_STORE_PATH: join(process.env.STORAGE_DIR!, 'secrets.dpapi'), OLLAMA_URL: 'http://127.0.0.1:11434' },
    stdio: 'ignore',
  });
  (globalThis as Record<string, unknown>).__AI_PROC__ = child;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${AI_TEST_PORT}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill();
  throw new Error('AI service did not start for integration tests');
}
