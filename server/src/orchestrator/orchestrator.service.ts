import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown, OnModuleDestroy } from '@nestjs/common';
import { AgentDevice, Prisma, Task, TaskStep } from '../generated/prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PolicyService } from '../policy/policy.service';
import { AgentHubService, AgentUnavailableError, OperationResult, OperationTimeoutError } from '../realtime/agent-hub.service';
import { TaskStateService } from '../tasks/task-state.service';
import { AiClientService, ResearchFindings, ResearchSource } from '../ai/ai-client.service';
import { loadRoutingInputs } from '../ai/routing-inputs';
import { IntegrationsService, IntegrationUncertainError } from '../integrations/integrations.service';
import { actionHash } from '../common/crypto';
import { redact, redactString } from '../common/redact';
import { loadConfig } from '../config/config';
import { getOperation, SuccessCriterion } from '../operations/operations';
import { overallOutcome, verifyCriteria } from './verifier';

type StepOutcome = 'ok' | 'await_approval' | 'blocked' | 'failed' | 'stopped';

/** Agent error codes that are never retried automatically. */
const NON_RETRYABLE = new Set(['POLICY_DENIED', 'INVALID_PARAMS', 'NOT_FOUND', 'ALREADY_EXISTS', 'UNSUPPORTED', 'APPROVAL_MISMATCH', 'PERMISSION_DENIED']);
/** Codes meaning a human must intervene (CAPTCHA, OTP, MFA, identity checks). Never bypassed. */
const HUMAN_INTERVENTION = new Set(['HUMAN_VERIFICATION_REQUIRED']);
const MAX_RESULT_CHARS = 50_000;

function truncateResult(result: OperationResult): Prisma.InputJsonValue {
  const json = JSON.stringify(redact(result));
  if (json.length <= MAX_RESULT_CHARS) return JSON.parse(json);
  return { ok: result.ok, truncated: true, preview: json.slice(0, MAX_RESULT_CHARS) };
}

@Injectable()
export class OrchestratorService implements OnApplicationBootstrap, OnModuleDestroy, OnApplicationShutdown {
  private readonly logger = new Logger('Orchestrator');
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private stopping = false;
  private currentTaskId: string | null = null;
  private currentOperation: { deviceId: string; operationId: string } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
    private readonly approvals: ApprovalsService,
    private readonly notifications: NotificationsService,
    private readonly policy: PolicyService,
    private readonly hub: AgentHubService,
    private readonly state: TaskStateService,
    private readonly ai: AiClientService,
    private readonly integrations: IntegrationsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.recoverAfterRestart();
    const system = await this.prisma.systemState.findUniqueOrThrow({ where: { id: 1 } });
    this.hub.start(system.emergencyStop);
    if (process.env.WINAGENT_DISABLE_ORCHESTRATOR !== '1') {
      this.timer = setInterval(() => void this.tick(), loadConfig().ORCHESTRATOR_TICK_MS);
      this.timer.unref();
    }
  }

  /** Runs during module teardown, before the database connection closes: no new ticks start. */
  onModuleDestroy(): void {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.hub.stop();
  }

  /**
   * FR-21 / safety rule: tasks that were queued or running when the server stopped are
   * never resumed automatically. They become INTERRUPTED and need an explicit resume,
   * which inspects the real state first.
   */
  async recoverAfterRestart(): Promise<number> {
    const stale = await this.prisma.task.findMany({ where: { status: { in: ['PLANNING', 'QUEUED', 'RUNNING'] } }, select: { id: true } });
    for (const t of stale) {
      await this.prisma.taskStep.updateMany({ where: { taskId: t.id, status: 'RUNNING' }, data: { status: 'UNCERTAIN' } });
      await this.prisma.taskExecution.updateMany({ where: { taskId: t.id, status: { in: ['DISPATCHED', 'RUNNING'] } }, data: { status: 'UNCERTAIN' } });
      await this.state.transition(t.id, 'INTERRUPTED', { reason: 'Server restarted. Review the task and press Resume to continue.' });
    }
    if (stale.length) this.logger.warn(`${stale.length} task(s) marked INTERRUPTED after restart; none were resumed automatically`);
    return stale.length;
  }

  isBusy(): boolean {
    return this.currentTaskId !== null;
  }

  /** Called by cancel/emergency stop: stops the in-flight agent operation. */
  abortCurrent(taskId?: string): void {
    if (this.currentOperation && (!taskId || this.currentTaskId === taskId)) {
      this.hub.cancel(this.currentOperation.deviceId, this.currentOperation.operationId);
    }
  }

  async tick(): Promise<void> {
    if (this.ticking || this.stopping) return;
    this.ticking = true;
    try {
      const system = await this.prisma.systemState.findUniqueOrThrow({ where: { id: 1 } });
      if (system.emergencyStop || !system.queueEnabled) return;
      const next = await this.nextRunnable();
      if (next) await this.runTask(next);
    } catch (err) {
      this.logger.error(redactString(`Orchestrator tick failed: ${(err as Error).message}`));
    } finally {
      this.ticking = false;
    }
  }

  /** Sequential queue: lowest queuePosition first; dependencies must have succeeded. */
  private async nextRunnable(): Promise<Task | null> {
    const candidates = await this.prisma.task.findMany({
      where: { status: 'QUEUED' },
      orderBy: [{ queuePosition: 'asc' }, { createdAt: 'asc' }],
      take: 25,
      include: { dependsOn: { include: { dependsOn: { select: { status: true, title: true } } } } },
    });
    const now = new Date();
    for (const c of candidates) {
      // FR-03: a task past its deadline is not started late without the user knowing.
      if (c.deadline && c.deadline < now) {
        await this.state.transition(c.id, 'BLOCKED', { from: ['QUEUED'], reason: `Deadline passed (${c.deadline.toISOString()}). Resume to run it anyway, or cancel it.` });
        await this.notifications.notify(c.userId, 'deadline', 'Task deadline passed', `"${c.title}" was not started before its deadline.`, `/tasks/${c.id}`);
        continue;
      }
      const deps = c.dependsOn.map((d) => d.dependsOn);
      const failed = deps.find((d) => ['FAILED', 'CANCELLED', 'REJECTED', 'PARTIAL'].includes(d.status));
      if (failed) {
        await this.state.transition(c.id, 'BLOCKED', { from: ['QUEUED'], reason: `Dependency "${failed.title}" did not succeed` });
        continue;
      }
      if (deps.every((d) => d.status === 'SUCCEEDED')) return c;
    }
    return null;
  }

  async runTask(task: Task): Promise<void> {
    if (!(await this.state.transition(task.id, 'RUNNING', { from: ['QUEUED'], reason: null, data: { startedAt: task.startedAt ?? new Date() } }))) return;
    this.currentTaskId = task.id;
    try {
      const steps = await this.prisma.taskStep.findMany({ where: { taskId: task.id }, orderBy: { index: 'asc' } });
      for (const step of steps) {
        if (step.status === 'SUCCEEDED' || step.status === 'SKIPPED') continue;
        const live = await this.prisma.task.findUniqueOrThrow({ where: { id: task.id } });
        if (live.status !== 'RUNNING') return; // paused or cancelled by the user
        const outcome = await this.executeStep(live, step);
        if (outcome !== 'ok') return;
        const done = await this.prisma.taskStep.count({ where: { taskId: task.id, status: { in: ['SUCCEEDED', 'SKIPPED'] } } });
        const progress = Math.round((done / steps.length) * 90);
        await this.prisma.task.update({ where: { id: task.id }, data: { progress } });
        this.state.publishStep(task.userId, task.id, { id: step.id, index: step.index, status: 'SUCCEEDED' });
      }
      await this.verify(task.id);
    } finally {
      this.currentTaskId = null;
      this.currentOperation = null;
    }
  }

  private async block(task: Task, step: TaskStep | null, reason: string, stepStatus: 'FAILED' | 'UNCERTAIN' | 'PENDING' = 'PENDING'): Promise<'blocked'> {
    if (step) await this.prisma.taskStep.update({ where: { id: step.id }, data: { status: stepStatus, error: reason.slice(0, 1000) } });
    await this.state.transition(task.id, 'BLOCKED', { from: ['RUNNING'], reason });
    await this.notifications.notify(task.userId, 'task', 'Task blocked', `${task.title}: ${reason}`, `/tasks/${task.id}`);
    return 'blocked';
  }

  private async executeStep(task: Task, step: TaskStep): Promise<StepOutcome> {
    const def = getOperation(step.operation);
    if (!def) return this.block(task, step, `Unsupported operation ${step.operation}`, 'FAILED');
    const params = step.params as Record<string, unknown>;

    // Re-validate authorisation immediately before execution (permissions may have been revoked).
    if (!(await this.auth.userHasPermission(task.userId, 'task:create'))) return this.block(task, step, 'Task owner no longer has permission to run tasks');
    // Integration calls run on the server; everything else needs the task's connected agent.
    const serverSide = def.executor === 'server';
    let device: AgentDevice | null = null;
    if (!serverSide) {
      if (!task.agentDeviceId) return this.block(task, step, 'No agent device is assigned. Pair an agent and resume.');
      device = await this.prisma.agentDevice.findUnique({ where: { id: task.agentDeviceId } });
      if (!device || device.status !== 'ACTIVE' || device.ownerId !== task.userId) return this.block(task, step, 'Assigned agent device is revoked or unavailable');
      if (!this.hub.isConnected(device.id)) return this.block(task, step, 'Agent is not connected. Start the agent and press Resume.');
    }

    const policyContext = await this.policy.context(task.userId, device);
    const decision = this.policy.evaluate(policyContext, step.operation, params);
    if (decision.denied) {
      await this.audit.record({ actorType: 'SYSTEM', action: 'policy.deny', targetType: 'step', targetId: step.id, taskId: task.id, outcome: 'DENIED', details: { operation: step.operation, reason: decision.denied } });
      return this.block(task, step, `Blocked by policy: ${decision.denied}`, 'FAILED');
    }

    const hash = actionHash(task.id, step.id, step.operation, params);
    let approvalHash: string | null = null;
    if (decision.requiresApproval || step.requiresApproval) {
      if (!(await this.approvals.findUsableApproval(step.id, hash))) {
        if (await this.state.transition(task.id, 'AWAITING_APPROVAL', { from: ['RUNNING'], reason: `Waiting for approval: ${step.description}` })) {
          await this.approvals.request(task, step, hash, decision);
        }
        return 'await_approval';
      }
      approvalHash = hash;
    }

    // Research picks its pages at run time, so the agent must know which websites are denied.
    const dispatchParams =
      step.operation === 'browser.research'
        ? { ...params, blockedDomains: [...new Set([...((params.blockedDomains as string[] | undefined) ?? []), ...policyContext.rules.filter((r) => r.kind === 'WEBSITE' && r.effect === 'DENY').map((r) => r.value)])] }
        : params;

    let attempts = step.attempts;
    const maxAttempts = def.idempotent ? Math.max(1, step.maxAttempts) : 1;
    while (true) {
      const operationId = randomUUID();
      attempts += 1;
      await this.prisma.$transaction([
        this.prisma.taskStep.update({ where: { id: step.id }, data: { status: 'RUNNING', attempts, startedAt: step.startedAt ?? new Date(), error: null } }),
        this.prisma.taskExecution.create({ data: { taskId: task.id, stepId: step.id, agentDeviceId: device?.id ?? null, operationId, attempt: attempts, approvalHash } }),
      ]);
      this.state.publishStep(task.userId, task.id, { id: step.id, index: step.index, status: 'RUNNING' });
      this.currentOperation = device ? { deviceId: device.id, operationId } : null;

      let result: OperationResult;
      try {
        result = device
          ? await this.hub.dispatch(device.id, { operationId, operation: step.operation, params: dispatchParams, approvalHash, timeoutMs: Math.min(def.timeoutMs, loadConfig().OPERATION_TIMEOUT_MS), taskId: task.id })
          : await this.integrations.execute(step.operation, params);
      } catch (err) {
        if (err instanceof IntegrationUncertainError) {
          // The external service may have acted; there is no journal to ask, so a human decides.
          await this.prisma.taskExecution.update({ where: { operationId }, data: { status: 'UNCERTAIN', error: err.message.slice(0, 1000), finishedAt: new Date() } });
          return this.block(task, step, `Outcome of "${step.description}" is uncertain (the integration did not answer in time). Check the external service, then Resume.`, 'UNCERTAIN');
        }
        if (!device) throw err;
        const timedOut = err instanceof OperationTimeoutError;
        await this.prisma.taskExecution.update({ where: { operationId }, data: { status: timedOut ? 'TIMED_OUT' : 'UNCERTAIN', error: (err as Error).message, finishedAt: new Date() } });
        if (timedOut) {
          // Ask the agent's journal before deciding: never blindly repeat an uncertain operation.
          const status = await this.hub.queryStatus(device.id, operationId);
          if (status.state === 'completed' && status.result) {
            result = status.result;
            await this.audit.record({ actorType: 'SYSTEM', action: 'step.reconciled', targetType: 'step', targetId: step.id, taskId: task.id, outcome: 'INFO', details: { operationId } });
          } else if (def.idempotent && !def.external && attempts < maxAttempts) {
            await this.audit.record({ actorType: 'SYSTEM', action: 'step.retry', targetType: 'step', targetId: step.id, taskId: task.id, outcome: 'INFO', details: { attempt: attempts, reason: 'timeout' } });
            continue;
          } else {
            return this.block(task, step, `Outcome of "${step.description}" is uncertain (timed out). Inspect, then Resume.`, 'UNCERTAIN');
          }
        } else {
          const live = await this.prisma.task.findUnique({ where: { id: task.id } });
          if (live && live.status !== 'RUNNING') {
            await this.prisma.taskStep.update({ where: { id: step.id }, data: { status: 'UNCERTAIN' } });
            return 'stopped';
          }
          return this.block(task, step, `${(err as Error).message}. Resume after the agent reconnects.`, 'UNCERTAIN');
        }
      }

      await this.prisma.taskExecution.update({
        where: { operationId },
        data: { status: result.ok ? 'SUCCEEDED' : result.code === 'CANCELLED' ? 'CANCELLED' : 'FAILED', output: truncateResult(result), error: result.error?.slice(0, 1000), finishedAt: new Date() },
      });

      if (result.ok && step.operation === 'browser.research') result = await this.withFindings(task, String(params.query), result);

      if (result.ok) {
        await this.prisma.$transaction(async (tx) => {
          await tx.taskStep.update({ where: { id: step.id }, data: { status: 'SUCCEEDED', result: truncateResult(result), finishedAt: new Date(), error: null } });
          const fingerprint = typeof result.output?.sha256 === 'string' ? { sha256: result.output.sha256 } : {};
          await tx.taskCheckpoint.create({ data: { taskId: task.id, stepIndex: step.index, state: { operation: step.operation, target: def.target(params as never), ...fingerprint }, verified: true } });
          await this.audit.record({ actorType: device ? 'AGENT' : 'SYSTEM', actorId: device?.id ?? null, action: 'step.succeeded', targetType: 'step', targetId: step.id, taskId: task.id, outcome: 'SUCCESS', details: { operation: step.operation, attempt: attempts } }, tx);
        });
        return 'ok';
      }

      const code = result.code ?? 'ERROR';
      await this.audit.record({ actorType: device ? 'AGENT' : 'SYSTEM', actorId: device?.id ?? null, action: 'step.failed', targetType: 'step', targetId: step.id, taskId: task.id, outcome: 'FAILURE', details: { operation: step.operation, code, error: result.error, attempt: attempts } });
      if (code === 'CANCELLED' || code === 'EMERGENCY_STOP') {
        await this.prisma.taskStep.update({ where: { id: step.id }, data: { status: 'CANCELLED', error: result.error?.slice(0, 1000) } });
        return 'stopped';
      }
      if (HUMAN_INTERVENTION.has(code)) {
        return this.block(task, step, `Human verification required (${result.error ?? 'CAPTCHA/OTP/MFA'}). Complete it yourself in the agent browser, then Resume.`);
      }
      if (!NON_RETRYABLE.has(code) && def.idempotent && !def.external && attempts < maxAttempts) {
        await this.audit.record({ actorType: 'SYSTEM', action: 'step.retry', targetType: 'step', targetId: step.id, taskId: task.id, outcome: 'INFO', details: { attempt: attempts, code } });
        await new Promise((r) => setTimeout(r, Math.min(4000, 250 * 2 ** attempts)));
        continue;
      }
      await this.prisma.taskStep.update({ where: { id: step.id }, data: { status: 'FAILED', error: (result.error ?? code).slice(0, 1000), finishedAt: new Date() } });
      this.state.publishStep(task.userId, task.id, { id: step.id, index: step.index, status: 'FAILED', error: result.error });
      const anySucceeded = (await this.prisma.taskStep.count({ where: { taskId: task.id, status: 'SUCCEEDED' } })) > 0;
      await this.state.transition(task.id, 'FAILED', { from: ['RUNNING'], reason: `Step ${step.index + 1} failed: ${result.error ?? code}${anySucceeded ? ' (earlier steps completed)' : ''}` });
      await this.notifications.notify(task.userId, 'task', 'Task failed', `${task.title}: ${result.error ?? code}`, `/tasks/${task.id}`);
      return 'failed';
    }
  }

  /**
   * FR-18: adds cited claims to a research result. Synthesis failing never fails the step:
   * the sources stay available and the note says why there is no summary.
   */
  private async withFindings(task: Task, question: string, result: OperationResult): Promise<OperationResult> {
    const raw = Array.isArray(result.output?.sources) ? (result.output!.sources as Array<Record<string, unknown>>) : [];
    const sources: ResearchSource[] = raw.map((s) => ({
      id: String(s.id),
      url: String(s.url),
      title: String(s.title ?? ''),
      domain: String(s.domain),
      trust: s.trust === 'official' || s.trust === 'reference' ? s.trust : 'general',
      text: String(s.text ?? '').slice(0, 8000),
    }));
    let findings: ResearchFindings;
    try {
      const { models, costLimitUsd } = await loadRoutingInputs(this.prisma, task.userId);
      findings = await this.ai.synthesize({ question, sources, privacyLevel: task.privacyLevel, models, costLimitUsd });
    } catch (err) {
      findings = { claims: [], model: null, note: `Sources were retrieved, but no model could summarise them (${redactString((err as Error).message).slice(0, 300)}). Review the sources directly.` };
    }
    await this.audit.record({ actorType: 'SYSTEM', action: 'research.synthesize', targetType: 'task', targetId: task.id, taskId: task.id, outcome: 'INFO', details: { model: findings.model, claims: findings.claims.length, verified: findings.claims.filter((c) => c.status === 'verified').length } });
    return { ...result, output: { ...result.output, findings } };
  }

  /** Re-checks the success criteria against real evidence and records the final status. */
  async verify(taskId: string): Promise<void> {
    const task = await this.prisma.task.findUniqueOrThrow({ where: { id: taskId }, include: { steps: { orderBy: { index: 'asc' } } } });
    if (task.status !== 'RUNNING') return;
    const criteria = (task.successCriteria ?? []) as SuccessCriterion[];
    const deviceId = task.agentDeviceId;
    const probe = async (operation: string, params: Record<string, unknown>) => {
      if (!deviceId) throw new AgentUnavailableError('No agent');
      return this.hub.dispatch(deviceId, { operationId: randomUUID(), operation, params, approvalHash: null, timeoutMs: Math.min(15_000, loadConfig().OPERATION_TIMEOUT_MS), taskId });
    };
    const evidence = await verifyCriteria(criteria, task.steps.map((s) => ({ index: s.index, operation: s.operation, status: s.status, result: s.result })), probe);
    const outcome = overallOutcome(evidence);
    const reasons: Record<typeof outcome, string> = {
      SUCCEEDED: 'All success criteria verified with evidence',
      PARTIAL: 'Some success criteria could not be verified',
      FAILED: 'Verification failed: the result does not meet the success criteria',
      BLOCKED: 'Verification inconclusive: evidence could not be collected. Resume to retry verification.',
    };
    await this.prisma.$transaction(async (tx) => {
      await tx.verificationEvidence.createMany({
        data: evidence.map((e) => ({
          taskId,
          criterion: e.criterion.slice(0, 500),
          kind: e.kind,
          outcome: e.outcome,
          expected: e.expected,
          actual: e.actual === null ? null : redactString(e.actual),
          sha256: e.sha256 && /^[0-9a-f]{64}$/.test(e.sha256) ? e.sha256 : null,
          source: e.source,
          isSimulated: e.isSimulated,
        })),
      });
      await this.audit.record({ actorType: 'SYSTEM', action: 'task.verify', targetType: 'task', targetId: taskId, taskId, outcome: outcome === 'SUCCEEDED' ? 'SUCCESS' : 'FAILURE', details: { outcome, criteria: evidence.map((e) => ({ kind: e.kind, outcome: e.outcome, simulated: e.isSimulated })) } }, tx);
      await this.state.transition(taskId, outcome, { from: ['RUNNING'], reason: reasons[outcome], data: { progress: outcome === 'SUCCEEDED' ? 100 : task.progress }, tx });
    });
    await this.notifications.notify(task.userId, 'task', outcome === 'SUCCEEDED' ? 'Task verified' : `Task ${outcome.toLowerCase()}`, `${task.title}: ${reasons[outcome]}`, `/tasks/${taskId}`);
  }
}
