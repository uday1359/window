import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import { AuthService } from '../auth/auth.service';
import { SESSION_COOKIE } from '../auth/auth.types';
import { sha256 } from '../common/crypto';
import { loadConfig } from '../config/config';
import { PrismaService } from '../prisma/prisma.service';
import { AgentHubService } from './agent-hub.service';
import { EventsService } from './events.service';

const SESSION_RECHECK_MS = 60_000;

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function reject(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/**
 * Authenticates WebSocket upgrades before the handshake completes:
 *  - /ws/events: dashboard clients, session cookie + Origin allow-list
 *  - /ws/agent:  local agents, device bearer token
 */
@Injectable()
export class WsGatewayService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('WsGateway');
  private readonly dashboardWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  private readonly agentWss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  private recheckTimer?: NodeJS.Timeout;

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    private readonly hub: AgentHubService,
  ) {}

  allowedOrigins(): Set<string> {
    const cfg = loadConfig();
    const own = [cfg.HOST, 'localhost', '127.0.0.1'].flatMap((h) => [`http://${h}:${cfg.PORT}`, `https://${h}:${cfg.PORT}`]);
    return new Set([cfg.WEB_ORIGIN, ...own, ...(cfg.PUBLIC_ORIGIN ? [new URL(cfg.PUBLIC_ORIGIN).origin] : []), 'http://localhost:5173', 'http://127.0.0.1:5173']);
  }

  onApplicationBootstrap(): void {
    const server: Server = this.adapterHost.httpAdapter.getHttpServer();
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = (req.url ?? '').split('?')[0];
      if (path === '/ws/events') void this.upgradeDashboard(req, socket, head);
      else if (path === '/ws/agent') void this.upgradeAgent(req, socket, head);
      else reject(socket, 404, 'Not Found');
    });
    this.recheckTimer = setInterval(() => void this.recheckSessions(), SESSION_RECHECK_MS);
    this.recheckTimer.unref();
  }

  onApplicationShutdown(): void {
    if (this.recheckTimer) clearInterval(this.recheckTimer);
    this.dashboardWss.close();
    this.agentWss.close();
  }

  private async upgradeDashboard(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    try {
      const origin = req.headers.origin;
      if (!origin || !this.allowedOrigins().has(origin)) return reject(socket, 403, 'Forbidden');
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      const user = await this.auth.resolveSession(token);
      if (!user) return reject(socket, 401, 'Unauthorized');
      this.dashboardWss.handleUpgrade(req, socket, head, (ws) => {
        const remove = this.events.add({ socket: ws, userId: user.id, seesAll: user.permissions.has('task:read_all'), sessionId: user.sessionId });
        ws.on('close', remove);
        ws.on('error', remove);
        // The dashboard never sends commands over this channel; anything received is ignored.
        ws.on('message', () => undefined);
        ws.send(JSON.stringify({ type: 'hello', userId: user.id }));
      });
    } catch (err) {
      this.logger.warn(`Dashboard upgrade failed: ${(err as Error).message}`);
      reject(socket, 500, 'Internal Server Error');
    }
  }

  private async upgradeAgent(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    try {
      const header = req.headers.authorization ?? '';
      const match = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(header);
      if (!match) return reject(socket, 401, 'Unauthorized');
      const device = await this.prisma.agentDevice.findUnique({ where: { tokenHash: sha256(match[1]) } });
      if (!device || device.status !== 'ACTIVE') return reject(socket, 401, 'Unauthorized');
      this.agentWss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        void this.hub.attach(device.id, device.ownerId, ws, req.socket.remoteAddress).catch((err) => {
          this.logger.error(`Agent attach failed: ${(err as Error).message}`);
          ws.close(1011, 'attach failed');
        });
      });
    } catch (err) {
      this.logger.warn(`Agent upgrade failed: ${(err as Error).message}`);
      reject(socket, 500, 'Internal Server Error');
    }
  }

  /** Closes dashboard sockets whose session was revoked or expired. */
  private async recheckSessions(): Promise<void> {
    for (const sub of this.events.subscriberList()) {
      const session = await this.prisma.userSession.findUnique({ where: { id: sub.sessionId } });
      if (!session || session.revokedAt || session.expiresAt <= new Date()) sub.socket.close(4001, 'session ended');
    }
  }
}
