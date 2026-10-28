import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '../src/generated/prisma/client';
import { createAdapter } from '../src/prisma/prisma.service';
import request from 'supertest';
import { applyTestEnv } from './env';
import { FakeAgent } from './fake-agent';

export const PASSWORD = 'integration-test-password';

export interface TestContext {
  app: INestApplication;
  baseUrl: string;
  wsUrl: string;
  prisma: PrismaClient;
}

/** Empties every application table in winagent_test (never touches the dev database). */
export async function resetDatabase(): Promise<void> {
  applyTestEnv();
  if (!/\/winagent_test(\?|$)/.test(process.env.DATABASE_URL ?? '')) throw new Error('refusing to reset a non-test database');
  // One connection: SET FOREIGN_KEY_CHECKS is per session and must apply to every TRUNCATE.
  const prisma = new PrismaClient({ adapter: createAdapter(process.env.DATABASE_URL!, 1) });
  const tables = await prisma.$queryRaw<Array<{ TABLE_NAME: string }>>`SELECT TABLE_NAME FROM information_schema.tables WHERE table_schema = DATABASE() AND TABLE_NAME <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of tables) await prisma.$executeRawUnsafe(`TRUNCATE TABLE \`${t.TABLE_NAME}\``);
  await prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1');
  await prisma.$disconnect();
}

export async function startApp(): Promise<TestContext> {
  applyTestEnv();
  const { resetConfigCache } = await import('../src/config/config');
  resetConfigCache();
  const { createApp } = await import('../src/bootstrap');
  const app = await createApp();
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address() as { port: number };
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { app, baseUrl, wsUrl: `ws://127.0.0.1:${address.port}/ws/agent`, prisma: new PrismaClient({ adapter: createAdapter(process.env.DATABASE_URL!) }) };
}

export function client(ctx: TestContext) {
  const agent = request.agent(ctx.app.getHttpServer());
  const csrf = { 'x-winagent-csrf': '1' };
  return {
    raw: agent,
    get: (url: string) => agent.get(url),
    post: (url: string, body?: object, headers: Record<string, string> = {}) => agent.post(url).set({ ...csrf, ...headers }).send(body ?? {}),
    put: (url: string, body?: object) => agent.put(url).set(csrf).send(body ?? {}),
    patch: (url: string, body?: object) => agent.patch(url).set(csrf).send(body ?? {}),
    del: (url: string) => agent.delete(url).set(csrf),
  };
}
export type Client = ReturnType<typeof client>;

export async function bootstrapAdmin(ctx: TestContext, email = 'admin@example.com'): Promise<Client> {
  const c = client(ctx);
  await c.post('/api/auth/bootstrap', { email, displayName: 'Admin', password: PASSWORD }).expect(201);
  await c.post('/api/auth/login', { email, password: PASSWORD }).expect(200);
  return c;
}

export async function login(ctx: TestContext, email: string): Promise<Client> {
  const c = client(ctx);
  await c.post('/api/auth/login', { email, password: PASSWORD }).expect(200);
  return c;
}

export async function pairFakeAgent(ctx: TestContext, owner: Client): Promise<{ agent: FakeAgent; deviceId: string }> {
  const { body: code } = await owner.post('/api/agents/pairing-codes').expect(201);
  const { body: paired } = await client(ctx).post('/api/agents/pair', { code: code.code, name: 'fake', hostname: 'test-host' }).expect(201);
  const agent = new FakeAgent(ctx.wsUrl, paired.token);
  await agent.connect();
  return { agent, deviceId: paired.deviceId };
}

export async function waitForStatus(c: Client, taskId: string, statuses: string[], timeoutMs = 15000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    last = (await c.get(`/api/tasks/${taskId}`)).body;
    if (statuses.includes(String(last.status))) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Task ${taskId} did not reach ${statuses.join('/')} (last: ${last.status} - ${last.statusReason})`);
}

export async function stopApp(ctx: TestContext): Promise<void> {
  // Let agent-disconnect bookkeeping finish before the app's database client shuts down.
  const { AgentHubService } = await import('../src/realtime/agent-hub.service');
  await ctx.app.get(AgentHubService).drain();
  await ctx.prisma.$disconnect();
  await ctx.app.close();
}
