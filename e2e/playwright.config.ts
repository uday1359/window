import { defineConfig } from '@playwright/test';

/**
 * End-to-end acceptance tests against the REAL stack: built dashboard + NestJS server,
 * MySQL (isolated winagent_e2e database), the Python AI service and the real Windows
 * agent executing operations on disk. Nothing in this suite is simulated.
 */
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.e2e\.ts$/,
  timeout: 180_000,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  use: {
    baseURL: 'http://127.0.0.1:3712',
    channel: 'msedge',
    headless: true,
    trace: 'retain-on-failure',
  },
});
