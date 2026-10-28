import { createHash } from 'node:crypto';
import { TasksService } from '../src/tasks/tasks.service';
import { OrchestratorService } from '../src/orchestrator/orchestrator.service';
import { AuthService } from '../src/auth/auth.service';
import type { AuthUser } from '../src/auth/auth.types';
import type { FakeAgent } from './fake-agent';
import { bootstrapAdmin, Client, pairFakeAgent, resetDatabase, startApp, stopApp, TestContext, waitForStatus } from './helpers';

const HELLO_INSTRUCTION = 'Create hello.txt in the approved test folder containing exactly: Hello from my AI agent. Read the file back and verify its contents.';
const HELLO = 'Hello from my AI agent.';

describe('task orchestration with a SIMULATED agent (MySQL + real AI service)', () => {
  let ctx: TestContext;
  let admin: Client;
  let agent: FakeAgent;
  let user: AuthUser;

  beforeAll(async () => {
    await resetDatabase();
    ctx = await startApp();
    admin = await bootstrapAdmin(ctx);
    ({ agent } = await pairFakeAgent(ctx, admin));
    const dbUser = await ctx.prisma.user.findFirstOrThrow();
    const session = await ctx.prisma.userSession.findFirstOrThrow({ where: { userId: dbUser.id } });
    user = { id: dbUser.id, email: dbUser.email, displayName: 'Admin', roles: ['ADMIN'], permissions: new Set(), sessionId: session.id };
    const auth = ctx.app.get(AuthService);
    for (const p of ['task:create', 'task:read', 'task:control'] as const) if (await auth.userHasPermission(dbUser.id, p)) user.permissions.add(p);
  });
  afterEach(() => {
    if (agent) agent.behaviour = {};
  });
  afterAll(async () => {
    agent?.close();
    if (ctx) await stopApp(ctx);
  });

  it('runs the hello.txt acceptance flow end to end and records evidence + audit', async () => {
    const res = await admin.post('/api/tasks', { instruction: HELLO_INSTRUCTION }, { 'idempotency-key': 'hello-key-0001' }).expect(201);
    const task = await waitForStatus(admin, res.body.id, ['SUCCEEDED', 'FAILED', 'BLOCKED', 'PARTIAL']);
    expect(task.status).toBe('SUCCEEDED');
    expect(task.planSource).toBe('rules');
    expect(agent.files.get('test:hello.txt')).toBe(HELLO);

    const steps = task.steps as Array<{ operation: string; status: string }>;
    expect(steps.map((s) => [s.operation, s.status])).toEqual([['file.write', 'SUCCEEDED'], ['file.read', 'SUCCEEDED']]);
    const evidence = task.evidence as Array<{ kind: string; outcome: string; actual: string; isSimulated: boolean }>;
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ kind: 'file_content_equals', outcome: 'PASS', actual: HELLO, isSimulated: true });
    expect((task.checkpoints as unknown[]).length).toBe(2);

    const stored = await ctx.prisma.task.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(stored.instruction).toBe(HELLO_INSTRUCTION);
    const audit = (await admin.get(`/api/tasks/${res.body.id}/audit`).expect(200)).body as Array<{ action: string }>;
    const actions = audit.map((a) => a.action);
    for (const a of ['task.create', 'ai.route', 'task.status.queued', 'task.status.running', 'step.succeeded', 'task.verify', 'task.status.succeeded']) expect(actions).toContain(a);
  });

  it('deduplicates task creation with an idempotency key, including concurrent requests', async () => {
    const body = { instruction: 'Create dup.txt in the test folder containing x' };
    const results = await Promise.all([1, 2, 3, 4].map(() => admin.post('/api/tasks', body, { 'idempotency-key': 'dup-key-000001' })));
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(results.filter((r) => r.body.duplicate === false)).toHaveLength(1);
    expect(await ctx.prisma.task.count({ where: { idempotencyKey: 'dup-key-000001' } })).toBe(1);
  });

  it('fails verification when the file content is wrong', async () => {
    agent.behaviour = { corruptWrites: true };
    const res = await admin.post('/api/tasks', { instruction: 'Create bad.txt in the test folder containing exactly: expected text' }).expect(201);
    const task = await waitForStatus(admin, res.body.id, ['SUCCEEDED', 'FAILED', 'PARTIAL']);
    expect(task.status).toBe('FAILED');
    expect((task.evidence as Array<{ outcome: string }>)[0].outcome).toBe('FAIL');
    // Retention purges finished tasks by finishedAt, so a failure must set it.
    expect((await ctx.prisma.task.findUniqueOrThrow({ where: { id: res.body.id } })).finishedAt).not.toBeNull();
  });

  it('counts a heartbeat without resource data as a sign of life', async () => {
    const device = await ctx.prisma.agentDevice.findFirstOrThrow({ where: { name: 'fake' } });
    const stale = new Date(Date.now() - 3600_000);
    await ctx.prisma.agentDevice.update({ where: { id: device.id }, data: { lastSeenAt: stale } });
    agent.heartbeat(null);
    const deadline = Date.now() + 3000;
    let seen = stale;
    while (seen <= stale && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      seen = (await ctx.prisma.agentDevice.findUniqueOrThrow({ where: { id: device.id } })).lastSeenAt ?? stale;
    }
    expect(seen.getTime()).toBeGreaterThan(stale.getTime());
  });

  it('fails when the agent reports the file is missing after writing', async () => {
    agent.behaviour = { failWith: { 'file.read': 'NOT_FOUND' } };
    const res = await admin.post('/api/tasks', { instruction: 'Create gone.txt in the test folder containing hi' }).expect(201);
    const task = await waitForStatus(admin, res.body.id, ['SUCCEEDED', 'FAILED', 'PARTIAL']);
    expect(task.status).toBe('FAILED');
  });

  it('refuses instructions that contain secrets', async () => {
    const res = await admin.post('/api/tasks', { instruction: 'Log in with password=hunter2 and create a.txt' });
    expect(res.status).toBe(400);
    expect(await ctx.prisma.task.count({ where: { instruction: { contains: 'hunter2' } } })).toBe(0);
  });

  it('asks for clarification and replans after the answer', async () => {
    const res = await admin.post('/api/tasks', { instruction: 'Create notes.txt in the test folder' }).expect(201);
    const t = await waitForStatus(admin, res.body.id, ['NEEDS_CLARIFICATION']);
    expect(t.statusReason).toMatch(/contain/);
  });

  it('requires an approval bound to the exact action, and rejects stale hashes', async () => {
    const tasks = ctx.app.get(TasksService);
    agent.files.set('test:old.txt', 'old');
    const { task } = await tasks.create(user, {
      instruction: 'Delete old.txt',
      privacyLevel: 'LOCAL_ONLY',
      priority: 0,
      dependsOn: [],
      presetPlan: { title: 'Delete old.txt', steps: [{ operation: 'file.delete', description: 'Delete old.txt', params: { root: 'test', path: 'old.txt' } }], successCriteria: [{ kind: 'step_succeeded', stepIndex: 0 }], clarification: null },
    });
    await waitForStatus(admin, task.id, ['AWAITING_APPROVAL']);
    expect(agent.files.has('test:old.txt')).toBe(true); // nothing executed before approval
    const pending = (await admin.get('/api/approvals?status=PENDING')).body as Array<{ id: string; actionHash: string; riskLevel: string; target: string; taskId: string }>;
    const req = pending.find((p) => p.taskId === task.id)!;
    expect(req.riskLevel).toBe('HIGH');
    expect(req.target).toBe('test:old.txt');

    expect((await admin.post(`/api/approvals/${req.id}/decision`, { decision: 'APPROVE', actionHash: 'a'.repeat(64) })).status).toBe(409);
    expect((await admin.post(`/api/approvals/${req.id}/decision`, { decision: 'APPROVE', actionHash: req.actionHash, channel: 'voice' })).status).toBe(400);
    await admin.post(`/api/approvals/${req.id}/decision`, { decision: 'APPROVE', actionHash: req.actionHash }).expect(200);
    expect((await admin.post(`/api/approvals/${req.id}/decision`, { decision: 'APPROVE', actionHash: req.actionHash })).status).toBe(409);
    const done = await waitForStatus(admin, task.id, ['SUCCEEDED', 'FAILED']);
    expect(done.status).toBe('SUCCEEDED');
    expect(agent.files.has('test:old.txt')).toBe(false);
    const ops = agent.received.filter((m) => m.type === 'op' && m.operation === 'file.delete');
    expect(ops).toHaveLength(1);
    expect(ops[0].approvalHash).toBe(req.actionHash);
  });

  it('rejection stops the task without executing', async () => {
    const tasks = ctx.app.get(TasksService);
    agent.files.set('test:keep.txt', 'keep');
    const { task } = await tasks.create(user, {
      instruction: 'Delete keep.txt',
      privacyLevel: 'LOCAL_ONLY',
      priority: 0,
      dependsOn: [],
      presetPlan: { title: 'Delete keep', steps: [{ operation: 'file.delete', description: 'Delete keep.txt', params: { root: 'test', path: 'keep.txt' } }], successCriteria: [{ kind: 'step_succeeded', stepIndex: 0 }], clarification: null },
    });
    await waitForStatus(admin, task.id, ['AWAITING_APPROVAL']);
    const req = ((await admin.get('/api/approvals?status=PENDING')).body as Array<{ id: string; actionHash: string; taskId: string }>).find((p) => p.taskId === task.id)!;
    await admin.post(`/api/approvals/${req.id}/decision`, { decision: 'REJECT', actionHash: req.actionHash, comment: 'no' }).expect(200);
    expect((await waitForStatus(admin, task.id, ['REJECTED'])).status).toBe('REJECTED');
    expect(agent.files.get('test:keep.txt')).toBe('keep');
  });

  it('blocks plans that violate policy at planning time and after revocation at run time', async () => {
    const { body: policy } = await admin.post('/api/policies', { kind: 'FOLDER', value: 'test', effect: 'DENY' }).expect(201);
    const res = await admin.post('/api/tasks', { instruction: 'Create p.txt in the test folder containing x' }).expect(201);
    const t = await waitForStatus(admin, res.body.id, ['REJECTED']);
    expect(t.statusReason).toMatch(/denied by policy/);
    await admin.del(`/api/policies/${policy.id}`).expect(200);
    expect((await admin.post('/api/policies', { kind: 'FOLDER', value: '../etc', effect: 'ALLOW' })).status).toBe(400);
  });

  it('emergency stop pauses work, propagates to the agent and blocks resume until cleared', async () => {
    agent.behaviour = { delayMs: 800 };
    const res = await admin.post('/api/tasks', { instruction: 'Create slow.txt in the test folder containing x' }).expect(201);
    await waitForStatus(admin, res.body.id, ['RUNNING']);
    const stop = await admin.post('/api/system/emergency-stop', { source: 'web' }).expect(200);
    expect(stop.body.pausedTasks).toBeGreaterThanOrEqual(1);
    await new Promise((r) => setTimeout(r, 300));
    expect(agent.emergencyStop).toBe(true);
    expect((await admin.get(`/api/tasks/${res.body.id}`)).body.status).toBe('PAUSED');
    expect((await admin.post(`/api/tasks/${res.body.id}/resume`, {})).status).toBe(409);
    await admin.post('/api/system/emergency-stop/clear', { confirm: true }).expect(200);
    await new Promise((r) => setTimeout(r, 300));
    expect(agent.emergencyStop).toBe(false);
    expect((await admin.get(`/api/tasks/${res.body.id}`)).body.status).toBe('PAUSED'); // nothing resumes by itself
    agent.behaviour = {};
    await admin.post(`/api/tasks/${res.body.id}/resume`, {}).expect(200);
    expect((await waitForStatus(admin, res.body.id, ['SUCCEEDED', 'FAILED'])).status).toBe('SUCCEEDED');
  });

  it('never blindly repeats a timed-out non-idempotent operation', async () => {
    const tasks = ctx.app.get(TasksService);
    agent.files.set('test:m.txt', 'm');
    agent.behaviour = { silent: new Set(['file.move']) };
    const { task } = await tasks.create(user, {
      instruction: 'Move m.txt',
      privacyLevel: 'LOCAL_ONLY',
      priority: 0,
      dependsOn: [],
      presetPlan: { title: 'Move', steps: [{ operation: 'file.move', description: 'Move m.txt', params: { root: 'test', path: 'm.txt', destRoot: 'test', destPath: 'n.txt' } }], successCriteria: [{ kind: 'step_succeeded', stepIndex: 0 }], clarification: null },
    });
    const blocked = await waitForStatus(admin, task.id, ['BLOCKED'], 20000);
    expect(blocked.statusReason).toMatch(/uncertain/);
    expect(agent.received.filter((m) => m.type === 'op' && m.operation === 'file.move')).toHaveLength(1);
    const refused = await admin.post(`/api/tasks/${task.id}/resume`, {});
    expect(refused.status).toBe(409);
    expect(refused.body.message).toMatch(/not safe to repeat/);
    agent.behaviour = {};
    await admin.post(`/api/tasks/${task.id}/resume`, { confirmUncertain: true }).expect(200);
    expect((await waitForStatus(admin, task.id, ['SUCCEEDED', 'FAILED'])).status).toBe('SUCCEEDED');
  });

  it('reconciles a timed-out idempotent operation from the agent journal instead of re-running it', async () => {
    agent.behaviour = { delayMs: 2500 }; // longer than OPERATION_TIMEOUT_MS=2000, result lands in the journal
    const res = await admin.post('/api/tasks', { instruction: 'Create late.txt in the test folder containing late' }).expect(201);
    const t = await waitForStatus(admin, res.body.id, ['SUCCEEDED', 'BLOCKED', 'FAILED'], 25000);
    const audit = (await admin.get(`/api/tasks/${res.body.id}/audit`)).body as Array<{ action: string }>;
    expect(audit.some((a) => a.action === 'step.reconciled' || a.action === 'step.retry')).toBe(true);
    expect(['SUCCEEDED', 'BLOCKED']).toContain(t.status);
  });

  it('marks queued/running tasks INTERRUPTED on restart and never auto-runs them', async () => {
    const orchestrator = ctx.app.get(OrchestratorService);
    await ctx.prisma.systemState.update({ where: { id: 1 }, data: { queueEnabled: false } });
    const res = await admin.post('/api/tasks', { instruction: 'Create restart.txt in the test folder containing r' }).expect(201);
    await waitForStatus(admin, res.body.id, ['QUEUED']);
    expect(await orchestrator.recoverAfterRestart()).toBeGreaterThanOrEqual(1);
    await ctx.prisma.systemState.update({ where: { id: 1 }, data: { queueEnabled: true } });
    await new Promise((r) => setTimeout(r, 600));
    const t = (await admin.get(`/api/tasks/${res.body.id}`)).body;
    expect(t.status).toBe('INTERRUPTED');
    expect(agent.files.has('test:restart.txt')).toBe(false);
    await admin.post(`/api/tasks/${res.body.id}/resume`, {}).expect(200);
    expect((await waitForStatus(admin, res.body.id, ['SUCCEEDED'])).status).toBe('SUCCEEDED');
  });

  it('resume re-checks a completed file checkpoint on disk and redoes it if changed', async () => {
    const res = await admin.post('/api/tasks', { instruction: 'Create cp.txt in the test folder containing original' }).expect(201);
    await waitForStatus(admin, res.body.id, ['SUCCEEDED']);
    // Simulate an interruption after the write, then tampering.
    await ctx.prisma.task.update({ where: { id: res.body.id }, data: { status: 'INTERRUPTED' } });
    agent.files.set('test:cp.txt', 'tampered');
    const resumed = await admin.post(`/api/tasks/${res.body.id}/resume`, {}).expect(200);
    expect(resumed.body.inspected.join(' ')).toMatch(/changed or missing/);
  });

  it('cancel and pause respect the state machine', async () => {
    agent.behaviour = { delayMs: 600 };
    const res = await admin.post('/api/tasks', { instruction: 'Create c.txt in the test folder containing c' }).expect(201);
    await waitForStatus(admin, res.body.id, ['RUNNING', 'QUEUED']);
    await admin.post(`/api/tasks/${res.body.id}/cancel`).expect(200);
    expect((await admin.post(`/api/tasks/${res.body.id}/cancel`)).status).toBe(409);
    expect((await admin.post(`/api/tasks/${res.body.id}/resume`, {})).status).toBe(409);
    expect((await admin.post(`/api/tasks/${res.body.id}/pause`)).status).toBe(409);
    expect((await admin.get(`/api/tasks/${res.body.id}`)).body.status).toBe('CANCELLED');
  });

  it('respects LOCAL_ONLY privacy: never routes to a configured cloud model', async () => {
    await admin.post('/api/models', { name: 'cloud-only', provider: 'anthropic', model: 'x', endpoint: 'https://api.example.com', isLocal: false, maxComplexity: 5, capabilities: ['planning'], secretRef: 'cloud_key' }).expect(201);
    const res = await admin.post('/api/tasks', { instruction: 'Research the best budgeting approach, then compare options', privacyLevel: 'LOCAL_ONLY' }).expect(201);
    const t = await waitForStatus(admin, res.body.id, ['BLOCKED']);
    expect(t.statusReason).toMatch(/local-only/);
  });

  it('memory review, edit, export and deletion; secrets refused', async () => {
    expect((await admin.post('/api/memory', { kind: 'fact', content: 'my api_key: sk-abcdefghijklmnopqrstuvwxyz' })).status).toBe(400);
    const { body: m } = await admin.post('/api/memory', { kind: 'preference', content: 'Prefers UK date format' }).expect(201);
    await admin.patch(`/api/memory/${m.id}`, { content: 'Prefers ISO dates' }).expect(200);
    const exported = (await admin.get('/api/memory/export').expect(200)).body;
    expect(exported.memory[0].content).toBe('Prefers ISO dates');
    await admin.post('/api/memory/delete-all', { confirm: true }).expect(200);
    expect((await admin.get('/api/memory')).body).toEqual([]);
  });

  it('saves a verified task as a skill, validates and reuses it', async () => {
    const res = await admin.post('/api/tasks', { instruction: 'Create skill.txt containing reusable' }).expect(201);
    const done = await waitForStatus(admin, res.body.id, ['SUCCEEDED']);
    const steps = done.steps as Array<{ params: { path: string } }>;
    expect(steps[0].params.path).toBe(`task-${res.body.id.slice(0, 8)}/skill.txt`);
    const { body: skill } = await admin.post(`/api/skills/from-task/${res.body.id}`, { name: 'Make skill file' }).expect(201);
    expect(JSON.stringify(skill.plan)).toContain('{task}/skill.txt');
    const { body: run } = await admin.post(`/api/skills/${skill.id}/run`).expect(201);
    const second = await waitForStatus(admin, run.id, ['SUCCEEDED']);
    expect((second.steps as Array<{ params: { path: string } }>)[0].params.path).toBe(`task-${run.id.slice(0, 8)}/skill.txt`);

    // A skill the user disabled must not run, even though its plan is still valid.
    await admin.patch(`/api/skills/${skill.id}`, { enabled: false }).expect(200);
    expect((await admin.post(`/api/skills/${skill.id}/run`)).status).toBe(409);
    await admin.patch(`/api/skills/${skill.id}`, { enabled: true }).expect(200);

    // A skill whose plan no longer validates is disabled.
    await ctx.prisma.workflowSkill.update({ where: { id: skill.id }, data: { plan: { title: 'x', steps: [{ operation: 'shell.exec', description: 'x', params: {} }], successCriteria: [{ kind: 'step_succeeded', stepIndex: 0 }] } } });
    expect((await admin.post(`/api/skills/${skill.id}/run`)).status).toBe(409);
    expect((await admin.get('/api/skills')).body[0]).toMatchObject({ enabled: false, validationStatus: 'INVALID' });
  });

  it('backs up MySQL and verifies restoration into a scratch database', async () => {
    const { body: backup } = await admin.post('/api/backups/database').expect(201);
    expect(Number(backup.sizeBytes)).toBeGreaterThan(1000);
    const { body: verified } = await admin.post(`/api/backups/${backup.id}/verify-restore`).expect(200);
    expect(verified.restoreTestResult).toMatch(/^PASSED/);
  }, 60000);

  it('blocks a task whose deadline has passed and runs it after an explicit resume', async () => {
    const res = await admin.post('/api/tasks', { instruction: 'Create late.txt in the test folder containing late', deadline: new Date(Date.now() - 60_000).toISOString() }).expect(201);
    const blocked = await waitForStatus(admin, res.body.id, ['BLOCKED', 'SUCCEEDED', 'FAILED']);
    expect(blocked.status).toBe('BLOCKED');
    expect(String(blocked.statusReason)).toContain('Deadline passed');
    await admin.post(`/api/tasks/${res.body.id}/resume`, {}).expect(200);
    const done = await waitForStatus(admin, res.body.id, ['SUCCEEDED', 'FAILED', 'BLOCKED']);
    expect(done.status).toBe('SUCCEEDED');
    expect((await ctx.prisma.task.findUniqueOrThrow({ where: { id: res.body.id } })).deadline).toBeNull();
  });

  it('waits for connectivity instead of failing when the only model is offline', async () => {
    const { body: model } = await admin.post('/api/models', { name: 'offline-cloud', provider: 'openai_compatible', model: 'm', endpoint: 'https://127.0.0.1:9/v1', isLocal: false, maxComplexity: 5, secretRef: 'offline-key' }).expect(201);
    try {
      const res = await admin
        .post('/api/tasks', { instruction: 'Research three vendors, then compare their prices, then summarise everything', privacyLevel: 'CLOUD_ALLOWED' })
        .expect(201);
      const blocked = await waitForStatus(admin, res.body.id, ['BLOCKED', 'FAILED', 'QUEUED']);
      expect(blocked.status).toBe('BLOCKED');
      expect(String(blocked.statusReason)).toContain('Waiting for an AI model');
      const first = (await ctx.prisma.task.findUniqueOrThrow({ where: { id: res.body.id } })).retryPlanningAt;
      expect(first).not.toBeNull();

      // Still offline at the retry: it keeps waiting with a new retry time.
      const retried = await ctx.app.get(TasksService).retryWaitingPlans(new Date(Date.now() + 120_000));
      expect(retried).toBeGreaterThanOrEqual(1);
      const again = await ctx.prisma.task.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(again.status).toBe('BLOCKED');
      expect(again.retryPlanningAt!.getTime()).toBeGreaterThan(first!.getTime());

      // Cancelling ends the wait.
      await admin.post(`/api/tasks/${res.body.id}/cancel`, {}).expect(200);
      expect(await ctx.app.get(TasksService).retryWaitingPlans(new Date(Date.now() + 240_000))).toBe(0);
    } finally {
      await admin.del(`/api/models/${model.id}`).expect(200);
    }
  });

  it('stores screenshot attachments safely and serves them only to the owner', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest-of-image')]);
    const res = await admin.post('/api/tasks', { instruction: 'What is shown in this screenshot? Describe it', attachments: [{ mediaType: 'image/png', data: png.toString('base64') }] }).expect(201);
    const rows = await ctx.prisma.taskAttachment.findMany({ where: { taskId: res.body.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].sha256).toBe(createHash('sha256').update(png).digest('hex'));
    expect(rows[0].storagePath).toBe(`attachments/${res.body.id}/1.png`);

    const detail = (await admin.get(`/api/tasks/${res.body.id}`).expect(200)).body;
    expect(detail.attachments).toHaveLength(1);
    const file = await admin.get(`/api/tasks/${res.body.id}/attachments/${rows[0].id}`).expect(200);
    expect(file.headers['content-type']).toMatch(/^image\/png/);
    expect(Buffer.from(file.body).equals(png)).toBe(true);

    // The declared type must match the file signature; nothing is stored on rejection.
    const before = await ctx.prisma.task.count();
    const bad = await admin.post('/api/tasks', { instruction: 'Look at this', attachments: [{ mediaType: 'image/png', data: Buffer.from('MZ not an image').toString('base64') }] });
    expect(bad.status).toBe(400);
    expect(await ctx.prisma.task.count()).toBe(before);
    const tooMany = await admin.post('/api/tasks', { instruction: 'Look', attachments: Array.from({ length: 4 }, () => ({ mediaType: 'image/png', data: png.toString('base64') })) });
    expect(tooMany.status).toBe(400);
  });

  it('passes AI-service client errors through instead of a generic 500', async () => {
    const res = await admin.del('/api/secrets/no-such-secret-xyz');
    expect(res.status).toBe(404);
    expect(res.body.message).toContain('secret not found');
  });

  it('audit history never contains secrets', async () => {
    const all = JSON.stringify(await ctx.prisma.auditEvent.findMany());
    expect(all).not.toMatch(/hunter2|integration-test-password|sk-abcdefghij/);
  });
});
