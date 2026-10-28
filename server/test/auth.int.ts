import { client, login, pairFakeAgent, PASSWORD, resetDatabase, startApp, stopApp, TestContext } from './helpers';
import WebSocket from 'ws';

describe('authentication, authorisation and pairing (MySQL)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    await resetDatabase();
    ctx = await startApp();
  });
  afterAll(async () => {
    if (ctx) await stopApp(ctx);
  });

  it('bootstraps exactly one administrator, even under concurrency', async () => {
    expect((await client(ctx).get('/api/auth/status')).body).toEqual({ needsBootstrap: true });
    const attempts = await Promise.all(
      [1, 2, 3].map((i) => client(ctx).post('/api/auth/bootstrap', { email: `race${i}@example.com`, displayName: 'R', password: PASSWORD })),
    );
    expect(attempts.filter((r) => r.status === 201)).toHaveLength(1);
    expect(attempts.filter((r) => r.status === 409)).toHaveLength(2);
    expect(await ctx.prisma.user.count()).toBe(1);
  });

  it('rejects weak passwords, bad input and missing CSRF header', async () => {
    const c = client(ctx);
    expect((await c.post('/api/auth/login', { email: 'not-an-email', password: 'x' })).status).toBe(400);
    expect((await c.raw.post('/api/auth/login').send({ email: 'a@b.co', password: 'x' })).status).toBe(403);
  });

  it('requires authentication and never leaks password hashes', async () => {
    const c = client(ctx);
    expect((await c.get('/api/tasks')).status).toBe(401);
    expect((await c.get('/api/health')).body).toEqual({ status: 'ok' });
    const admin = await login(ctx, (await ctx.prisma.user.findFirstOrThrow({ where: { roles: { some: { roleId: 'ADMIN' } } } })).email);
    const me = await admin.get('/api/auth/me').expect(200);
    expect(JSON.stringify(me.body)).not.toMatch(/passwordHash|scrypt/);
    expect(me.body.roles).toEqual(['ADMIN']);
  });

  it('locks the account after repeated failures', async () => {
    const email = (await ctx.prisma.user.findFirstOrThrow({ where: { roles: { some: { roleId: 'ADMIN' } } } })).email;
    for (let i = 0; i < 5; i++) expect((await client(ctx).post('/api/auth/login', { email, password: 'wrong-password-123' })).status).toBe(401);
    const locked = await client(ctx).post('/api/auth/login', { email, password: PASSWORD });
    expect(locked.status).toBe(401);
    expect(locked.body.message).toMatch(/locked/);
    await ctx.prisma.user.updateMany({ data: { lockedUntil: null, failedLogins: 0 } });
  });

  it('enforces RBAC from the database and data ownership', async () => {
    const email = (await ctx.prisma.user.findFirstOrThrow({ where: { roles: { some: { roleId: 'ADMIN' } } } })).email;
    const admin = await login(ctx, email);
    await admin.post('/api/auth/users', { email: 'viewer@example.com', displayName: 'V', password: PASSWORD, role: 'VIEWER' }).expect(201);
    await admin.post('/api/auth/users', { email: 'op@example.com', displayName: 'O', password: PASSWORD, role: 'OPERATOR' }).expect(201);
    const viewer = await login(ctx, 'viewer@example.com');
    const operator = await login(ctx, 'op@example.com');

    // Client-supplied role claims are ignored.
    expect((await viewer.post('/api/tasks', { instruction: 'list files in the test folder', roles: ['ADMIN'] })).status).toBe(403);
    expect((await operator.post('/api/auth/users', { email: 'x@example.com', displayName: 'X', password: PASSWORD, role: 'ADMIN' })).status).toBe(403);
    expect((await operator.post('/api/system/emergency-stop/clear', { confirm: true })).status).toBe(403);

    const { body: task } = await admin.post('/api/tasks', { instruction: 'list files in the test folder' }).expect(201);
    expect((await operator.get(`/api/tasks/${task.id}`)).status).toBe(404);
    expect((await operator.post(`/api/tasks/${task.id}/cancel`)).status).toBe(404);
    expect((await operator.get('/api/tasks')).body.total).toBe(0);
  });

  it('pairs agents with single-use codes and rejects bad device tokens', async () => {
    const admin = await login(ctx, (await ctx.prisma.user.findFirstOrThrow({ where: { roles: { some: { roleId: 'ADMIN' } } } })).email);
    const { body: code } = await admin.post('/api/agents/pairing-codes').expect(201);
    await client(ctx).post('/api/agents/pair', { code: code.code, name: 'pc', hostname: 'h' }).expect(201);
    expect((await client(ctx).post('/api/agents/pair', { code: code.code, name: 'pc', hostname: 'h' })).status).toBe(401);
    expect(JSON.stringify(await ctx.prisma.agentDevice.findMany())).not.toContain(code.code);

    const status = await new Promise<number>((resolve) => {
      const ws = new WebSocket(ctx.wsUrl, { headers: { authorization: 'Bearer ' + 'x'.repeat(43) } });
      ws.on('unexpected-response', (_q, res) => resolve(res.statusCode ?? 0));
      ws.on('open', () => resolve(101));
    });
    expect(status).toBe(401);
  });

  it('revoking a device disconnects it and blocks reconnection', async () => {
    const admin = await login(ctx, (await ctx.prisma.user.findFirstOrThrow({ where: { roles: { some: { roleId: 'ADMIN' } } } })).email);
    const { agent, deviceId } = await pairFakeAgent(ctx, admin);
    const devices = (await admin.get('/api/agents')).body as Array<{ id: string; connected: boolean }>;
    expect(devices.find((d) => d.id === deviceId)?.connected).toBe(true);
    await admin.post(`/api/agents/${deviceId}/revoke`).expect(200);
    await new Promise((r) => setTimeout(r, 200));
    expect(agent.received.some((m) => m.type === 'revoked')).toBe(true);
    await expect(agent.connect()).rejects.toThrow('HTTP 401');
  });

  it('dashboard WebSocket requires a session and an allowed origin', async () => {
    const url = ctx.wsUrl.replace('/ws/agent', '/ws/events');
    const noAuth = await new Promise<number>((resolve) => {
      const ws = new WebSocket(url, { headers: { origin: 'http://127.0.0.1:5173' } });
      ws.on('unexpected-response', (_q, res) => resolve(res.statusCode ?? 0));
      ws.on('open', () => resolve(101));
    });
    expect(noAuth).toBe(401);
    const badOrigin = await new Promise<number>((resolve) => {
      const ws = new WebSocket(url, { headers: { origin: 'https://evil.example' } });
      ws.on('unexpected-response', (_q, res) => resolve(res.statusCode ?? 0));
      ws.on('open', () => resolve(101));
    });
    expect(badOrigin).toBe(403);
  });
});
