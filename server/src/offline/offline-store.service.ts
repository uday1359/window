import { Global, Injectable, Logger, Module, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { loadConfig } from '../config/config';
import { redactString } from '../common/redact';

/** Writes that may be queued. Anything else in the file is ignored (the file is not trusted blindly). */
const ALLOWED: Record<string, ReadonlyArray<'create' | 'update'>> = {
  auditEvent: ['create'],
  notification: ['create'],
  taskExecution: ['update'],
  taskStep: ['update'],
  taskCheckpoint: ['create'],
};
export type QueueModel = keyof typeof ALLOWED;

export interface QueuedWrite {
  id: string;
  at: string;
  model: QueueModel;
  action: 'create' | 'update';
  args: Record<string, unknown>;
}

export interface OfflineStatus {
  databaseAvailable: boolean;
  pending: number;
  oldestQueuedAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
}

const MAX_ENTRIES = 100_000;
const SYNC_INTERVAL_MS = 10_000;
// "Unable to start a transaction" is how Prisma reports a transaction when no connection can be made.
const UNAVAILABLE = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|pool is closed|pool timeout|Can't reach database|connection (was )?(closed|refused|lost)|server has gone away|Lost connection|retrieve connection from pool|Unable to start a transaction|Code: `?450(2[5-9]|3\d)`?/i;

/** A queued write from one line of the file, or null if the line is unreadable or not allowed. */
function parseEntry(line: string): QueuedWrite | null {
  try {
    const e = JSON.parse(line) as QueuedWrite;
    return e && typeof e.id === 'string' && ALLOWED[e.model]?.includes(e.action) && e.args && typeof e.args === 'object' ? e : null;
  } catch {
    return null;
  }
}

/** True when an error means "the database is unreachable", as opposed to a bad query or constraint. */
export function isDatabaseUnavailable(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientInitializationError) return true;
  if (err instanceof Prisma.PrismaClientKnownRequestError && ['P1001', 'P1002', 'P1008', 'P1017', 'P2024'].includes(err.code)) return true;
  if (err instanceof Prisma.PrismaClientRustPanicError) return false;
  const message = err instanceof Error ? `${err.message} ${String((err as { cause?: unknown }).cause ?? '')}` : String(err);
  return UNAVAILABLE.test(message);
}

/**
 * Local fallback for writes that must not be lost while MySQL is unavailable.
 *
 * Writes are appended (and flushed to disk) as JSON lines to OFFLINE_QUEUE_FILE
 * (default data/offline-queue.jsonl). Every 10 seconds, while anything is queued or the database
 * was seen down, the store checks MySQL and replays the queue in order. Replays are idempotent:
 * creates carry their own unique id (a duplicate is treated as already applied) and updates set
 * absolute values. Listeners registered with onDatabaseAvailable() run when MySQL comes back.
 *
 * Only these writes are queued: audit events, notifications and the outcome of agent operations
 * (execution, step, checkpoint). Reads (dashboard, sign-in) still need MySQL.
 */
@Injectable()
export class OfflineStore implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('OfflineStore');
  private timer?: NodeJS.Timeout;
  private down = false;
  private syncing = false;
  private lastSyncAt: string | null = null;
  private lastError: string | null = null;
  private readonly listeners: Array<() => Promise<void>> = [];

  constructor(private readonly prisma: PrismaService) {}

  private get file(): string {
    return loadConfig().OFFLINE_QUEUE_FILE;
  }

  onApplicationBootstrap(): void {
    if (process.env.WINAGENT_DISABLE_ORCHESTRATOR === '1') return;
    this.timer = setInterval(() => void this.sync(), SYNC_INTERVAL_MS);
    this.timer.unref();
    if (this.pending().length) this.down = true; // left over from a previous run: replay soon
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Called by anyone who saw the database fail; the next sync re-checks it. */
  markUnavailable(err?: unknown): void {
    if (!this.down) this.logger.warn(`Database unavailable${err ? `: ${redactString((err as Error).message ?? String(err)).slice(0, 200)}` : ''}. Writes are kept in ${this.file} until it is back.`);
    this.down = true;
  }

  get databaseAvailable(): boolean {
    return !this.down;
  }

  /** Runs fn when the database is reachable again (e.g. deferred start-up work). */
  onDatabaseAvailable(fn: () => Promise<void>): void {
    this.listeners.push(fn);
  }

  /** Appends a write to the local file, flushed to disk before returning. */
  enqueue(model: QueueModel, action: 'create' | 'update', args: Record<string, unknown>): QueuedWrite {
    if (!ALLOWED[model]?.includes(action)) throw new Error(`${model}.${action} may not be queued`);
    if (this.pending().length >= MAX_ENTRIES) throw new Error(`Offline queue is full (${MAX_ENTRIES} entries); the write was not saved`);
    const entry: QueuedWrite = { id: randomUUID(), at: new Date().toISOString(), model, action, args: JSON.parse(JSON.stringify(args)) };
    mkdirSync(dirname(this.file), { recursive: true });
    const fd = openSync(this.file, 'a');
    try {
      appendFileSync(fd, `${JSON.stringify(entry)}\n`, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.markUnavailable();
    return entry;
  }

  /**
   * Performs a write now, or queues it if the database is unreachable. Returns false when queued.
   * Other errors (constraint violations, bad data) are thrown as usual.
   */
  async write(model: QueueModel, action: 'create' | 'update', args: Record<string, unknown>): Promise<boolean> {
    try {
      await this.apply(model, action, args);
      return true;
    } catch (err) {
      if (!isDatabaseUnavailable(err)) throw err;
      this.enqueue(model, action, args);
      return false;
    }
  }

  pending(): QueuedWrite[] {
    if (!existsSync(this.file)) return [];
    const out: QueuedWrite[] = [];
    for (const line of readFileSync(this.file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const e = parseEntry(line);
      if (e) out.push(e);
      else this.logger.warn('Ignoring an invalid line in the offline queue (it is removed at the next sync)');
    }
    return out;
  }

  status(): OfflineStatus {
    const p = this.pending();
    return { databaseAvailable: !this.down, pending: p.length, oldestQueuedAt: p[0]?.at ?? null, lastSyncAt: this.lastSyncAt, lastError: this.lastError };
  }

  private async apply(model: QueueModel, action: 'create' | 'update', args: Record<string, unknown>): Promise<void> {
    const delegate = (this.prisma as unknown as Record<string, Record<string, (a: unknown) => Promise<unknown>>>)[model];
    await delegate[action](args);
  }

  /** Replays queued writes in order when MySQL answers. Safe to call at any time. */
  async sync(): Promise<number> {
    if (this.syncing || !this.down) return 0;
    this.syncing = true;
    let applied = 0;
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      const entries = this.pending();
      for (const e of entries) {
        try {
          await this.apply(e.model, e.action, e.args);
        } catch (err) {
          if (isDatabaseUnavailable(err)) throw err;
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            // Already written (e.g. the server stopped between the write and removing the line).
          } else if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
            this.logger.warn(`Skipping queued ${e.model}.${e.action}: the record no longer exists`);
          } else {
            this.logger.error(redactString(`Skipping queued ${e.model}.${e.action} that MySQL rejected: ${(err as Error).message}`));
          }
        }
        applied++;
        this.remove(e.id);
      }
      this.down = false;
      this.lastError = null;
      this.lastSyncAt = new Date().toISOString();
      if (applied) this.logger.log(`Database available again: ${applied} queued write(s) saved to MySQL`);
      for (const fn of this.listeners) {
        await fn().catch((err: Error) => this.logger.error(redactString(`Post-reconnect step failed: ${err.message}`)));
      }
    } catch (err) {
      this.lastError = redactString((err as Error).message ?? String(err)).slice(0, 300);
      if (!isDatabaseUnavailable(err)) this.logger.error(`Offline sync failed: ${this.lastError}`);
    } finally {
      this.syncing = false;
    }
    return applied;
  }

  /**
   * Removes one saved entry by id, keeping everything appended meanwhile (no await between read
   * and write, so it cannot interleave with enqueue in this process). Unreadable lines are dropped.
   * Atomic via a temporary file.
   */
  private remove(id: string): void {
    const keep = readFileSync(this.file, 'utf8')
      .split('\n')
      .filter((line) => {
        const e = line.trim() ? parseEntry(line) : null;
        return e !== null && e.id !== id;
      });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, keep.map((l) => `${l}\n`).join(''), 'utf8');
    renameSync(tmp, this.file);
  }
}

@Global()
@Module({ providers: [OfflineStore], exports: [OfflineStore] })
export class OfflineModule {}
