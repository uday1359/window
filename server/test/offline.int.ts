import { existsSync, readFileSync } from 'node:fs';
import type { INestApplication } from '@nestjs/common';
import { applyTestEnv } from './env';
import { resetDatabase } from './helpers';

/**
 * Real NestJS app, real MySQL: an outage is simulated by pointing the server at a closed port,
 * so the developer's MySQL service is never touched.
 */
describe('offline store with the real server', () => {
  let queueFile = '';
  let realDatabaseUrl = '';

  beforeAll(async () => {
    await resetDatabase();
    applyTestEnv();
    queueFile = process.env.OFFLINE_QUEUE_FILE!;
    realDatabaseUrl = process.env.DATABASE_URL!;
  });

  async function boot(databaseUrl: string): Promise<INestApplication> {
    process.env.DATABASE_URL = databaseUrl;
    const { resetConfigCache } = await import('../src/config/config');
    resetConfigCache();
    const { createApp } = await import('../src/bootstrap');
    const app = await createApp();
    await app.init();
    return app;
  }

  it('starts without MySQL, keeps audit events locally, and saves them once MySQL is back', async () => {
    const { AuditService } = await import('../src/audit/audit.service');
    const { OfflineStore } = await import('../src/offline/offline-store.service');

    // 1. Database unreachable: the server still starts and the event goes to the local file.
    const down = await boot(realDatabaseUrl.replace(/127\.0\.0\.1:\d+/, '127.0.0.1:1'));
    try {
      expect(down.get(OfflineStore).databaseAvailable).toBe(false);
      await down.get(AuditService).record({ actorType: 'SYSTEM', action: 'offline.test', outcome: 'INFO', details: { note: 'written during outage' } });
      expect(existsSync(queueFile)).toBe(true);
      const queued = readFileSync(queueFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(queued.filter((q) => q.model === 'auditEvent' && q.args.data.action === 'offline.test')).toHaveLength(1);
    } finally {
      await down.close();
    }

    // 2. Database back: the next sync writes the event to MySQL exactly once and empties the file.
    const up = await boot(realDatabaseUrl);
    try {
      const store = up.get(OfflineStore);
      store.markUnavailable();
      await store.sync();
      await store.sync(); // a second sync must not duplicate anything
      const { PrismaService } = await import('../src/prisma/prisma.service');
      const rows = await up.get(PrismaService).auditEvent.findMany({ where: { action: 'offline.test' } });
      expect(rows).toHaveLength(1);
      expect(rows[0].offlineId).toMatch(/^[0-9a-f-]{36}$/);
      expect(rows[0].details).toEqual({ note: 'written during outage' });
      expect(store.status()).toMatchObject({ databaseAvailable: true, pending: 0 });
      expect(readFileSync(queueFile, 'utf8')).toBe('');
    } finally {
      await up.close();
    }
  }, 60_000);
});
