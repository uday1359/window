import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Res } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import type { Response } from 'express';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { PolicyService } from '../policy/policy.service';
import { TasksService } from '../tasks/tasks.service';
import { parse } from '../common/errors';
import { containsSecret } from '../common/redact';
import { generalizeTaskFolder, PlanValidationError, validatePlan } from '../operations/operations';
import { AuthUser, CurrentUser, RequirePermissions } from '../auth/auth.types';

const MemorySchema = z.object({
  kind: z.enum(['preference', 'fact', 'recovery_strategy', 'task_summary']),
  content: z.string().trim().min(1).max(5000),
  source: z.string().max(100).optional(),
});
const SkillFromTaskSchema = z.object({ name: z.string().trim().min(1).max(100), description: z.string().trim().max(500).default('') });
const SkillPatchSchema = z.object({ name: z.string().trim().min(1).max(100).optional(), description: z.string().trim().max(500).optional(), enabled: z.boolean().optional() });

function rejectSecrets(...texts: string[]): void {
  if (texts.some((t) => containsSecret(t))) throw new BadRequestException('Content appears to contain a password, token or key; secrets are never stored in memory');
}

@Controller('api')
export class MemoryController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly policy: PolicyService,
    private readonly tasks: TasksService,
  ) {}

  // ------------------------------------------------------------ memory
  @Get('memory')
  @RequirePermissions('memory:manage')
  list(@CurrentUser() user: AuthUser) {
    return this.prisma.memoryRecord.findMany({ where: { userId: user.id }, orderBy: { updatedAt: 'desc' } });
  }

  @Post('memory')
  @RequirePermissions('memory:manage')
  async create(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const input = parse(MemorySchema, body);
    rejectSecrets(input.content);
    const rec = await this.prisma.memoryRecord.create({ data: { ...input, userId: user.id } });
    await this.audit.record({ actorType: 'USER', actorId: user.id, action: 'memory.create', targetType: 'memory', targetId: rec.id, outcome: 'SUCCESS' });
    return rec;
  }

  @Patch('memory/:id')
  @RequirePermissions('memory:manage')
  async update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(MemorySchema.pick({ content: true }), body);
    rejectSecrets(input.content);
    const { count } = await this.prisma.memoryRecord.updateMany({ where: { id, userId: user.id }, data: { content: input.content } });
    if (!count) throw new NotFoundException('Memory record not found');
    await this.audit.record({ actorType: 'USER', actorId: user.id, action: 'memory.update', targetType: 'memory', targetId: id, outcome: 'SUCCESS' });
    return { ok: true };
  }

  @Delete('memory/:id')
  @RequirePermissions('memory:manage')
  async remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const { count } = await this.prisma.memoryRecord.deleteMany({ where: { id, userId: user.id } });
    if (!count) throw new NotFoundException('Memory record not found');
    await this.audit.record({ actorType: 'USER', actorId: user.id, action: 'memory.delete', targetType: 'memory', targetId: id, outcome: 'SUCCESS' });
    return { ok: true };
  }

  @Post('memory/delete-all')
  @HttpCode(200)
  @RequirePermissions('memory:manage')
  async removeAll(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    parse(z.object({ confirm: z.literal(true) }), body);
    const { count } = await this.prisma.memoryRecord.deleteMany({ where: { userId: user.id } });
    await this.audit.record({ actorType: 'USER', actorId: user.id, action: 'memory.delete_all', outcome: 'SUCCESS', details: { count } });
    return { deleted: count };
  }

  @Get('memory/export')
  @RequirePermissions('memory:manage')
  async export(@CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    const [memory, skills, preferences] = await Promise.all([
      this.prisma.memoryRecord.findMany({ where: { userId: user.id } }),
      this.prisma.workflowSkill.findMany({ where: { userId: user.id } }),
      this.prisma.userPreference.findMany({ where: { userId: user.id }, select: { key: true, value: true, updatedAt: true } }),
    ]);
    await this.audit.record({ actorType: 'USER', actorId: user.id, action: 'memory.export', outcome: 'SUCCESS' });
    res.setHeader('content-disposition', 'attachment; filename="winagent-memory-export.json"');
    return { exportedAt: new Date().toISOString(), memory, skills, preferences };
  }

  // ------------------------------------------------------------ skills (validated reusable workflows)
  @Get('skills')
  @RequirePermissions('memory:manage')
  skills(@CurrentUser() user: AuthUser) {
    return this.prisma.workflowSkill.findMany({ where: { userId: user.id }, orderBy: { updatedAt: 'desc' } });
  }

  @Post('skills/from-task/:taskId')
  @RequirePermissions('memory:manage')
  async fromTask(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) taskId: string, @Body() body: unknown) {
    const input = parse(SkillFromTaskSchema, body);
    const task = await this.tasks.getOwned(user, taskId, true);
    if (task.status !== 'SUCCEEDED' || !task.plan) throw new ConflictException('Only verified successful tasks can be saved as skills');
    rejectSecrets(JSON.stringify(task.plan), input.name, input.description ?? '');
    const plan = generalizeTaskFolder(task.plan as Record<string, unknown>, task.id);
    const skill = await this.prisma.workflowSkill.create({
      data: {
        userId: user.id,
        name: input.name,
        description: input.description || task.title,
        plan: plan as Prisma.InputJsonValue,
        successCriteria: generalizeTaskFolder(task.successCriteria ?? [], task.id) as Prisma.InputJsonValue,
        sourceTaskId: task.id,
        validationStatus: 'VALID',
        lastValidatedAt: new Date(),
      },
    });
    await this.audit.record({ actorType: 'USER', actorId: user.id, action: 'skill.create', targetType: 'skill', targetId: skill.id, taskId, outcome: 'SUCCESS' });
    return skill;
  }

  @Patch('skills/:id')
  @RequirePermissions('memory:manage')
  async patchSkill(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(SkillPatchSchema, body);
    rejectSecrets(input.name ?? '', input.description ?? '');
    const skill = await this.prisma.workflowSkill.findFirst({ where: { id, userId: user.id } });
    if (!skill) throw new NotFoundException('Skill not found');
    if (input.enabled === true && skill.validationStatus !== 'VALID') throw new ConflictException('Validate the skill successfully before enabling it');
    const updated = await this.prisma.workflowSkill.update({ where: { id }, data: input });
    await this.audit.record({ actorType: 'USER', actorId: user.id, action: 'skill.update', targetType: 'skill', targetId: id, outcome: 'SUCCESS', details: { fields: Object.keys(input) } });
    return updated;
  }

  @Delete('skills/:id')
  @RequirePermissions('memory:manage')
  async deleteSkill(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const { count } = await this.prisma.workflowSkill.deleteMany({ where: { id, userId: user.id } });
    if (!count) throw new NotFoundException('Skill not found');
    await this.audit.record({ actorType: 'USER', actorId: user.id, action: 'skill.delete', targetType: 'skill', targetId: id, outcome: 'SUCCESS' });
    return { ok: true };
  }

  /** Re-validates the stored plan against the current whitelist and policies; failures disable it. */
  @Post('skills/:id/validate')
  @HttpCode(200)
  @RequirePermissions('memory:manage')
  async validate(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.validateSkill(user, id);
  }

  @Post('skills/:id/run')
  @RequirePermissions('memory:manage', 'task:create')
  async run(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const result = await this.validateSkill(user, id);
    if (result.validationStatus !== 'VALID') throw new ConflictException(`Skill failed validation and was disabled: ${result.validationError}`);
    const skill = await this.prisma.workflowSkill.findUniqueOrThrow({ where: { id } });
    if (!skill.enabled) throw new ConflictException('Skill is disabled; enable it before running it');
    const plan = validatePlan(skill.plan);
    const { task } = await this.tasks.create(user, {
      instruction: `Run skill "${skill.name}": ${skill.description}`,
      title: skill.name,
      privacyLevel: 'LOCAL_ONLY',
      priority: 0,
      dependsOn: [],
      presetPlan: plan,
      skillId: skill.id,
    });
    await this.prisma.workflowSkill.update({ where: { id }, data: { useCount: { increment: 1 } } });
    return task;
  }

  private async validateSkill(user: AuthUser, id: string) {
    const skill = await this.prisma.workflowSkill.findFirst({ where: { id, userId: user.id } });
    if (!skill) throw new NotFoundException('Skill not found');
    let error: string | null = null;
    try {
      const plan = validatePlan(skill.plan);
      const device = await this.prisma.agentDevice.findFirst({ where: { ownerId: user.id, status: 'ACTIVE' }, orderBy: { lastSeenAt: 'desc' } });
      const ctx = await this.policy.context(user.id, device);
      const denied = plan.steps.map((s) => this.policy.evaluate(ctx, s.operation, s.params).denied).filter(Boolean);
      if (denied.length) error = `Policy: ${denied.join('; ')}`;
    } catch (err) {
      error = err instanceof PlanValidationError ? err.message : 'Stored plan is unreadable';
    }
    const updated = await this.prisma.workflowSkill.update({
      where: { id },
      data: { validationStatus: error ? 'INVALID' : 'VALID', validationError: error?.slice(0, 1000) ?? null, lastValidatedAt: new Date(), ...(error ? { enabled: false } : {}) },
    });
    await this.audit.record({ actorType: 'USER', actorId: user.id, action: 'skill.validate', targetType: 'skill', targetId: id, outcome: error ? 'FAILURE' : 'SUCCESS', details: error ? { error } : undefined });
    return updated;
  }
}
