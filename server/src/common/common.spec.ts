import { actionHash, canonicalJson, hashPassword, randomPairingCode, verifyPassword } from './crypto';
import { containsSecret, redact, redactString } from './redact';
import { RateLimiter } from './rate-limit';
import { canTransition, sourcesFor } from '../tasks/task-state';

describe('crypto', () => {
  it('hashes passwords with salt and verifies them', async () => {
    const a = await hashPassword('correct horse battery');
    const b = await hashPassword('correct horse battery');
    expect(a).not.toEqual(b);
    expect(a).not.toContain('correct');
    expect(await verifyPassword('correct horse battery', a)).toBe(true);
    expect(await verifyPassword('wrong password!!', a)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });

  it('action hashes are order-independent but change with any parameter', () => {
    const h1 = actionHash('t', 's', 'file.delete', { root: 'test', path: 'a.txt' });
    expect(actionHash('t', 's', 'file.delete', { path: 'a.txt', root: 'test' })).toBe(h1);
    expect(actionHash('t', 's', 'file.delete', { root: 'test', path: 'b.txt' })).not.toBe(h1);
    expect(actionHash('t', 's2', 'file.delete', { root: 'test', path: 'a.txt' })).not.toBe(h1);
    expect(canonicalJson({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe('{"a":[1,{"c":3,"d":2}],"b":1}');
  });

  it('pairing codes use an unambiguous alphabet', () => {
    expect(randomPairingCode()).toMatch(/^[A-HJ-NP-Z2-9]{10}$/);
  });
});

describe('redaction', () => {
  it.each([
    'my password=hunter2',
    'Authorization: Bearer abcdefghijklmnop',
    'key sk-abcdefghijklmnopqrstuvwxyz',
    'AKIAABCDEFGHIJKLMNOP',
    'mysql://user:pa55@localhost/db',
    'card 4111 1111 1111 1111',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  ])('redacts %s', (s) => {
    expect(containsSecret(s)).toBe(true);
    expect(redactString(s)).toContain('REDACTED');
  });

  it('redacts sensitive keys in nested objects', () => {
    expect(redact({ user: 'a', apiKey: 'zzz', nested: { password: 'p', note: 'token: abc' } })).toEqual({ user: 'a', apiKey: '[REDACTED]', nested: { password: '[REDACTED]', note: 'token=[REDACTED]' } });
  });

  it('leaves normal text alone', () => {
    expect(containsSecret('Create hello.txt in the approved test folder containing exactly: Hello from my AI agent.')).toBe(false);
  });
});

describe('rate limiter', () => {
  it('limits within a window and resets after it', () => {
    const rl = new RateLimiter(2, 1000);
    expect([rl.take('a', 0), rl.take('a', 1), rl.take('a', 2)]).toEqual([true, true, false]);
    expect(rl.take('b', 2)).toBe(true);
    expect(rl.take('a', 1001)).toBe(true);
  });
});

describe('task state machine', () => {
  it('blocks invalid transitions', () => {
    expect(canTransition('SUCCEEDED', 'RUNNING')).toBe(false);
    expect(canTransition('CANCELLED', 'QUEUED')).toBe(false);
    expect(canTransition('PENDING', 'RUNNING')).toBe(false);
    expect(canTransition('RUNNING', 'SUCCEEDED')).toBe(true);
    expect(sourcesFor('RUNNING')).toEqual(['QUEUED']);
  });
});
