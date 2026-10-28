import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma, TaskStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { EventsService } from '../realtime/events.service';
import { sourcesFor, TERMINAL } from './task-state';

type Tx = Prisma.TransactionClient;

const FINISHED: TaskStatus[] = [...TERMINAL, 'FAILED'];

export interface TransitionOptions {
  /** Only transition from these statuses (default: every status that may reach `to`). */
  from?: TaskStatus[];
  reason?: string | null;
  data?: Prisma.TaskUncheckedUpdateManyInput;
  actor?: { type: 'USER' | 'AGENT' | 'SYSTEM'; id?: string | null };
  tx?: Tx;
}

/**
 * Performs task status changes atomically: the UPDATE only matches rows still in an
 * allowed source status, so concurrent actors (orchestrator vs. user cancel) cannot
 * produce invalid states. Returns false when another actor changed the task first.
 */
@Injectable()
export class TaskStateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: EventsService,
  ) {}

  async transition(taskId: string, to: TaskStatus, opts: TransitionOptions = {}): Promise<boolean> {
    const from = sourcesFor(to, opts.from);
    const run = async (tx: Tx) => {
      const { count } = await tx.task.updateMany({
        where: { id: taskId, status: { in: from } },
        data: {
          ...(opts.data ?? {}),
          status: to,
          statusReason: opts.reason === undefined ? undefined : opts.reason?.slice(0, 500) ?? null,
          version: { increment: 1 },
          // FAILED is resumable, so it is not TERMINAL, but it is finished until resumed:
          // retention purges by finishedAt and must not touch a task that is active again.
          finishedAt: FINISHED.includes(to) ? new Date() : null,
        },
      });
      if (count === 0) return null;
      const task = await tx.task.findUniqueOrThrow({ where: { id: taskId }, select: { id: true, userId: true, status: true, statusReason: true, progress: true } });
      await this.audit.record(
        {
          actorType: opts.actor?.type ?? 'SYSTEM',
          actorId: opts.actor?.id ?? null,
          action: `task.status.${to.toLowerCase()}`,
          targetType: 'task',
          targetId: taskId,
          taskId,
          outcome: 'INFO',
          details: opts.reason ? { reason: opts.reason } : undefined,
        },
        tx,
      );
      return task;
    };
    const task = opts.tx ? await run(opts.tx) : await this.prisma.$transaction(run);
    if (!task) return false;
    this.events.publish(task.userId, { type: 'task.updated', taskId, status: task.status, statusReason: task.statusReason, progress: task.progress });
    return true;
  }

  /** Like transition() but raises 409 for user-initiated actions that lost a race or are invalid. */
  async transitionOrConflict(taskId: string, to: TaskStatus, opts: TransitionOptions = {}): Promise<void> {
    if (!(await this.transition(taskId, to, opts))) {
      throw new ConflictException(`Task cannot move to ${to} from its current state`);
    }
  }

  publishStep(userId: string, taskId: string, step: { id: string; index: number; status: string; error?: string | null }): void {
    this.events.publish(userId, { type: 'step.updated', taskId, step });
  }
}
