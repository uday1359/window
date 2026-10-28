import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AiClientService } from '../ai/ai-client.service';
import { parse } from '../common/errors';
import { AuthUser, CurrentUser, RequirePermissions } from '../auth/auth.types';
import { loadRoutingInputs } from '../ai/routing-inputs';

/** Every preference is whitelisted with its own type so arbitrary data cannot be stored. */
export const PREFERENCE_SCHEMAS = {
  theme: z.enum(['system', 'light', 'dark']),
  voiceInput: z.boolean(),
  spokenFeedback: z.boolean(),
  approveMediumRisk: z.boolean(),
  cloudCostLimitUsd: z.number().min(0).max(10),
  defaultPrivacyLevel: z.enum(['LOCAL_ONLY', 'CLOUD_REDACTED', 'CLOUD_ALLOWED']),
  historyRetentionDays: z.number().int().min(1).max(3650),
} as const;
type PrefKey = keyof typeof PREFERENCE_SCHEMAS;

export const PREFERENCE_DEFAULTS: Record<PrefKey, unknown> = {
  theme: 'system',
  voiceInput: false,
  spokenFeedback: false,
  approveMediumRisk: false,
  cloudCostLimitUsd: 0.05,
  defaultPrivacyLevel: 'LOCAL_ONLY',
  historyRetentionDays: 365,
};

const PolicySchema = z.object({
  kind: z.enum(['FOLDER', 'WEBSITE', 'APPLICATION', 'ACTION']),
  value: z.string().trim().min(1).max(500),
  effect: z.enum(['ALLOW', 'DENY', 'REQUIRE_APPROVAL']),
  note: z.string().max(255).optional(),
}).superRefine((p, ctx) => {
  const ok =
    (p.kind === 'FOLDER' && /^[a-z][a-z0-9_-]{0,31}(:[^:*?"<>|]{1,400})?$/.test(p.value) && !p.value.includes('..')) ||
    (p.kind === 'WEBSITE' && /^(\*\.)?[a-z0-9.-]+\.[a-z]{2,}$|^localhost$/i.test(p.value)) ||
    (p.kind === 'APPLICATION' && /^[a-z][a-z0-9_-]{0,31}$/.test(p.value)) ||
    (p.kind === 'ACTION' && /^(\*|[a-z]+\.[a-z_]+)$/.test(p.value));
  if (!ok) ctx.addIssue({ code: 'custom', path: ['value'], message: `Invalid ${p.kind.toLowerCase()} value` });
});

const ModelSchema = z.object({
  name: z.string().trim().min(1).max(100),
  provider: z.enum(['ollama', 'openai_compatible', 'anthropic']),
  model: z.string().trim().min(1).max(100),
  endpoint: z.string().url().max(500).refine((u) => /^https:\/\//.test(u) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u + '/'), 'Cloud endpoints must use HTTPS'),
  isLocal: z.boolean(),
  enabled: z.boolean().default(true),
  maxComplexity: z.number().int().min(1).max(5).default(3),
  latencyClass: z.number().int().min(1).max(3).default(2),
  costPer1kTokens: z.number().min(0).max(1000).default(0),
  capabilities: z.array(z.enum(['planning', 'vision', 'ocr', 'chat'])).default(['planning']),
  secretRef: z.string().regex(/^[a-z0-9_-]{1,100}$/).nullable().optional(),
});
const SecretName = z.string().regex(/^[a-z0-9_-]{1,100}$/);
const SecretValue = z.object({ value: z.string().min(1).max(4096) });

@Controller('api')
export class SettingsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly ai: AiClientService,
  ) {}

  // ------------------------------------------------------------ preferences
  @Get('preferences')
  async preferences(@CurrentUser() user: AuthUser) {
    const rows = await this.prisma.userPreference.findMany({ where: { userId: user.id } });
    const out: Record<string, unknown> = { ...PREFERENCE_DEFAULTS };
    for (const r of rows) if (r.key in PREFERENCE_SCHEMAS) out[r.key] = r.value;
    return out;
  }

  @Put('preferences')
  async setPreferences(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const input = parse(z.record(z.string(), z.unknown()), body);
    const updates: Array<[PrefKey, unknown]> = [];
    for (const [key, value] of Object.entries(input)) {
      const schema = PREFERENCE_SCHEMAS[key as PrefKey];
      if (!schema) throw new BadRequestException(`Unknown preference "${key}"`);
      updates.push([key as PrefKey, parse(schema as z.ZodTypeAny, value)]);
    }
    await this.prisma.$transaction(
      updates.map(([key, value]) =>
        this.prisma.userPreference.upsert({
          where: { userId_key: { userId: user.id, key } },
          create: { userId: user.id, key, value: value as Prisma.InputJsonValue },
          update: { value: value as Prisma.InputJsonValue },
        }),
      ),
    );
    await this.audit.record({ actorType: 'USER', actorId: user.id, action: 'preferences.update', outcome: 'SUCCESS', details: { keys: updates.map(([k]) => k) } });
    return this.preferences(user);
  }

  // ------------------------------------------------------------ permission policies
  @Get('policies')
  @RequirePermissions('policy:manage')
  policies(@CurrentUser() user: AuthUser) {
    return this.prisma.permissionPolicy.findMany({ where: { userId: user.id, revokedAt: null }, orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }] });
  }

  @Post('policies')
  @RequirePermissions('policy:manage')
  async createPolicy(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const input = parse(PolicySchema, body);
    const created = await this.prisma.permissionPolicy.create({ data: { ...input, value: input.kind === 'WEBSITE' ? input.value.toLowerCase() : input.value, userId: user.id } });
    await this.audit.record({ actorType: 'USER', actorId: user.id, action: 'policy.create', targetType: 'policy', targetId: created.id, outcome: 'SUCCESS', details: { kind: input.kind, value: input.value, effect: input.effect } });
    return created;
  }

  /** Revocation takes effect immediately: policy is re-evaluated before every dispatch. */
  @Delete('policies/:id')
  @RequirePermissions('policy:manage')
  async revokePolicy(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const { count } = await this.prisma.permissionPolicy.updateMany({ where: { id, userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
    if (count === 0) throw new NotFoundException('Policy not found');
    await this.audit.record({ actorType: 'USER', actorId: user.id, action: 'policy.revoke', targetType: 'policy', targetId: id, outcome: 'SUCCESS' });
    return { ok: true };
  }

  // ------------------------------------------------------------ models
  @Get('models')
  @RequirePermissions('task:read')
  models() {
    return this.prisma.modelConfig.findMany({ orderBy: { name: 'asc' } });
  }

  @Post('models')
  @RequirePermissions('settings:manage')
  async createModel(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const input = parse(ModelSchema, body);
    const created = await this.prisma.modelConfig.create({ data: { ...input, secretRef: input.secretRef ?? null } });
    await this.audit.record({ actorType: 'USER', actorId: user.id, action: 'model.create', targetType: 'model', targetId: created.id, outcome: 'SUCCESS', details: { name: input.name, provider: input.provider, isLocal: input.isLocal } });
    return created;
  }

  @Patch('models/:id')
  @RequirePermissions('settings:manage')
  async updateModel(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(ModelSchema.partial(), body);
    const updated = await this.prisma.modelConfig.update({ where: { id }, data: input });
    await this.audit.record({ actorType: 'USER', actorId: user.id, action: 'model.update', targetType: 'model', targetId: id, outcome: 'SUCCESS', details: { fields: Object.keys(input) } });
    return updated;
  }

  @Delete('models/:id')
  @RequirePermissions('settings:manage')
  async deleteModel(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.prisma.modelConfig.delete({ where: { id } });
    await this.audit.record({ actorType: 'USER', actorId: user.id, action: 'model.delete', targetType: 'model', targetId: id, outcome: 'SUCCESS' });
    return { ok: true };
  }

  // ------------------------------------------------------------ secrets (stored by the AI service with DPAPI; never in MySQL)
  @Get('secrets')
  @RequirePermissions('settings:manage')
  secrets() {
    return this.ai.listSecrets();
  }

  @Put('secrets/:name')
  @RequirePermissions('settings:manage')
  async putSecret(@CurrentUser() user: AuthUser, @Param('name') name: string, @Body() body: unknown) {
    const secretName = parse(SecretName, name);
    const { value } = parse(SecretValue, body);
    await this.ai.putSecret(secretName, value);
    await this.audit.record({ actorType: 'USER', actorId: user.id, action: 'secret.set', targetType: 'secret', outcome: 'SUCCESS', details: { name: secretName } });
    return { ok: true };
  }

  @Delete('secrets/:name')
  @RequirePermissions('settings:manage')
  async deleteSecret(@CurrentUser() user: AuthUser, @Param('name') name: string) {
    const secretName = parse(SecretName, name);
    await this.ai.deleteSecret(secretName);
    await this.audit.record({ actorType: 'USER', actorId: user.id, action: 'secret.delete', targetType: 'secret', outcome: 'SUCCESS', details: { name: secretName } });
    return { ok: true };
  }

  @Post('models/route-preview')
  @HttpCode(200)
  @RequirePermissions('task:read')
  async routePreview(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const input = parse(
      z.object({ privacyLevel: z.enum(['LOCAL_ONLY', 'CLOUD_REDACTED', 'CLOUD_ALLOWED']), complexity: z.number().int().min(1).max(5), capability: z.enum(['planning', 'vision', 'ocr', 'chat']).default('planning') }),
      body,
    );
    // Same inputs as real planning, so the preview predicts what a task would actually use.
    return this.ai.route({ ...input, ...(await loadRoutingInputs(this.prisma, user.id)) });
  }
}
