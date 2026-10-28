import { createHash } from 'node:crypto';
import WebSocket from 'ws';

/**
 * SIMULATED agent for server integration tests. Every output carries
 * `simulated: true`, which the verifier records on the evidence, so results from this
 * agent can never be mistaken for real Windows execution.
 */
export interface FakeBehaviour {
  /** Never answer these operations (to exercise timeouts). */
  silent?: Set<string>;
  /** Delay before answering, in ms. */
  delayMs?: number;
  /** Corrupt the content of file.write (to exercise verification failure). */
  corruptWrites?: boolean;
  /** Fail an operation with this code. */
  failWith?: Record<string, string>;
}

const sha = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

export class FakeAgent {
  readonly files = new Map<string, string>();
  readonly received: Array<Record<string, unknown>> = [];
  readonly journal = new Map<string, Record<string, unknown>>();
  emergencyStop = false;
  behaviour: FakeBehaviour = {};
  private ws?: WebSocket;

  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url, { headers: { authorization: `Bearer ${this.token}` } });
      this.ws = ws;
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'hello', agentVersion: 'fake-1', hostname: 'test-host', roots: ['test', 'workspace'], apps: ['notepad'], capabilities: { files: true } }));
        setTimeout(resolve, 150);
      });
      ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      ws.on('error', reject);
      ws.on('message', (raw) => this.onMessage(JSON.parse(raw.toString())));
    });
  }

  close(): void {
    this.ws?.close();
  }

  /** The real agent sends resources: null when it cannot read them. */
  heartbeat(resources: Record<string, unknown> | null): void {
    this.send({ type: 'heartbeat', resources, emergencyStop: this.emergencyStop });
  }

  private send(msg: Record<string, unknown>): void {
    this.ws?.send(JSON.stringify(msg));
  }

  private onMessage(msg: Record<string, unknown>): void {
    this.received.push(msg);
    if (msg.type === 'emergency_stop') this.emergencyStop = Boolean(msg.active);
    if (msg.type === 'op_status') {
      const entry = this.journal.get(String(msg.operationId));
      this.send({ type: 'op_status_result', operationId: msg.operationId, ...(entry ? { state: 'completed', result: entry } : { state: 'unknown' }) });
    }
    if (msg.type !== 'op') return;
    const operation = String(msg.operation);
    if (this.behaviour.silent?.has(operation)) return;
    const respond = () => {
      const result = this.run(operation, msg.params as Record<string, string>);
      this.journal.set(String(msg.operationId), result);
      this.send({ type: 'op_result', operationId: msg.operationId, ...result });
    };
    if (this.behaviour.delayMs) setTimeout(respond, this.behaviour.delayMs);
    else respond();
  }

  private run(operation: string, p: Record<string, string>): Record<string, unknown> {
    if (this.emergencyStop) return { ok: false, code: 'EMERGENCY_STOP', error: 'emergency stop is active' };
    const fail = this.behaviour.failWith?.[operation];
    if (fail) return { ok: false, code: fail, error: `simulated ${fail}` };
    const key = `${p.root}:${p.path}`;
    switch (operation) {
      case 'file.write': {
        const content = this.behaviour.corruptWrites ? `${p.content}!` : p.content;
        this.files.set(key, content);
        return { ok: true, output: { sha256: sha(content), size: content.length, simulated: true } };
      }
      case 'file.read':
        return this.files.has(key) ? { ok: true, output: { content: this.files.get(key), sha256: sha(this.files.get(key)!), simulated: true } } : { ok: false, code: 'NOT_FOUND', error: `${p.path} does not exist` };
      case 'file.stat':
        return { ok: true, output: this.files.has(key) ? { exists: true, isFile: true, size: this.files.get(key)!.length, sha256: sha(this.files.get(key)!), simulated: true } : { exists: false, isFile: false, simulated: true } };
      case 'file.delete':
        this.files.delete(key);
        return { ok: true, output: { simulated: true } };
      default:
        return { ok: true, output: { simulated: true } };
    }
  }
}
