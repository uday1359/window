import type { ChildProcess } from 'node:child_process';

export default async function globalTeardown(): Promise<void> {
  const child = (globalThis as Record<string, unknown>).__AI_PROC__ as ChildProcess | undefined;
  child?.kill();
}
