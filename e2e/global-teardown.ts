import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E_DIR } from './stack';

/** Stops only the processes this suite started (recorded PIDs, including the agent). */
export default async function globalTeardown(): Promise<void> {
  const file = join(E2E_DIR, 'pids.json');
  if (!existsSync(file)) return;
  for (const pid of JSON.parse(readFileSync(file, 'utf8')) as number[]) {
    try {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
    } catch {
      /* already exited */
    }
  }
}
