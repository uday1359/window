import { ConflictException, ForbiddenException, GoneException, Injectable, NotFoundException } from '@nestjs/common';
import type { RiskLevel, Task, TaskStep } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EventsService } from '../realtime/events.service';
import { TaskStateService } from '../tasks/task-state.service';
import { actionHash } from '../common/crypto';
import { loadConfig } from '../config/config';
import { getOperation } from '../operations/operations';
import { AuthUser, can } from '../auth/auth.types';
import type { StepDecision } from '../policy/policy';

@Injectable()
export class ApprovalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly events: EventsService,
    private readonly state: TaskStateService,
  ) {}

  /**
   * An approval is usable only if it was granted for exactly this action hash, has not
   * expired and has not already been consumed by a finished execution.
   */
  async findUsableApproval(stepId: string, hash: string): Promise<string | null> {
    const request = await this.prisma.approvalRequest.findFirst({
      where: { stepId, actionHash: hash, status: 'APPROVED', expiresAt: { gt: new Date() }, decision: { decision: 'APPROVED', actionHash: hash } },
      orderBy: { createdAt: 'desc' },
    });
    if (!request) return null;
    const consumed = await this.prisma.taskExecution.count({
      where: { stepId, approvalHash: hash, status: { in: ['SUCCEEDED', 'FAILED', 'UNCERTAIN', 'TIMED_OUT', 'CANCELLED'] } },
    });
    return consumed > 0 ? null : request.id;
  }

  async request(task: Task, step: TaskStep, hash: string, decision: StepDecision): Promise<void> {
    const def = getOperation(step.operation);
    const params = step.params as Record<string, unknown>;
    const ttl = loadConfig().APPROVAL_TTL_MINUTES * 60_000;
    const created = await this.prisma.$transaction(async (tx) => {
      // A changed action invalidates older approvals for the same step.
      await tx.approvalRequest.updateMany({ where: { stepId: step.id, status: { in: ['PENDING', 'APPROVED'] }, actionHash: { not: hash } }, data: { status: 'SUPERSEDED' } });
      const existing = await tx.approvalRequest.findFirst({ where: { stepId: step.id, actionHash: hash, status: 'PENDING', expiresAt: { gt: new Date() } } });
      if (existing) return null;
      const req = await tx.approvalRequest.create({
        data: {
          taskId: task.id,
          stepId: step.id,
          actionHash: hash,
          operation: step.operation,
          target: (def?.target(params) ?? step.operation).slice(0, 1000),
          summary: step.description,
          consequences: [def?.consequences(params), ...decision.reasons].filter(Boolean).join(' '),
          riskLevel: decision.risk as RiskLevel,
          expiresAt: new Date(Date.now() + ttl),
        },
      });
      await tx.taskStep.update({ where: { id: step.id }, data: { status: 'AWAITING_APPROVAL' } });
      await this.audit.record({ actorType: 'SYSTEM', action: 'approval.request', targetType: 'approval', targetId: req.id, taskId: task.id, outcome: 'INFO', details: { operation: step.operation, risk: decision.risk } }, tx);
      return req;
    });
    if (created) {
      await this.notifications.notify(task.userId, 'approval', 'Approval required', `${created.summary} (${created.riskLevel} risk)`, `/approvals`);
      this.events.publish(task.userId, { type: 'approval.created', taskId: task.id, approvalId: created.id });
    }
  }

  async list(user: AuthUser, status?: string) {
    const valid = ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'SUPERSEDED'];
    await this.expireStale();
    return this.prisma.approvalRequest.findMany({
      where: {
        ...(status && valid.includes(status) ? { status: status as 'PENDING' } : {}),
        ...(can(user, 'task:read_all') ? {} : { task: { userId: user.id } }),
      },
      include: { decision: { select: { decision: true, comment: true, createdAt: true, userId: true } }, task: { select: { id: true, title: true, status: true } }, step: { select: { index: true, params: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  async expireStale(): Promise<number> {
    const { count } = await this.prisma.approvalRequest.updateMany({ where: { status: 'PENDING', expiresAt: { lte: new Date() } }, data: { status: 'EXPIRED' } });
    return count;
  }

  async decide(user: AuthUser, requestId: string, approve: boolean, clientActionHash: string, comment: string | undefined, channel: 'web' | 'desktop'): Promise<void> {
    const request = await this.prisma.approvalRequest.findUnique({ where: { id: requestId }, include: { task: true, step: true } });
    if (!request) throw new NotFoundException('Approval request not found');
    if (request.task.userId !== user.id && !can(user, 'system:admin')) throw new ForbiddenException('You cannot decide approvals for this task');
    if (request.status !== 'PENDING') throw new ConflictException(`Approval request is already ${request.status.toLowerCase()}`);
    if (request.expiresAt <= new Date()) {
      await this.prisma.approvalRequest.update({ where: { id: request.id }, data: { status: 'EXPIRED' } });
      throw new GoneException('Approval request has expired; resume the task to request a new approval');
    }
    // The approver must have seen exactly this action, and the action must not have changed since.
    if (clientActionHash !== request.actionHash) throw new ConflictException('The action shown to you does not match the pending request; reload and review it again');
    const current = actionHash(request.taskId, request.stepId, request.step.operation, request.step.params);
    if (current !== request.actionHash) {
      await this.prisma.approvalRequest.update({ where: { id: request.id }, data: { status: 'SUPERSEDED' } });
      throw new ConflictException('The action changed after approval was requested; a new approval is required');
    }

    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.approvalRequest.updateMany({ where: { id: request.id, status: 'PENDING' }, data: { status: approve ? 'APPROVED' : 'REJECTED' } });
      if (count === 0) throw new ConflictException('Approval request was decided concurrently');
      await tx.approvalDecision.create({
        data: { requestId: request.id, userId: user.id, decision: approve ? 'APPROVED' : 'REJECTED', actionHash: request.actionHash, comment: comment?.slice(0, 500), channel },
      });
      await this.audit.record(
        { actorType: 'USER', actorId: user.id, action: approve ? 'approval.approve' : 'approval.reject', targetType: 'approval', targetId: request.id, taskId: request.taskId, outcome: 'SUCCESS', details: { operation: request.operation, channel } },
        tx,
      );
      if (approve) {
        await tx.taskStep.update({ where: { id: request.stepId }, data: { status: 'PENDING' } });
        await this.state.transition(request.taskId, 'QUEUED', { from: ['AWAITING_APPROVAL'], reason: 'Approved by user', actor: { type: 'USER', id: user.id }, tx });
      } else {
        await tx.taskStep.update({ where: { id: request.stepId }, data: { status: 'CANCELLED' } });
        await this.state.transition(request.taskId, 'REJECTED', { from: ['AWAITING_APPROVAL', 'PAUSED'], reason: 'Action rejected by user', actor: { type: 'USER', id: user.id }, tx });
      }
    });
    this.events.publish(request.task.userId, { type: 'approval.decided', approvalId: request.id, taskId: request.taskId, approved: approve });
  }
}
