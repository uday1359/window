import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { PrismaModule } from './prisma/prisma.service';
import { AuditModule } from './audit/audit.service';
import { OfflineModule } from './offline/offline-store.service';
import { AllExceptionsFilter } from './common/errors';
import { AuthService } from './auth/auth.service';
import { AuthGuard } from './auth/auth.guard';
import { AuthController } from './auth/auth.controller';
import { EventsService } from './realtime/events.service';
import { AgentHubService } from './realtime/agent-hub.service';
import { WsGatewayService } from './realtime/ws-gateway.service';
import { AiClientService } from './ai/ai-client.service';
import { PolicyService } from './policy/policy.service';
import { NotificationsController, NotificationsService } from './notifications/notifications.service';
import { TaskStateService } from './tasks/task-state.service';
import { ApprovalsService } from './approvals/approvals.service';
import { ApprovalsController } from './approvals/approvals.controller';
import { OrchestratorService } from './orchestrator/orchestrator.service';
import { TasksService } from './tasks/tasks.service';
import { AttachmentsService } from './tasks/attachments.service';
import { IntegrationsService } from './integrations/integrations.service';
import { IntegrationsController } from './integrations/integrations.controller';
import { TasksController } from './tasks/tasks.controller';
import { AgentsController } from './agents/agents.controller';
import { SettingsController } from './settings/settings.controller';
import { SystemController, SystemService } from './system/system.controller';
import { RetentionService } from './system/retention.service';
import { MemoryController } from './memory/memory.controller';
import { BackupsController, BackupsService } from './backups/backups.service';

@Module({
  imports: [PrismaModule, OfflineModule, AuditModule],
  controllers: [AuthController, TasksController, ApprovalsController, AgentsController, SettingsController, SystemController, MemoryController, NotificationsController, BackupsController, IntegrationsController],
  providers: [
    AuthService,
    EventsService,
    AgentHubService,
    WsGatewayService,
    AiClientService,
    PolicyService,
    NotificationsService,
    TaskStateService,
    ApprovalsService,
    OrchestratorService,
    TasksService,
    AttachmentsService,
    IntegrationsService,
    SystemService,
    RetentionService,
    BackupsService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
