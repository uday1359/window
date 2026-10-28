import { expect, test } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '../server/src/generated/prisma/client';
import { createAdapter } from '../server/src/prisma/prisma.service';
import { AGENT_HOME, APPROVED_TEST_DIR, E2E_DIR, e2eEnv, PYTHON, ROOT } from './stack';

const INSTRUCTION = 'Create hello.txt in the approved test folder containing exactly: Hello from my AI agent. Read the file back and verify its contents.';
const EXPECTED = 'Hello from my AI agent.';
const EMAIL = 'e2e-admin@example.com';
const PASSWORD = 'e2e-acceptance-password';

test('REAL agent: hello.txt is created, read back and verified through the dashboard', async ({ page }) => {
  const agentEnv = { ...process.env, WINAGENT_AGENT_HOME: AGENT_HOME };

  // 1. First-run setup through the dashboard.
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Set up WinAgent' })).toBeVisible();
  await page.getByLabel('Display name').fill('E2E Admin');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create administrator' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  // 2. Pair the real Windows agent with a one-time code shown in the dashboard.
  await page.getByRole('link', { name: 'Agent devices' }).click();
  await page.getByRole('button', { name: 'Create pairing code' }).click();
  const code = (await page.locator('.code-big').innerText()).trim();
  expect(code).toMatch(/^[A-Z2-9]{10}$/);
  execFileSync(PYTHON, ['-m', 'winagent', 'pair', '--code', code], { cwd: join(ROOT, 'agent'), env: agentEnv });
  const agent = spawn(PYTHON, ['-m', 'winagent', 'run', '--headless'], { cwd: join(ROOT, 'agent'), env: agentEnv, stdio: 'ignore' });
  const pidFile = join(E2E_DIR, 'pids.json');
  writeFileSync(pidFile, JSON.stringify([...JSON.parse(readFileSync(pidFile, 'utf8')), agent.pid]));
  await expect(page.getByText('● Connected')).toBeVisible({ timeout: 30_000 });

  // 3. Submit the acceptance task through the dashboard.
  await page.getByRole('link', { name: 'New task' }).click();
  await page.getByLabel('What should the agent do?').fill(INSTRUCTION);
  await page.getByRole('button', { name: 'Submit task' }).click();
  await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/);
  const taskId = page.url().split('/').pop()!;

  // 4. The dashboard shows the actual, verified result.
  await expect(page.locator('[data-status]').first()).toHaveAttribute('data-status', 'SUCCEEDED', { timeout: 60_000 });
  await expect(page.getByText('Verified complete')).toBeVisible();
  const evidenceRow = page.locator('table tr', { hasText: 'contains exactly the expected text' });
  await expect(evidenceRow).toContainText('PASS');
  await expect(evidenceRow).toContainText(EXPECTED);
  await expect(page.getByText('SIMULATED')).toHaveCount(0);

  // 5. Independent check on disk: the test fails if the file is missing or the content is wrong.
  const file = join(APPROVED_TEST_DIR, 'hello.txt');
  expect(existsSync(file)).toBe(true);
  const bytes = readFileSync(file);
  expect(bytes.equals(Buffer.from(EXPECTED, 'utf8'))).toBe(true);

  // 6. MySQL holds the task, real (non-simulated) evidence and the audit trail.
  const prisma = new PrismaClient({ adapter: createAdapter(e2eEnv().DATABASE_URL!) });
  try {
    const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId }, include: { steps: true, evidence: true } });
    expect(task.status).toBe('SUCCEEDED');
    expect(task.steps.map((s) => s.status)).toEqual(['SUCCEEDED', 'SUCCEEDED']);
    expect(task.evidence).toHaveLength(1);
    expect(task.evidence[0]).toMatchObject({ outcome: 'PASS', isSimulated: false, source: 'agent', actual: EXPECTED });
    expect(task.evidence[0].sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    const actions = (await prisma.auditEvent.findMany({ where: { taskId } })).map((a) => a.action);
    for (const a of ['task.create', 'step.succeeded', 'task.verify', 'task.status.succeeded']) expect(actions).toContain(a);
    const audit = JSON.stringify(await prisma.auditEvent.findMany(), (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    expect(audit).not.toContain(PASSWORD);
  } finally {
    await prisma.$disconnect();
  }
});

test('REAL agent: a policy-denied folder is never touched and the task is rejected', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('link', { name: 'Permissions' }).click();
  await page.getByRole('combobox', { name: 'Type', exact: true }).selectOption('FOLDER');
  await page.getByRole('textbox', { name: 'Value', exact: true }).fill('test:private');
  await page.getByRole('combobox', { name: 'Effect', exact: true }).selectOption('DENY');
  await page.getByRole('button', { name: 'Add policy' }).click();
  await expect(page.getByText('Policy added')).toBeVisible();

  await page.getByRole('link', { name: 'New task' }).click();
  await page.getByLabel('What should the agent do?').fill('Create private/secret-plan.txt in the test folder containing do not write');
  await page.getByRole('button', { name: 'Submit task' }).click();
  await expect(page.locator('[data-status]').first()).toHaveAttribute('data-status', 'REJECTED', { timeout: 30_000 });
  await expect(page.getByText(/denied by policy/)).toBeVisible();
  expect(existsSync(join(APPROVED_TEST_DIR, 'private', 'secret-plan.txt'))).toBe(false);
});
