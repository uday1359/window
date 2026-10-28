import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, PrivacyLevel, RiskLevel, Task, TaskStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AiClientService, AiServiceError } from '../ai/ai-client.service';
import { loadRoutingInputs } from '../ai/routing-inputs';
import { AttachmentInput, AttachmentsService } from './attachments.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { PolicyService } from '../policy/policy.service';
import { overallRisk } from '../policy/policy';
import { AgentHubService } from '../realtime/agent-hub.service';
import { OrchestratorService } from '../orchestrator/orchestrator.service';
import { TaskStateService } from './task-state.service';
import { NotificationsService } from '../notifications/notifications.service';
import { containsSecret, redactString } from '../common/redact';
import { sha256 } from '../common/crypto';
import { getOperation, operationCatalog, PlanValidationError, substituteTaskFolder, validatePlan, ValidatedPlan } from '../operations/operations';
import { AuthUser, can } from '../auth/auth.types';
import { PAUSABLE, RESUMABLE, TERMINAL } from './task-state';

export interface CreateTaskInput {
  instruction: string;
  title?: string;
  privacyLevel: PrivacyLevel;
  priority: number;
  deadline?: Date;
  dependsOn: string[];
  agentDeviceId?: string;
  idempotencyKey?: string;
  presetPlan?: ValidatedPlan;
  skillId?: string;
  attachments?: AttachmentInput[];
}

/** How long a task waits for connectivity before planning is retried (FR-14). */
export const PLAN_RETRY_MS = 60_000;
const PLAN_RETRY_SCAN_MS = 15_000;

@Injectable()
export class TasksService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Tasks');
  private retryTimer?: NodeJS.Timeout;
  private retrying = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly ai: AiClientService,
    private readonly policy: PolicyService,
    private readonly hub: AgentHubService,
    private readonly orchestrator: OrchestratorService,
    private readonly state: TaskStateService,
    private readonly notifications: NotificationsService,
    private readonly attachments: AttachmentsService,
    private readonly integrations: IntegrationsService,
  ) {}

  onApplicationBootstrap(): void {
    // Same switch as the orchestrator: tests drive planning explicitly.
    if (process.env.WINAGENT_DISABLE_ORCHESTRATOR === '1') return;
    this.retryTimer = setInterval(() => void this.retryWaitingPlans(), PLAN_RETRY_SCAN_MS);
    this.retryTimer.unref();
  }

  onApplicationShutdown(): void {
    if (this.retryTimer) clearInterval(this.retryTimer);
  }

  /**
   * FR-14: re-plans tasks that were waiting for a model or the AI service. Planning only produces
   * a plan; policy and approvals still apply before anything runs. Paused by emergency stop.
   */
  async retryWaitingPlans(now = new Date()): Promise<number> {
    if (this.retrying) return 0;
    this.retrying = true;
    try {
      const system = await this.prisma.systemState.findUniqueOrThrow({ where: { id: 1 } });
      if (system.emergencyStop) return 0;
      const due = await this.prisma.task.findMany({ where: { status: 'BLOCKED', retryPlanningAt: { lte: now } }, select: { id: true }, take: 10 });
      for (const t of due) await this.plan(t.id);
      return due.length;
    } catch (err) {
      this.logger.error(redactString(`Planning retry failed: ${(err as Error).message}`));
      return 0;
    } finally {
      this.retrying = false;
    }
  }

  /** Loads a task enforcing ownership; admins with task:read_all may read any task. */
  async getOwned(user: AuthUser, id: string, forControl = false): Promise<Task> {
    const task = await this.prisma.task.findUnique({ where: { id } });
    if (!task) throw new NotFoundException('Task not found');
    if (task.userId !== user.id && (forControl || !can(user, 'task:read_all'))) throw new NotFoundException('Task not found');
    return task;
  }

  async create(user: AuthUser, input: CreateTaskInput): Promise<{ task: Task; duplicate: boolean }> {
    if (containsSecret(input.instruction)) {
      throw new BadRequestException('The instruction appears to contain a password, token or key. Remove it: secrets are never stored or sent to AI models.');
    }
    if (input.idempotencyKey) {
      const existing = await this.prisma.task.findUnique({ where: { userId_idempotencyKey: { userId: user.id, idempotencyKey: input.idempotencyKey } } });
      if (existing) return { task: existing, duplicate: true };
    }
    if (input.dependsOn.length) {
      const owned = await this.prisma.task.count({ where: { id: { in: input.dependsOn }, userId: user.id } });
      if (owned !== new Set(input.dependsOn).size) throw new BadRequestException('Dependencies must be your own existing tasks');
    }
    // Validated before anything is stored, so a bad image never leaves a half-created task.
    const attachments = this.attachments.decode(input.attachments ?? []);
    let deviceId = input.agentDeviceId ?? null;
    if (deviceId) {
      const device = await this.prisma.agentDevice.findFirst({ where: { id: deviceId, ownerId: user.id, status: 'ACTIVE' } });
      if (!device) throw new BadRequestException('Agent device not found or revoked');
    } else {
      const devices = await this.prisma.agentDevice.findMany({ where: { ownerId: user.id, status: 'ACTIVE' }, orderBy: { lastSeenAt: 'desc' } });
      deviceId = devices.find((d) => this.hub.isConnected(d.id))?.id ?? devices[0]?.id ?? null;
    }

    let task: Task;
    try {
      task = await this.prisma.$transaction(async (tx) => {
        const created = await tx.task.create({
          data: {
            userId: user.id,
            title: (input.title ?? input.instruction).replace(/\s+/g, ' ').trim().slice(0, 200),
            instruction: input.instruction,
            privacyLevel: input.privacyLevel,
            priority: input.priority,
            deadline: input.deadline,
            idempotencyKey: input.idempotencyKey,
            agentDeviceId: deviceId,
            skillId: input.skillId,
            dependsOn: { create: input.dependsOn.map((id) => ({ dependsOnTaskId: id })) },
          },
        });
        await this.audit.record({ actorType: 'USER', actorId: user.id, action: 'task.create', targetType: 'task', targetId: created.id, taskId: created.id, outcome: 'SUCCESS', details: { privacyLevel: input.privacyLevel, fromSkill: input.skillId ?? null, attachments: attachments.length } }, tx);
        return created;
      });
    } catch (err) {
      // Concurrent duplicate submission with the same idempotency key.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002' && input.idempotencyKey) {
        const existing = await this.prisma.task.findUniqueOrThrow({ where: { userId_idempotencyKey: { userId: user.id, idempotencyKey: input.idempotencyKey } } });
        return { task: existing, duplicate: true };
      }
      throw err;
    }
    try {
      await this.attachments.save(task.id, attachments);
    } catch (err) {
      // The task must not exist without the screenshots the user attached.
      await this.prisma.task.delete({ where: { id: task.id } });
      this.logger.error(redactString(`Saving attachments failed: ${(err as Error).message}`));
      throw new BadRequestException('The screenshots could not be stored. Check STORAGE_DIR and try again.');
    }
    void this.plan(task.id, input.presetPlan).catch((err) => this.logger.error(redactString(`Planning crashed for ${task.id}: ${(err as Error).message}`)));
    return { task, duplicate: false };
  }

  /** Generates (or applies a preset) plan, validates it and evaluates policy. */
  async plan(taskId: string, presetPlan?: ValidatedPlan): Promise<void> {
    if (!(await this.state.transition(taskId, 'PLANNING', { from: ['PENDING', 'NEEDS_CLARIFICATION', 'BLOCKED', 'FAILED', 'PAUSED', 'INTERRUPTED'], reason: 'Generating plan', data: { retryPlanningAt: null } }))) return;
    const task = await this.prisma.task.findUniqueOrThrow({ where: { id: taskId }, include: { agentDevice: true } });
    const device = task.agentDevice && task.agentDevice.status === 'ACTIVE' ? task.agentDevice : null;
    const roots = Array.isArray(device?.allowedRoots) ? (device!.allowedRoots as string[]) : [];
    const apps = Array.isArray((device?.capabilities as { apps?: unknown } | null)?.apps) ? ((device!.capabilities as { apps: string[] }).apps) : [];

    if (!presetPlan && device && !Array.isArray(device.allowedRoots)) {
      // Planning against unknown folders would produce a misleading clarification question.
      await this.state.transition(taskId, 'BLOCKED', { from: ['PLANNING'], reason: 'The agent has not reported its approved folders yet. Connect the agent, then press Resume.' });
      return;
    }

    let plan: ValidatedPlan;
    let source = 'skill';
    try {
      if (presetPlan) {
        plan = validatePlan(substituteTaskFolder(presetPlan, taskId));
      } else {
        const { models, costLimitUsd } = await loadRoutingInputs(this.prisma, task.userId);
        const images = await this.attachments.forPlanning(taskId);
        const response = await this.ai.plan({
          ...(images.length ? { images } : {}),
          instruction: task.instruction + (task.clarification ? `\nClarification from user: ${task.clarification}` : ''),
          privacyLevel: task.privacyLevel,
          models,
          roots,
          apps,
          operations: operationCatalog(await this.integrations.summaries()),
          costLimitUsd,
          resources: (device?.lastResources as Record<string, unknown> | null) ?? null,
        });
        source = response.source;
        await this.audit.record({ actorType: 'SYSTEM', action: 'ai.route', targetType: 'task', targetId: taskId, taskId, outcome: 'INFO', details: { source, ...response.routing, warnings: response.warnings } });
        // Model output is untrusted: it is validated against the operation whitelist here.
        plan = validatePlan(substituteTaskFolder(response.plan, taskId));
      }
    } catch (err) {
      if (err instanceof PlanValidationError) {
        await this.state.transition(taskId, 'FAILED', { from: ['PLANNING'], reason: redactString(err.message).slice(0, 500) });
      } else if (err instanceof AiServiceError && err.retryable) {
        // FR-14: wait for connectivity instead of failing; retryWaitingPlans() re-plans it.
        await this.state.transition(taskId, 'BLOCKED', {
          from: ['PLANNING'],
          reason: `Waiting for an AI model or the AI service to become available (${err.message}). Planning is retried automatically; Cancel to stop.`,
          data: { retryPlanningAt: new Date(Date.now() + PLAN_RETRY_MS) },
        });
      } else if (err instanceof AiServiceError) {
        await this.state.transition(taskId, 'BLOCKED', { from: ['PLANNING'], reason: `Planner unavailable (${err.message}). Press Resume to retry planning.` });
      } else throw err;
      return;
    }

    if (plan.clarification) {
      await this.state.transition(taskId, 'NEEDS_CLARIFICATION', { from: ['PLANNING'], reason: plan.clarification, data: { planSource: source } });
      await this.notifications.notify(task.userId, 'clarification', 'Clarification needed', plan.clarification, `/tasks/${taskId}`);
      return;
    }

    const ctx = await this.policy.context(task.userId, device);
    const decisions = plan.steps.map((s) => this.policy.evaluate(ctx, s.operation, s.params));
    const denied = decisions.map((d, i) => (d.denied ? `Step ${i + 1}: ${d.denied}` : null)).filter(Boolean);
    const maxPos = await this.prisma.task.aggregate({ _max: { queuePosition: true }, where: { userId: task.userId } });

    await this.prisma.$transaction(async (tx) => {
      await tx.taskStep.deleteMany({ where: { taskId } });
      await tx.taskStep.createMany({
        data: plan.steps.map((s, index) => ({
          taskId,
          index,
          operation: s.operation,
          description: s.description,
          params: s.params as Prisma.InputJsonValue,
          riskLevel: decisions[index].risk as RiskLevel,
          requiresApproval: decisions[index].requiresApproval,
          // Steps with external effects are never treated as safely repeatable.
          idempotent: (getOperation(s.operation)?.idempotent ?? false) && !(getOperation(s.operation)?.external ?? true),
        })),
      });
      await tx.task.update({
        where: { id: taskId },
        data: {
          plan: plan as unknown as Prisma.InputJsonValue,
          successCriteria: plan.successCriteria as unknown as Prisma.InputJsonValue,
          planSource: source,
          riskLevel: overallRisk(decisions) as RiskLevel,
          title: task.title === task.instruction.slice(0, 200) ? plan.title.slice(0, 200) : task.title,
          queuePosition: (maxPos._max.queuePosition ?? 0) + 1,
          progress: 0,
        },
      });
      if (denied.length) {
        await this.state.transition(taskId, 'REJECTED', { from: ['PLANNING'], reason: `Plan blocked by policy. ${denied.join(' ')}`.slice(0, 500), tx });
      } else {
        await this.state.transition(taskId, 'QUEUED', { from: ['PLANNING'], reason: null, tx });
      }
    });
  }

  async list(user: AuthUser, q: { status?: TaskStatus[]; search?: string; all?: boolean; page: number; pageSize: number }) {
    const where: Prisma.TaskWhereInput = {
      ...(q.all && can(user, 'task:read_all') ? {} : { userId: user.id }),
      ...(q.status?.length ? { status: { in: q.status } } : {}),
      ...(q.search ? { OR: [{ title: { contains: q.search } }, { instruction: { contains: q.search } }] } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.task.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        select: { id: true, title: true, status: true, statusReason: true, progress: true, riskLevel: true, privacyLevel: true, queuePosition: true, priority: true, createdAt: true, finishedAt: true, planSource: true, userId: true },
      }),
      this.prisma.task.count({ where }),
    ]);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  async detail(user: AuthUser, id: string) {
    await this.getOwned(user, id);
    return this.prisma.task.findUniqueOrThrow({
      where: { id },
      include: {
        steps: { orderBy: { index: 'asc' } },
        approvals: { orderBy: { createdAt: 'desc' }, include: { decision: { select: { decision: true, comment: true, createdAt: true, channel: true } } } },
        evidence: { orderBy: { createdAt: 'asc' } },
        checkpoints: { orderBy: { createdAt: 'asc' } },
        executions: { orderBy: { dispatchedAt: 'desc' }, take: 50 },
        dependsOn: { include: { dependsOn: { select: { id: true, title: true, status: true } } } },
        agentDevice: { select: { id: true, name: true, status: true } },
        attachments: { select: { id: true, mediaType: true, sizeBytes: true, sha256: true, createdAt: true }, orderBy: { storagePath: 'asc' } },
      },
    });
  }

  async attachment(user: AuthUser, taskId: string, attachmentId: string): Promise<{ mediaType: string; bytes: Buffer }> {
    await this.getOwned(user, taskId);
    return this.attachments.read(taskId, attachmentId);
  }

  async queue(user: AuthUser) {
    return this.prisma.task.findMany({
      where: { userId: user.id, status: { in: ['QUEUED', 'RUNNING', 'AWAITING_APPROVAL', 'PAUSED', 'PLANNING'] } },
      orderBy: [{ queuePosition: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, title: true, status: true, queuePosition: true, progress: true },
    });
  }

  async pause(user: AuthUser, id: string): Promise<void> {
    await this.getOwned(user, id, true);
    await this.state.transitionOrConflict(id, 'PAUSED', { from: PAUSABLE, reason: 'Paused by user', actor: { type: 'USER', id: user.id } });
  }

  async cancel(user: AuthUser, id: string): Promise<void> {
    const task = await this.getOwned(user, id, true);
    if (TERMINAL.includes(task.status)) throw new ConflictException('Task is already finished');
    await this.prisma.$transaction(async (tx) => {
      await this.state.transitionOrConflict(id, 'CANCELLED', { reason: 'Cancelled by user', actor: { type: 'USER', id: user.id }, tx });
      await tx.taskStep.updateMany({ where: { taskId: id, status: { in: ['PENDING', 'AWAITING_APPROVAL'] } }, data: { status: 'CANCELLED' } });
      await tx.approvalRequest.updateMany({ where: { taskId: id, status: 'PENDING' }, data: { status: 'SUPERSEDED' } });
    });
    this.orchestrator.abortCurrent(id);
  }

  async reorder(user: AuthUser, id: string, queuePosition: number): Promise<void> {
    const task = await this.getOwned(user, id, true);
    if (!['QUEUED', 'PAUSED', 'AWAITING_APPROVAL', 'BLOCKED', 'INTERRUPTED'].includes(task.status)) throw new ConflictException('Only waiting tasks can be reordered');
    await this.prisma.task.update({ where: { id }, data: { queuePosition } });
    await this.audit.record({ actorType: 'USER', actorId: user.id, action: 'task.reorder', targetType: 'task', targetId: id, taskId: id, outcome: 'SUCCESS', details: { queuePosition } });
  }

  async clarify(user: AuthUser, id: string, answer: string): Promise<void> {
    const task = await this.getOwned(user, id, true);
    if (task.status !== 'NEEDS_CLARIFICATION') throw new ConflictException('Task is not waiting for clarification');
    if (containsSecret(answer)) throw new BadRequestException('The answer appears to contain a secret. Remove it.');
    await this.prisma.task.update({ where: { id }, data: { clarification: [task.clarification, answer].filter(Boolean).join('\n').slice(-5000) } }); // keep the newest answers
    await this.plan(id);
  }

  /**
   * Resume only after inspecting real state: uncertain operations are reconciled through the
   * agent's journal, completed file writes are re-checked on disk, and non-idempotent steps
   * with unknown outcomes need explicit confirmation so nothing is blindly repeated.
   */
  async resume(user: AuthUser, id: string, confirmUncertain: boolean): Promise<{ status: string; inspected: string[] }> {
    const task = await this.getOwned(user, id, true);
    if (!RESUMABLE.includes(task.status)) throw new ConflictException('Task cannot be resumed from its current state');
    const system = await this.prisma.systemState.findUniqueOrThrow({ where: { id: 1 } });
    if (system.emergencyStop) throw new ConflictException('Emergency stop is active. An administrator must clear it first.');
    if (task.deadline && task.deadline < new Date()) {
      // Resuming after the deadline is the user's explicit "run it anyway".
      await this.prisma.task.update({ where: { id }, data: { deadline: null } });
      await this.audit.record({ actorType: 'USER', actorId: user.id, action: 'task.deadline_overridden', targetType: 'task', targetId: id, taskId: id, outcome: 'INFO', details: { deadline: task.deadline.toISOString() } });
    }
    if (!task.plan) {
      await this.plan(id);
      return { status: 'PLANNING', inspected: ['No plan yet: re-planning'] };
    }

    const inspected: string[] = [];
    const steps = await this.prisma.taskStep.findMany({ where: { taskId: id }, orderBy: { index: 'asc' }, include: { executions: { orderBy: { dispatchedAt: 'desc' }, take: 1 } } });
    const deviceConnected = task.agentDeviceId ? this.hub.isConnected(task.agentDeviceId) : false;
    const needsAgent = steps.some((s) => ['RUNNING', 'UNCERTAIN'].includes(s.status) || (s.status === 'SUCCEEDED' && s.operation === 'file.write'));
    if (needsAgent && !deviceConnected) throw new ConflictException('The agent must be connected so the current state can be inspected before resuming');

    for (const step of steps) {
      const params = step.params as Record<string, unknown>;
      if (step.status === 'SUCCEEDED' && step.operation === 'file.write') {
        const res = await this.hub.dispatch(task.agentDeviceId!, { operationId: randomUUID(), operation: 'file.stat', params: { root: params.root, path: params.path }, approvalHash: null, timeoutMs: 15_000, taskId: id }).catch(() => null);
        const expectedHash = sha256(Buffer.from(String(params.content ?? ''), 'utf8'));
        if (!res?.ok || res.output?.sha256 !== expectedHash) {
          await this.prisma.taskStep.update({ where: { id: step.id }, data: { status: 'PENDING', attempts: 0, result: Prisma.JsonNull } });
          inspected.push(`Step ${step.index + 1}: file changed or missing since checkpoint; will redo`);
        } else inspected.push(`Step ${step.index + 1}: checkpoint verified on disk`);
        continue;
      }
      if (step.status === 'RUNNING' || step.status === 'UNCERTAIN') {
        const last = step.executions[0];
        const status = last ? await this.hub.queryStatus(task.agentDeviceId!, last.operationId) : { state: 'unknown' as const };
        if (status.state === 'running') throw new ConflictException(`Step ${step.index + 1} is still running on the agent; wait for it to finish`);
        if (status.state === 'completed' && status.result?.ok) {
          await this.prisma.taskStep.update({ where: { id: step.id }, data: { status: 'SUCCEEDED', result: status.result as unknown as Prisma.InputJsonValue, finishedAt: new Date() } });
          await this.prisma.taskExecution.update({ where: { operationId: last!.operationId }, data: { status: 'SUCCEEDED', output: status.result as unknown as Prisma.InputJsonValue } });
          inspected.push(`Step ${step.index + 1}: completed on the agent; reconciled without repeating`);
          continue;
        }
        if (!step.idempotent && status.state !== 'completed' && !confirmUncertain) {
          throw new ConflictException(`Step ${step.index + 1} ("${step.description}") may have run already and is not safe to repeat. Check it yourself, then resume with confirmation.`);
        }
        await this.prisma.taskStep.update({ where: { id: step.id }, data: { status: 'PENDING', attempts: 0 } });
        inspected.push(`Step ${step.index + 1}: outcome ${status.state}; will run again`);
        continue;
      }
      if (['FAILED', 'CANCELLED', 'AWAITING_APPROVAL'].includes(step.status)) {
        await this.prisma.taskStep.update({ where: { id: step.id }, data: { status: 'PENDING', attempts: 0, error: null } });
        inspected.push(`Step ${step.index + 1}: reset for retry`);
      }
    }
    await this.state.transitionOrConflict(id, 'QUEUED', { from: RESUMABLE, reason: null, actor: { type: 'USER', id: user.id } });
    await this.audit.record({ actorType: 'USER', actorId: user.id, action: 'task.resume', targetType: 'task', targetId: id, taskId: id, outcome: 'SUCCESS', details: { inspected, confirmUncertain } });
    return { status: 'QUEUED', inspected };
  }

  async auditTrail(user: AuthUser, id: string) {
    await this.getOwned(user, id);
    return this.prisma.auditEvent.findMany({ where: { taskId: id }, orderBy: { id: 'asc' }, take: 500 });
  }

  assertNotViewer(user: AuthUser): void {
    if (!can(user, 'task:create')) throw new ForbiddenException('Read-only users cannot create tasks');
  }
}
