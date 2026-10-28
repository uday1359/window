import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Prisma } from '../generated/prisma/client';
import { resetConfigCache } from '../config/config';
import { isDatabaseUnavailable, OfflineStore } from './offline-store.service';
import type { PrismaService } from '../prisma/prisma.service';

const offline = () => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3306'), { code: 'ECONNREFUSED' });
const known = (code: string) => new Prisma.PrismaClientKnownRequestError(`error ${code}`, { code, clientVersion: 'test' });

/** A stand-in for Prisma whose availability can be switched off and on. */
function fakeDb() {
  const calls: Array<[string, string, unknown]> = [];
  const state = { up: true, failWith: new Map<string, Error>() };
  const delegate = (model: string) =>
    new Proxy(
      {},
      {
        get: (_t, action: string) => async (args: unknown) => {
          if (!state.up) throw offline();
          const key = JSON.stringify(args);
          const scripted = state.failWith.get(key);
          if (scripted) throw scripted;
          calls.push([model, action, args]);
          return {};
        },
      },
    );
  const db = {
    $queryRaw: async () => {
      if (!state.up) throw offline();
      return [1];
    },
    auditEvent: delegate('auditEvent'),
    notification: delegate('notification'),
    taskExecution: delegate('taskExecution'),
    taskStep: delegate('taskStep'),
    taskCheckpoint: delegate('taskCheckpoint'),
  };
  return { db: db as unknown as PrismaService, calls, state };
}

describe('OfflineStore', () => {
  let dir: string;
  let file: string;
  const saved = { ...process.env };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'winagent-offline-'));
    file = join(dir, 'queue.jsonl');
    process.env = { ...saved, WINAGENT_SKIP_ENV_FILE: '1', DATABASE_URL: 'mysql://u:p@127.0.0.1:3306/winagent', AI_SERVICE_TOKEN: 'x'.repeat(40), OFFLINE_QUEUE_FILE: file };
    resetConfigCache();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.env = { ...saved };
    resetConfigCache();
  });

  it('writes straight to MySQL when it is available', async () => {
    const { db, calls } = fakeDb();
    const store = new OfflineStore(db);
    expect(await store.write('notification', 'create', { data: { id: 'n1' } })).toBe(true);
    expect(calls).toEqual([['notification', 'create', { data: { id: 'n1' } }]]);
    expect(store.pending()).toEqual([]);
    expect(store.databaseAvailable).toBe(true);
  });

  it('keeps writes in the local file while MySQL is unavailable, flushed in order', async () => {
    const { db, state } = fakeDb();
    state.up = false;
    const store = new OfflineStore(db);
    const when = new Date('2026-10-28T10:00:00Z');
    expect(await store.write('notification', 'create', { data: { id: 'n1', createdAt: when } })).toBe(false);
    store.enqueue('taskStep', 'update', { where: { id: 's1' }, data: { status: 'SUCCEEDED' } });
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.model)).toEqual(['notification', 'taskStep']);
    expect(lines[0].args.data.createdAt).toBe('2026-10-28T10:00:00.000Z');
    expect(store.status()).toMatchObject({ databaseAvailable: false, pending: 2 });
  });

  it('does not queue ordinary errors such as constraint violations', async () => {
    const { db, state } = fakeDb();
    state.failWith.set(JSON.stringify({ data: { id: 'dup' } }), known('P2002'));
    const store = new OfflineStore(db);
    await expect(store.write('notification', 'create', { data: { id: 'dup' } })).rejects.toThrow('P2002');
    expect(store.pending()).toEqual([]);
  });

  it('replays the queue in order when MySQL is back, then runs the reconnect hooks', async () => {
    const { db, state, calls } = fakeDb();
    state.up = false;
    const store = new OfflineStore(db);
    store.enqueue('taskExecution', 'update', { where: { operationId: 'o1' }, data: { status: 'SUCCEEDED' } });
    store.enqueue('taskStep', 'update', { where: { id: 's1' }, data: { status: 'SUCCEEDED' } });
    store.enqueue('auditEvent', 'create', { data: { offlineId: 'a1', action: 'step.succeeded' } });
    const hook = jest.fn(async () => undefined);
    store.onDatabaseAvailable(hook);

    expect(await store.sync()).toBe(0); // still down: nothing lost, nothing applied
    expect(store.pending()).toHaveLength(3);
    expect(hook).not.toHaveBeenCalled();

    state.up = true;
    expect(await store.sync()).toBe(3);
    expect(calls.map(([m]) => m)).toEqual(['taskExecution', 'taskStep', 'auditEvent']);
    expect(store.pending()).toEqual([]);
    expect(store.status()).toMatchObject({ databaseAvailable: true, pending: 0, lastError: null });
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('treats an already-written entry as done and skips records that no longer exist', async () => {
    const { db, state, calls } = fakeDb();
    state.up = false;
    const store = new OfflineStore(db);
    store.enqueue('auditEvent', 'create', { data: { offlineId: 'already-there' } });
    store.enqueue('taskStep', 'update', { where: { id: 'deleted' }, data: { status: 'FAILED' } });
    store.enqueue('notification', 'create', { data: { id: 'n2' } });
    state.up = true;
    state.failWith.set(JSON.stringify({ data: { offlineId: 'already-there' } }), known('P2002'));
    state.failWith.set(JSON.stringify({ where: { id: 'deleted' }, data: { status: 'FAILED' } }), known('P2025'));
    expect(await store.sync()).toBe(3);
    expect(calls).toEqual([['notification', 'create', { data: { id: 'n2' } }]]);
    expect(store.pending()).toEqual([]);
  });

  it('stops replaying if MySQL drops again, keeping the rest for later', async () => {
    const { db, state } = fakeDb();
    state.up = false;
    const store = new OfflineStore(db);
    store.enqueue('notification', 'create', { data: { id: 'first' } });
    store.enqueue('notification', 'create', { data: { id: 'second' } });
    state.up = true;
    state.failWith.set(JSON.stringify({ data: { id: 'second' } }), offline());
    expect(await store.sync()).toBe(1);
    expect(store.pending().map((e) => (e.args.data as { id: string }).id)).toEqual(['second']);
    expect(store.databaseAvailable).toBe(false);
  });

  it('ignores corrupt lines and entries that are not on the allow list', async () => {
    const { db, state, calls } = fakeDb();
    state.up = false;
    const store = new OfflineStore(db);
    store.enqueue('notification', 'create', { data: { id: 'ok' } });
    appendFileSync(file, 'not json\n');
    appendFileSync(file, `${JSON.stringify({ id: 'x', at: '', model: 'user', action: 'create', args: { data: {} } })}\n`);
    expect(() => store.enqueue('user' as never, 'create', { data: {} })).toThrow('may not be queued');
    expect(store.pending()).toHaveLength(1);
    state.up = true;
    await store.sync();
    expect(calls).toEqual([['notification', 'create', { data: { id: 'ok' } }]]);
    expect(readFileSync(file, 'utf8')).toBe('');
  });

  it('recognises "database unavailable" errors', () => {
    expect(isDatabaseUnavailable(offline())).toBe(true);
    expect(isDatabaseUnavailable(new Error('Database error. Code: `45027`. Message: `pool is closed`'))).toBe(true);
    expect(isDatabaseUnavailable(known('P1001'))).toBe(true);
    expect(isDatabaseUnavailable(new Error('Transaction API error: Unable to start a transaction in the given time.'))).toBe(true);
    expect(isDatabaseUnavailable(known('P2002'))).toBe(false);
    expect(isDatabaseUnavailable(new Error('Unique constraint failed'))).toBe(false);
  });
});
