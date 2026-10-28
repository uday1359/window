import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { redact, redactString } from '../common/redact';

export interface AuditInput {
  actorType: 'USER' | 'AGENT' | 'SYSTEM';
  actorId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  taskId?: string | null;
  outcome: 'SUCCESS' | 'FAILURE' | 'DENIED' | 'INFO';
  details?: Record<string, unknown>;
}

type Tx = Prisma.TransactionClient | PrismaService;

@Injectable()
export class AuditService {
  private readonly logger = new Logger('Audit');

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records an audit event. Details are always redacted. When a transaction client is
   * supplied the event commits atomically with the change it describes.
   */
  async record(input: AuditInput, tx: Tx = this.prisma): Promise<void> {
    const data = {
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      taskId: input.taskId ?? null,
      outcome: input.outcome,
      details: input.details ? (redact(input.details) as Prisma.InputJsonValue) : Prisma.JsonNull,
    };
    if (tx !== this.prisma) {
      await tx.auditEvent.create({ data });
      return;
    }
    try {
      await this.prisma.auditEvent.create({ data });
    } catch (err) {
      // Auditing outside a transaction must not break the calling operation, but it must be visible.
      this.logger.error(redactString(`Failed to write audit event ${input.action}: ${(err as Error).message}`));
    }
  }
}

@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
