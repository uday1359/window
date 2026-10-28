import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { EventsService } from './events.service';
import { redactString } from '../common/redact';

export interface OperationRequest {
  operationId: string;
  operation: string;
  params: Record<string, unknown>;
  approvalHash: string | null;
  timeoutMs: number;
  taskId: string;
}

export interface OperationResult {
  ok: boolean;
  output?: Record<string, unknown>;
  error?: string;
  code?: string;
}

export interface OperationStatus {
  state: 'completed' | 'running' | 'unknown';
  result?: OperationResult;
}

export class AgentUnavailableError extends Error {}
export class OperationTimeoutError extends Error {}

interface Pending {
  resolve: (r: OperationResult) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

interface Connection {
  deviceId: string;
  ownerId: string;
  socket: WebSocket;
  sessionId: string;
  pending: Map<string, Pending>;
  statusQueries: Map<string, (s: OperationStatus) => void>;
  alive: boolean;
  /** True once the agent has reported its configuration (hello); only then may it receive work. */
  ready: boolean;
}

const Name = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);
const HelloSchema = z.object({
  type: z.literal('hello'),
  agentVersion: z.string().max(50),
  hostname: z.string().max(255),
  osVersion: z.string().max(100).optional(),
  roots: z.array(Name).max(50),
  apps: z.array(Name).max(100),
  capabilities: z.record(z.string(), z.boolean()).optional(),
});
// The agent sends resources: null when it cannot read them; the heartbeat itself must still count.
const HeartbeatSchema = z.object({ type: z.literal('heartbeat'), resources: z.record(z.string(), z.unknown()).nullish(), emergencyStop: z.boolean().optional() });
const ResultSchema = z.object({
  type: z.literal('op_result'),
  operationId: z.string().uuid(),
  ok: z.boolean(),
  output: z.record(z.string(), z.unknown()).optional(),
  error: z.string().max(2000).optional(),
  code: z.string().max(64).optional(),
});
const StatusSchema = z.object({
  type: z.literal('op_status_result'),
  operationId: z.string().uuid(),
  state: z.enum(['completed', 'running', 'unknown']),
  result: ResultSchema.omit({ type: true, operationId: true }).optional(),
});
const AgentMessage = z.discriminatedUnion('type', [HelloSchema, HeartbeatSchema, ResultSchema, StatusSchema]);

const STATUS_QUERY_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 20_000;

/** Tracks connected local agents and correlates dispatched operations with results. */
@Injectable()
export class AgentHubService {
  private readonly logger = new Logger('AgentHub');
  private readonly connections = new Map<string, Connection>();
  private pingTimer?: NodeJS.Timeout;
  private emergencyStop = false;
  private shuttingDown = false;
  private readonly closing = new Set<Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: EventsService,
  ) {}

  start(emergencyStop: boolean): void {
    this.emergencyStop = emergencyStop;
    this.pingTimer = setInterval(() => this.pingAll(), PING_INTERVAL_MS);
    this.pingTimer.unref();
  }

  stop(): void {
    this.shuttingDown = true; // the database may already be closing: skip disconnect bookkeeping
    if (this.pingTimer) clearInterval(this.pingTimer);
    for (const c of this.connections.values()) c.socket.close(1001, 'server shutting down');
  }

  isConnected(deviceId: string): boolean {
    return this.connections.get(deviceId)?.ready === true;
  }

  async attach(deviceId: string, ownerId: string, socket: WebSocket, remoteAddr: string | undefined): Promise<void> {
    const existing = this.connections.get(deviceId);
    if (existing) existing.socket.close(4000, 'replaced by a new connection');
    const conn: Connection = { deviceId, ownerId, socket, sessionId: '', pending: new Map(), statusQueries: new Map(), alive: true, ready: false };
    this.connections.set(deviceId, conn);

    // Handlers are registered before any await: the agent sends "hello" immediately on
    // open, and a message arriving before registration would be silently lost.
    socket.on('pong', () => (conn.alive = true));
    socket.on('message', (raw) => void this.onMessage(conn, raw.toString()));
    socket.on('close', () => this.onClose(conn));
    socket.on('error', (err) => this.logger.warn(`Agent socket error: ${err.message}`));

    const session = await this.prisma.agentSession.create({ data: { deviceId, remoteAddr: remoteAddr?.slice(0, 64) } });
    conn.sessionId = session.id;

    this.send(conn, { type: 'emergency_stop', active: this.emergencyStop });
    await this.prisma.agentDevice.update({ where: { id: deviceId }, data: { lastSeenAt: new Date() } });
    await this.audit.record({ actorType: 'AGENT', actorId: deviceId, action: 'agent.connect', targetType: 'device', targetId: deviceId, outcome: 'SUCCESS' });
  }

  private send(conn: Connection, msg: Record<string, unknown>): boolean {
    if (conn.socket.readyState !== conn.socket.OPEN) return false;
    conn.socket.send(JSON.stringify(msg));
    return true;
  }

  private async onMessage(conn: Connection, raw: string): Promise<void> {
    let msg: z.infer<typeof AgentMessage>;
    try {
      const parsed = AgentMessage.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        this.logger.warn(`Ignoring invalid agent message from ${conn.deviceId}`);
        return;
      }
      msg = parsed.data;
    } catch {
      this.logger.warn(`Ignoring non-JSON agent message from ${conn.deviceId}`);
      return;
    }
    try {
      switch (msg.type) {
        case 'hello':
          await this.prisma.agentDevice.update({
            where: { id: conn.deviceId },
            data: {
              agentVersion: msg.agentVersion,
              hostname: msg.hostname,
              osVersion: msg.osVersion ?? null,
              allowedRoots: msg.roots,
              capabilities: { apps: msg.apps, ...(msg.capabilities ?? {}) } as Prisma.InputJsonValue,
              lastSeenAt: new Date(),
            },
          });
          conn.ready = true;
          this.events.publish(conn.ownerId, { type: 'agent.status', deviceId: conn.deviceId, connected: true });
          break;
        case 'heartbeat':
          await this.prisma.agentDevice.update({
            where: { id: conn.deviceId },
            data: { lastSeenAt: new Date(), ...(msg.resources ? { lastResources: msg.resources as Prisma.InputJsonValue } : {}) },
          });
          if (msg.resources) this.events.publish(conn.ownerId, { type: 'agent.resources', deviceId: conn.deviceId, resources: msg.resources });
          break;
        case 'op_result': {
          const pending = conn.pending.get(msg.operationId);
          if (!pending) break; // late result after timeout; reconciled via op_status on resume
          clearTimeout(pending.timer);
          conn.pending.delete(msg.operationId);
          pending.resolve({ ok: msg.ok, output: msg.output, error: msg.error ? redactString(msg.error) : undefined, code: msg.code });
          break;
        }
        case 'op_status_result': {
          const cb = conn.statusQueries.get(msg.operationId);
          if (cb) {
            conn.statusQueries.delete(msg.operationId);
            cb({ state: msg.state, result: msg.result });
          }
          break;
        }
      }
    } catch (err) {
      this.logger.error(redactString(`Failed to handle agent message: ${(err as Error).message}`));
    }
  }

  private onClose(conn: Connection): void {
    const current = this.connections.get(conn.deviceId);
    if (current === conn) this.connections.delete(conn.deviceId);
    for (const [, p] of conn.pending) {
      clearTimeout(p.timer);
      p.reject(new AgentUnavailableError('Agent disconnected while the operation was in progress'));
    }
    conn.pending.clear();
    for (const [, cb] of conn.statusQueries) cb({ state: 'unknown' });
    conn.statusQueries.clear();
    if (this.shuttingDown) return;
    const work = this.recordClose(conn, current !== undefined && current !== conn).finally(() => this.closing.delete(work));
    this.closing.add(work);
  }

  /** Never rejects: it runs detached from the socket event, and an unhandled rejection would crash the server. */
  private async recordClose(conn: Connection, replaced: boolean): Promise<void> {
    try {
      if (conn.sessionId) {
        await this.prisma.agentSession.update({ where: { id: conn.sessionId }, data: { endedAt: new Date(), endReason: replaced ? 'replaced' : 'disconnected' } });
      }
      // A replaced connection is not a disconnect: the device is still online on its new socket.
      if (replaced) return;
      await this.audit.record({ actorType: 'AGENT', actorId: conn.deviceId, action: 'agent.disconnect', targetType: 'device', targetId: conn.deviceId, outcome: 'INFO' });
      this.events.publish(conn.ownerId, { type: 'agent.status', deviceId: conn.deviceId, connected: false });
    } catch (err) {
      this.logger.warn(redactString(`Failed to record agent disconnect: ${(err as Error).message}`));
    }
  }

  /** Waits until all sockets are closed and their disconnect bookkeeping is written (used before shutdown). */
  async drain(timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.connections.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    await Promise.allSettled([...this.closing]);
  }

  private pingAll(): void {
    for (const conn of this.connections.values()) {
      if (!conn.alive) {
        conn.socket.terminate();
        continue;
      }
      conn.alive = false;
      conn.socket.ping();
    }
  }

  /** Sends an operation to the agent and waits for its result. */
  dispatch(deviceId: string, req: OperationRequest): Promise<OperationResult> {
    const conn = this.connections.get(deviceId);
    if (!conn?.ready) return Promise.reject(new AgentUnavailableError('Agent is not connected'));
    if (this.emergencyStop) return Promise.reject(new AgentUnavailableError('Emergency stop is active'));
    return new Promise<OperationResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(req.operationId);
        this.send(conn, { type: 'cancel', operationId: req.operationId });
        reject(new OperationTimeoutError(`Operation timed out after ${req.timeoutMs} ms`));
      }, req.timeoutMs);
      conn.pending.set(req.operationId, { resolve, reject, timer });
      const sent = this.send(conn, { type: 'op', ...req });
      if (!sent) {
        clearTimeout(timer);
        conn.pending.delete(req.operationId);
        reject(new AgentUnavailableError('Agent connection is not open'));
      }
    });
  }

  /** Asks the agent's idempotency journal what happened to an operation. */
  queryStatus(deviceId: string, operationId: string): Promise<OperationStatus> {
    const conn = this.connections.get(deviceId);
    if (!conn) return Promise.resolve({ state: 'unknown' });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        conn.statusQueries.delete(operationId);
        resolve({ state: 'unknown' });
      }, STATUS_QUERY_TIMEOUT_MS);
      conn.statusQueries.set(operationId, (s) => {
        clearTimeout(timer);
        resolve(s);
      });
      if (!this.send(conn, { type: 'op_status', operationId })) {
        clearTimeout(timer);
        conn.statusQueries.delete(operationId);
        resolve({ state: 'unknown' });
      }
    });
  }

  cancel(deviceId: string, operationId: string): void {
    const conn = this.connections.get(deviceId);
    if (conn) this.send(conn, { type: 'cancel', operationId });
  }

  /** Propagates emergency stop to every connected agent; pending operations are failed. */
  setEmergencyStop(active: boolean): void {
    this.emergencyStop = active;
    for (const conn of this.connections.values()) {
      this.send(conn, { type: 'emergency_stop', active });
      if (active) {
        for (const [id, p] of conn.pending) {
          clearTimeout(p.timer);
          p.reject(new AgentUnavailableError('Emergency stop activated'));
          conn.pending.delete(id);
        }
      }
    }
  }

  disconnect(deviceId: string, reason: string): void {
    const conn = this.connections.get(deviceId);
    if (!conn) return;
    this.send(conn, { type: 'revoked', reason });
    conn.socket.close(4001, reason.slice(0, 100));
  }
}
