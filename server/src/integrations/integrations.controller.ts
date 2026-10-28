import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AiClientService } from '../ai/ai-client.service';
import { parse } from '../common/errors';
import { AuthUser, CurrentUser, RequirePermissions } from '../auth/auth.types';
import { IntegrationName } from '../operations/operations';
import { toConfig } from './integrations.service';

const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i;
const BaseUrl = z
  .string()
  .url()
  .max(500)
  .refine((u) => u.startsWith('https://') || LOOPBACK.test(u), 'Integrations must use https:// (or http:// to this computer)')
  .refine((u) => !new URL(u).username && !new URL(u).password, 'Do not put credentials in the URL; store them as a secret');
const PathPrefix = z.string().min(1).max(200).regex(/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/, 'Paths must start with /').refine((p) => !p.includes('//') && !`${p}/`.includes('/../'), 'Invalid path');

const IntegrationSchema = z
  .object({
    name: IntegrationName,
    kind: z.enum(['REST', 'MCP']),
    description: z.string().trim().max(500).default(''),
    baseUrl: BaseUrl,
    allowedPaths: z.array(PathPrefix).max(50).default([]),
    allowedTools: z.array(z.string().min(1).max(128)).max(100).default([]),
    authHeader: z.string().regex(/^[A-Za-z0-9-]{1,64}$/).nullable().optional(),
    authScheme: z.string().max(32).nullable().optional(),
    secretRef: z.string().regex(/^[a-z0-9_-]{1,100}$/).nullable().optional(),
    enabled: z.boolean().default(true),
  })
  .strict();

/**
 * Administrator-managed allow list of external integrations (FR-17). Registering one does not
 * let anything run: plans still go through the policy engine and, for anything that can change
 * data elsewhere (POST, MCP tools), an explicit approval.
 */
@Controller('api/integrations')
export class IntegrationsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly ai: AiClientService,
  ) {}

  @Get()
  @RequirePermissions('settings:manage')
  list() {
    return this.prisma.integration.findMany({ orderBy: { name: 'asc' } });
  }

  @Post()
  @RequirePermissions('settings:manage')
  async create(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const input = parse(IntegrationSchema, body);
    if (input.kind === 'REST' && input.allowedPaths.length === 0) throw new BadRequestException('A REST integration needs at least one allowed path');
    const created = await this.prisma.integration.create({ data: { ...input, authHeader: input.authHeader ?? null, authScheme: input.authScheme ?? null, secretRef: input.secretRef ?? null, createdById: user.id } });
    await this.audit.record({ actorType: 'USER', actorId: user.id, action: 'integration.create', targetType: 'integration', targetId: created.id, outcome: 'SUCCESS', details: { name: input.name, kind: input.kind, baseUrl: input.baseUrl, allowedPaths: input.allowedPaths, allowedTools: input.allowedTools } });
    return created;
  }

  @Patch(':id')
  @RequirePermissions('settings:manage')
  async update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(IntegrationSchema.partial().omit({ name: true, kind: true }), body);
    const updated = await this.prisma.integration.update({ where: { id }, data: input });
    await this.audit.record({ actorType: 'USER', actorId: user.id, action: 'integration.update', targetType: 'integration', targetId: id, outcome: 'SUCCESS', details: { fields: Object.keys(input), enabled: updated.enabled } });
    return updated;
  }

  @Delete(':id')
  @RequirePermissions('settings:manage')
  async remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const removed = await this.prisma.integration.delete({ where: { id } });
    await this.audit.record({ actorType: 'USER', actorId: user.id, action: 'integration.delete', targetType: 'integration', targetId: id, outcome: 'SUCCESS', details: { name: removed.name } });
    return { ok: true };
  }

  /** Shows an MCP server's tools so an administrator can decide which to allow. */
  @Post(':id/tools')
  @HttpCode(200)
  @RequirePermissions('settings:manage')
  async tools(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const row = await this.prisma.integration.findUniqueOrThrow({ where: { id } });
    if (row.kind !== 'MCP') throw new BadRequestException('Only MCP integrations list tools');
    const result = await this.ai.integrationMcpTools(toConfig(row));
    await this.audit.record({ actorType: 'USER', actorId: user.id, action: 'integration.tools', targetType: 'integration', targetId: id, outcome: 'SUCCESS', details: { count: result.tools.length } });
    return result;
  }
}
