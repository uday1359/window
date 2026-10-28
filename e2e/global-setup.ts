import { execSync, spawn } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '../server/src/generated/prisma/client';
import { createAdapter } from '../server/src/prisma/prisma.service';
import { AI_PORT, E2E_DIR, e2eEnv, PYTHON, ROOT, SERVER_PORT, waitFor, writeAgentConfig } from './stack';

/** Builds and starts the real stack on dedicated ports against the winagent_e2e database. */
export default async function globalSetup(): Promise<void> {
  if (existsSync(E2E_DIR)) rmSync(E2E_DIR, { recursive: true, force: true }); // previous run's scratch folder only
  writeAgentConfig();
  const env = e2eEnv();
  const server = join(ROOT, 'server');

  // The restricted winagent user may create winagent* databases but cannot read the `mysql`
  // system schema that Prisma would use to create one, so create it explicitly.
  const admin = new PrismaClient({ adapter: createAdapter(env.DATABASE_URL!.replace('/winagent_e2e', '/winagent')) });
  await admin.$executeRawUnsafe('CREATE DATABASE IF NOT EXISTS winagent_e2e CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
  await admin.$disconnect();

  execSync('npx prisma migrate deploy', { cwd: server, env, stdio: 'pipe' });
  // One connection: SET FOREIGN_KEY_CHECKS is per session and must apply to every TRUNCATE.
  const prisma = new PrismaClient({ adapter: createAdapter(env.DATABASE_URL!, 1) });
  const tables = await prisma.$queryRaw<Array<{ TABLE_NAME: string }>>`SELECT TABLE_NAME FROM information_schema.tables WHERE table_schema = DATABASE() AND TABLE_NAME <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of tables) await prisma.$executeRawUnsafe(`TRUNCATE TABLE \`${t.TABLE_NAME}\``);
  await prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1');
  await prisma.$disconnect();

  execSync('npm run build', { cwd: server, stdio: 'pipe' });
  execSync('npm run build', { cwd: join(ROOT, 'web'), stdio: 'pipe' });

  const pids: number[] = [];
  const ai = spawn(PYTHON, ['-m', 'uvicorn', 'app.main:create_app', '--factory', '--host', '127.0.0.1', '--port', String(AI_PORT), '--log-level', 'warning'], {
    cwd: join(ROOT, 'ai-service'),
    env: { ...env, SECRET_STORE_PATH: join(E2E_DIR, 'secrets.dpapi') },
    stdio: 'ignore',
  });
  pids.push(ai.pid!);
  const api = spawn(process.execPath, [join(server, 'dist', 'main.js')], { cwd: server, env, stdio: 'ignore' });
  pids.push(api.pid!);
  writeFileSync(join(E2E_DIR, 'pids.json'), JSON.stringify(pids));
  await waitFor(`http://127.0.0.1:${AI_PORT}/health`);
  await waitFor(`http://127.0.0.1:${SERVER_PORT}/api/health`);
}
