import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { PREFERENCE_DEFAULTS } from '../settings/settings.controller';
import { AttachmentsService } from '../tasks/attachments.service';

const DAY_MS = 86_400_000;
const NOTIFICATION_RETENTION_DAYS = 90;

/** Applies each user's history-retention preference to finished tasks and old notifications. */
@Injectable()
export class RetentionService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Retention');
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly attachments: AttachmentsService,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.WINAGENT_DISABLE_ORCHESTRATOR === '1') return;
    this.timer = setInterval(() => void this.purge().catch((e) => this.logger.error(e.message)), DAY_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async purge(now = new Date()): Promise<{ tasks: number; notifications: number }> {
    const users = await this.prisma.user.findMany({ select: { id: true, preferences: { where: { key: 'historyRetentionDays' } } } });
    let tasks = 0;
    for (const u of users) {
      const days = typeof u.preferences[0]?.value === 'number' ? (u.preferences[0].value as number) : (PREFERENCE_DEFAULTS.historyRetentionDays as number);
      const cutoff = new Date(now.getTime() - days * DAY_MS);
      const expired = await this.prisma.task.findMany({ where: { userId: u.id, finishedAt: { lt: cutoff }, status: { in: ['SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED', 'REJECTED'] } }, select: { id: true } });
      if (!expired.length) continue;
      const ids = expired.map((t) => t.id);
      // Attachment files live outside MySQL, so they are removed explicitly; rows cascade.
      await this.attachments.deleteFiles(ids);
      const { count } = await this.prisma.task.deleteMany({ where: { id: { in: ids } } });
      tasks += count;
    }
    const { count: notifications } = await this.prisma.notification.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - NOTIFICATION_RETENTION_DAYS * DAY_MS) } } });
    if (tasks || notifications) await this.audit.record({ actorType: 'SYSTEM', action: 'retention.purge', outcome: 'SUCCESS', details: { tasks, notifications } });
    return { tasks, notifications };
  }
}
