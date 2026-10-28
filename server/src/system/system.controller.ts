import { Body, Controller, Get, HttpCode, Injectable, Post, Query } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AiClientService } from '../ai/ai-client.service';
import { AgentHubService } from '../realtime/agent-hub.service';
import { EventsService } from '../realtime/events.service';
import { OrchestratorService } from '../orchestrator/orchestrator.service';
import { OfflineStore } from '../offline/offline-store.service';
import { TaskStateService } from '../tasks/task-state.service';
import { parse } from '../common/errors';
import { AuthUser, can, CurrentUser, Public, RequirePermissions } from '../auth/auth.types';

const VERSION = '1.0.0';

@Injectable()
export class SystemService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly hub: AgentHubService,
    private readonly events: EventsService,
    private readonly orchestrator: OrchestratorService,
    private readonly state: TaskStateService,
  ) {}

  /**
   * Stops everything: persists the stop flag, pauses every active task (so nothing resumes
   * without an explicit decision), cancels in-flight operations and tells every agent.
   */
  async emergencyStop(user: AuthUser, source: string): Promise<{ pausedTasks: number }> {
    this.hub.setEmergencyStop(true);
    this.orchestrator.abortCurrent();
    let paused = 0;
    await this.prisma.$transaction(async (tx) => {
      await tx.systemState.update({ where: { id: 1 }, data: { emergencyStop: true, emergencyStopAt: new Date(), emergencyStopBy: user.id } });
      const active = await tx.task.findMany({ where: { status: { in: ['PLANNING', 'QUEUED', 'RUNNING', 'AWAITING_APPROVAL'] } }, select: { id: true } });
      for (const t of active) {
        if (await this.state.transition(t.id, 'PAUSED', { reason: 'Emergency stop', actor: { type: 'USER', id: user.id }, tx })) paused++;
      }
      await tx.taskStep.updateMany({ where: { status: 'RUNNING' }, data: { status: 'UNCERTAIN' } });
      await this.audit.record({ actorType: 'USER', actorId: user.id, action: 'system.emergency_stop', outcome: 'SUCCESS', details: { source, pausedTasks: paused } }, tx);
    });
    this.events.publish(null, { type: 'system.emergency_stop', active: true });
    return { pausedTasks: paused };
  }

  async clearEmergencyStop(user: AuthUser): Promise<void> {
    await this.prisma.systemState.update({ where: { id: 1 }, data: { emergencyStop: false } });
    this.hub.setEmergencyStop(false);
    await this.audit.record({ actorType: 'USER', actorId: user.id, action: 'system.emergency_stop_clear', outcome: 'SUCCESS' });
    this.events.publish(null, { type: 'system.emergency_stop', active: false });
  }
}

@Controller('api')
export class SystemController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly system: SystemService,
    private readonly ai: AiClientService,
    private readonly hub: AgentHubService,
    private readonly events: EventsService,
    private readonly orchestrator: OrchestratorService,
    private readonly offline: OfflineStore,
  ) {}

  /** Liveness probe: deliberately reveals nothing beyond up/down. */
  @Public()
  @Get('health')
  async health() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok' };
    } catch {
      return { status: 'degraded' };
    }
  }

  @Get('system/state')
  async state() {
    const s = await this.prisma.systemState.findUniqueOrThrow({ where: { id: 1 } });
    return { emergencyStop: s.emergencyStop, emergencyStopAt: s.emergencyStopAt, queueEnabled: s.queueEnabled, orchestratorBusy: this.orchestrator.isBusy() };
  }

  @Post('system/emergency-stop')
  @HttpCode(200)
  @RequirePermissions('system:emergency_stop')
  emergencyStop(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const { source } = parse(z.object({ source: z.enum(['web', 'desktop', 'tray']).default('web') }).prefault({}), body ?? {});
    return this.system.emergencyStop(user, source);
  }

  @Post('system/emergency-stop/clear')
  @HttpCode(200)
  @RequirePermissions('system:admin')
  async clear(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    parse(z.object({ confirm: z.literal(true) }), body);
    await this.system.clearEmergencyStop(user);
    return { ok: true, note: 'Paused tasks stay paused until resumed individually.' };
  }

  @Post('system/queue')
  @HttpCode(200)
  @RequirePermissions('system:admin')
  async setQueue(@Body() body: unknown) {
    const { enabled } = parse(z.object({ enabled: z.boolean() }), body);
    await this.prisma.systemState.update({ where: { id: 1 }, data: { queueEnabled: enabled } });
    return { ok: true };
  }

  @Get('diagnostics')
  async diagnostics(@CurrentUser() user: AuthUser) {
    const started = Date.now();
    let db: Record<string, unknown>;
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      const migrations = await this.prisma.$queryRaw<Array<{ migration_name: string; finished_at: Date | null }>>`SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY started_at`;
      db = { ok: true, latencyMs: Date.now() - started, migrations: migrations.map((m) => ({ name: m.migration_name, applied: m.finished_at !== null })) };
    } catch (err) {
      db = { ok: false, error: (err as Error).name };
    }
    let ai: Record<string, unknown>;
    try {
      ai = { ok: true, ...(await this.ai.health()) };
    } catch (err) {
      ai = { ok: false, error: (err as Error).message };
    }
    const devices = await this.prisma.agentDevice.findMany({ where: { ownerId: user.id, status: 'ACTIVE' }, select: { id: true, name: true, lastSeenAt: true, lastResources: true, agentVersion: true } });
    const [queued, running, blocked] = await Promise.all(
      (['QUEUED', 'RUNNING', 'BLOCKED'] as const).map((status) => this.prisma.task.count({ where: { status, ...(can(user, 'task:read_all') ? {} : { userId: user.id }) } })),
    );
    const mem = process.memoryUsage();
    return {
      version: VERSION,
      server: { ok: true, uptimeSec: Math.round(process.uptime()), rssMb: Math.round(mem.rss / 1048576), heapUsedMb: Math.round(mem.heapUsed / 1048576), node: process.version, dashboardConnections: this.events.connectionCount() },
      database: db,
      aiService: ai,
      agents: devices.map((d) => ({ ...d, connected: this.hub.isConnected(d.id) })),
      queue: { queued, running, blocked, orchestratorBusy: this.orchestrator.isBusy() },
      offlineQueue: this.offline.status(),
    };
  }

  @Get('audit')
  @RequirePermissions('audit:read')
  async auditEvents(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    const q = parse(
      z.object({
        action: z.string().max(64).optional(),
        taskId: z.string().uuid().optional(),
        before: z.coerce.bigint().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      }),
      query,
    );
    const where: Prisma.AuditEventWhereInput = {
      ...(q.action ? { action: { startsWith: q.action } } : {}),
      ...(q.taskId ? { taskId: q.taskId } : {}),
      ...(q.before ? { id: { lt: q.before } } : {}),
    };
    if (!can(user, 'audit:read_all')) {
      const [ownTasks, ownDevices] = await Promise.all([
        this.prisma.task.findMany({ where: { userId: user.id }, select: { id: true } }),
        this.prisma.agentDevice.findMany({ where: { ownerId: user.id }, select: { id: true } }),
      ]);
      where.OR = [{ actorId: user.id }, { taskId: { in: ownTasks.map((t) => t.id) } }, { actorId: { in: ownDevices.map((d) => d.id) } }];
    }
    return this.prisma.auditEvent.findMany({ where, orderBy: { id: 'desc' }, take: q.limit });
  }
}
