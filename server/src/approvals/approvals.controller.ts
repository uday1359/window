import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { parse } from '../common/errors';
import { AuthUser, CurrentUser, RequirePermissions } from '../auth/auth.types';
import { ApprovalsService } from './approvals.service';

const DecisionSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT']),
  actionHash: z.string().regex(/^[0-9a-f]{64}$/),
  comment: z.string().max(500).optional(),
  // Voice is deliberately not an accepted channel: voice alone never authorises actions.
  channel: z.enum(['web', 'desktop']).default('web'),
});

@Controller('api/approvals')
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get()
  @RequirePermissions('task:read')
  list(@CurrentUser() user: AuthUser, @Query('status') status?: string) {
    return this.approvals.list(user, status);
  }

  @Post(':id/decision')
  @HttpCode(200)
  @RequirePermissions('approval:decide')
  async decide(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(DecisionSchema, body);
    await this.approvals.decide(user, id, input.decision === 'APPROVE', input.actionHash, input.comment, input.channel ?? 'web');
    return { ok: true };
  }
}
