import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { TaskStatus } from '../generated/prisma/client';
import { z } from 'zod';
import { parse } from '../common/errors';
import { AuthUser, CurrentUser, RequirePermissions } from '../auth/auth.types';
import { TasksService } from './tasks.service';
import { AttachmentInput, MAX_ATTACHMENTS } from './attachments.service';

const CreateTaskSchema = z.object({
  instruction: z.string().trim().min(1, 'Instruction is required').max(5000),
  title: z.string().trim().min(1).max(200).optional(),
  privacyLevel: z.enum(['LOCAL_ONLY', 'CLOUD_REDACTED', 'CLOUD_ALLOWED']).default('LOCAL_ONLY'),
  priority: z.number().int().min(-10).max(10).default(0),
  deadline: z.coerce.date().optional(),
  dependsOn: z.array(z.string().uuid()).max(20).default([]),
  agentDeviceId: z.string().uuid().optional(),
  attachments: z.array(AttachmentInput).max(MAX_ATTACHMENTS).default([]),
});
const IdempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/, 'Idempotency-Key must be 8-100 URL-safe characters');
const ListSchema = z.object({
  status: z.string().optional().transform((s) => (s ? s.split(',').filter((x): x is TaskStatus => x in TaskStatus) : undefined)),
  search: z.string().max(200).optional(),
  all: z.enum(['0', '1']).optional().transform((v) => v === '1'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
const ResumeSchema = z.object({ confirmUncertain: z.boolean().default(false) }).prefault({});
const ReorderSchema = z.object({ queuePosition: z.number().int().min(-1_000_000).max(1_000_000) });
const ClarifySchema = z.object({ answer: z.string().trim().min(1).max(2000) });

@Controller('api/tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Post()
  @RequirePermissions('task:create')
  async create(@CurrentUser() user: AuthUser, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) res: Response) {
    const input = parse(CreateTaskSchema, body);
    const idempotencyKey = key === undefined ? undefined : parse(IdempotencyKey, key);
    const { task, duplicate } = await this.tasks.create(user, { ...input, idempotencyKey });
    res.status(duplicate ? 200 : 201);
    return { ...task, duplicate };
  }

  @Get()
  @RequirePermissions('task:read')
  list(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    return this.tasks.list(user, parse(ListSchema, query));
  }

  @Get('queue')
  @RequirePermissions('task:read')
  queue(@CurrentUser() user: AuthUser) {
    return this.tasks.queue(user);
  }

  @Get(':id')
  @RequirePermissions('task:read')
  detail(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.tasks.detail(user, id);
  }

  @Get(':id/attachments/:attachmentId')
  @RequirePermissions('task:read')
  async attachment(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('attachmentId', ParseUUIDPipe) attachmentId: string, @Res() res: Response) {
    const { mediaType, bytes } = await this.tasks.attachment(user, id, attachmentId);
    // Served inline as an image only; nosniff (helmet) stops browsers reinterpreting it.
    res.setHeader('content-type', mediaType);
    res.setHeader('content-disposition', 'inline');
    res.setHeader('cache-control', 'private, no-store');
    res.send(bytes);
  }

  @Get(':id/audit')
  @RequirePermissions('task:read', 'audit:read')
  audit(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.tasks.auditTrail(user, id);
  }

  @Post(':id/pause')
  @HttpCode(200)
  @RequirePermissions('task:control')
  async pause(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.tasks.pause(user, id);
    return { ok: true };
  }

  @Post(':id/resume')
  @HttpCode(200)
  @RequirePermissions('task:control')
  resume(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.tasks.resume(user, id, parse(ResumeSchema, body ?? {}).confirmUncertain);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermissions('task:control')
  async cancel(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.tasks.cancel(user, id);
    return { ok: true };
  }

  @Patch(':id/position')
  @RequirePermissions('task:control')
  async reorder(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    await this.tasks.reorder(user, id, parse(ReorderSchema, body).queuePosition);
    return { ok: true };
  }

  @Post(':id/clarify')
  @HttpCode(200)
  @RequirePermissions('task:create')
  async clarify(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    await this.tasks.clarify(user, id, parse(ClarifySchema, body).answer);
    return { ok: true };
  }
}
