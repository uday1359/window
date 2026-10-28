import { Body, Controller, Get, HttpCode, HttpException, HttpStatus, NotFoundException, Param, ParseUUIDPipe, Post, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AgentHubService } from '../realtime/agent-hub.service';
import { parse } from '../common/errors';
import { RateLimiter } from '../common/rate-limit';
import { randomPairingCode, randomToken, sha256 } from '../common/crypto';
import { AuthUser, CurrentUser, Public, RequirePermissions } from '../auth/auth.types';

const PAIRING_TTL_MS = 10 * 60_000;
const PairSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{10}$/),
  name: z.string().trim().min(1).max(100),
  hostname: z.string().trim().min(1).max(255),
  osVersion: z.string().trim().max(100).optional(),
});

@Controller('api/agents')
export class AgentsController {
  private readonly pairLimiter = new RateLimiter(10, 60_000);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly hub: AgentHubService,
  ) {}

  @Get()
  @RequirePermissions('agent:read')
  async list(@CurrentUser() user: AuthUser) {
    const devices = await this.prisma.agentDevice.findMany({
      where: { ownerId: user.id },
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, hostname: true, osVersion: true, agentVersion: true, status: true, capabilities: true, allowedRoots: true, lastResources: true, lastSeenAt: true, createdAt: true, revokedAt: true },
    });
    return devices.map((d) => ({ ...d, connected: this.hub.isConnected(d.id) }));
  }

  /** One-time code shown in the dashboard and typed into the agent's pairing command. */
  @Post('pairing-codes')
  @RequirePermissions('agent:manage')
  async createPairingCode(@CurrentUser() user: AuthUser) {
    const code = randomPairingCode();
    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
    await this.prisma.pairingCode.create({ data: { userId: user.id, codeHash: sha256(code), expiresAt } });
    await this.audit.record({ actorType: 'USER', actorId: user.id, action: 'agent.pairing_code', outcome: 'SUCCESS' });
    return { code, expiresAt };
  }

  /** Called by the agent. Exchanges a valid one-time code for a long-lived device token. */
  @Public()
  @Post('pair')
  async pair(@Body() body: unknown, @Req() req: Request) {
    if (!this.pairLimiter.take(req.ip ?? 'unknown')) throw new HttpException('Too many pairing attempts', HttpStatus.TOO_MANY_REQUESTS);
    const input = parse(PairSchema, body);
    const token = randomToken();
    const device = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.pairingCode.updateMany({ where: { codeHash: sha256(input.code), usedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date() } });
      if (count === 0) return null;
      const code = await tx.pairingCode.findUniqueOrThrow({ where: { codeHash: sha256(input.code) } });
      const created = await tx.agentDevice.create({
        data: { ownerId: code.userId, name: input.name, hostname: input.hostname, osVersion: input.osVersion, tokenHash: sha256(token) },
      });
      await this.audit.record({ actorType: 'AGENT', actorId: created.id, action: 'agent.pair', targetType: 'device', targetId: created.id, outcome: 'SUCCESS', details: { hostname: input.hostname } }, tx);
      return created;
    });
    if (!device) {
      await this.audit.record({ actorType: 'AGENT', action: 'agent.pair', outcome: 'DENIED', details: { reason: 'invalid_or_expired_code' } });
      throw new UnauthorizedException('Pairing code is invalid, expired or already used');
    }
    return { deviceId: device.id, token };
  }

  @Post(':id/revoke')
  @HttpCode(200)
  @RequirePermissions('agent:manage')
  async revoke(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const { count } = await this.prisma.agentDevice.updateMany({ where: { id, ownerId: user.id, status: 'ACTIVE' }, data: { status: 'REVOKED', revokedAt: new Date() } });
    if (count === 0) throw new NotFoundException('Active device not found');
    this.hub.disconnect(id, 'Device access revoked');
    await this.audit.record({ actorType: 'USER', actorId: user.id, action: 'agent.revoke', targetType: 'device', targetId: id, outcome: 'SUCCESS' });
    return { ok: true };
  }
}
