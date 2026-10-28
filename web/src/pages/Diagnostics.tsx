import { get, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAction, useAsync } from '../lib/hooks';
import type { Resources } from '../lib/types';
import { Card, Empty, ErrorBox, formatTime, Loading, SuccessBox } from '../components/ui';

interface Diagnostics {
  version: string;
  server: { ok: boolean; uptimeSec: number; rssMb: number; heapUsedMb: number; node: string; dashboardConnections: number };
  database: { ok: boolean; latencyMs?: number; migrations?: Array<{ name: string; applied: boolean }>; error?: string };
  aiService: { ok: boolean; ollama?: { reachable: boolean; models: string[] }; error?: string };
  agents: Array<{ id: string; name: string; connected: boolean; lastSeenAt: string | null; lastResources: Resources | null; agentVersion: string | null }>;
  queue: { queued: number; running: number; blocked: number; orchestratorBusy: boolean };
}

interface Backup {
  id: string;
  kind: string;
  filePath: string;
  sizeBytes: string;
  sha256: string;
  createdAt: string;
  restoreTestedAt: string | null;
  restoreTestResult: string | null;
  fileExists: boolean;
}

const ok = (b: boolean | undefined) => <span className={`badge ${b ? 'badge-ok' : 'badge-danger'}`}>{b ? '✓ OK' : '✕ Problem'}</span>;

export function DiagnosticsPage() {
  const { can } = useAuth();
  const admin = can('system:admin');
  const diag = useAsync(() => get<Diagnostics>('/api/diagnostics'));
  const backups = useAsync(() => (admin ? get<Backup[]>('/api/backups') : Promise.resolve([])), [admin]);
  const action = useAction();
  const d = diag.data;

  return (
    <div className="page">
      <h1>Diagnostics and system health</h1>
      <button type="button" className="btn btn-small" onClick={() => void diag.reload()}>
        Refresh
      </button>
      <ErrorBox message={diag.error ?? action.error} onRetry={diag.reload} />
      <SuccessBox message={action.success} />
      {diag.loading && !d ? (
        <Loading />
      ) : d ? (
        <div className="grid-2">
          <Card title="Server">
            <p>{ok(d.server.ok)} WinAgent {d.version} on Node {d.server.node}</p>
            <p className="small">
              Uptime {Math.round(d.server.uptimeSec / 60)} min · memory {d.server.rssMb} MB · {d.server.dashboardConnections} live dashboard connection(s)
            </p>
            <p className="small">
              Queue: {d.queue.queued} queued, {d.queue.running} running, {d.queue.blocked} blocked
            </p>
          </Card>
          <Card title="MySQL database">
            <p>
              {ok(d.database.ok)} {d.database.latencyMs !== undefined ? `latency ${d.database.latencyMs} ms` : d.database.error}
            </p>
            <ul className="small">
              {d.database.migrations?.map((m) => (
                <li key={m.name}>
                  {m.applied ? '✓' : '✕'} {m.name}
                </li>
              ))}
            </ul>
          </Card>
          <Card title="AI service">
            <p>
              {ok(d.aiService.ok)} {d.aiService.ok ? `Ollama ${d.aiService.ollama?.reachable ? 'reachable' : 'not reachable'}` : d.aiService.error}
            </p>
            {d.aiService.ollama?.models.length ? <p className="small">Local models: {d.aiService.ollama.models.join(', ')}</p> : null}
          </Card>
          <Card title="Agents and resources">
            {d.agents.length === 0 ? (
              <Empty>No active agents.</Empty>
            ) : (
              d.agents.map((a) => (
                <p key={a.id}>
                  {ok(a.connected)} <strong>{a.name}</strong> (agent {a.agentVersion ?? '?'}) — last seen {formatTime(a.lastSeenAt)}
                  <br />
                  <span className="small">
                    {a.lastResources
                      ? `CPU ${a.lastResources.cpuPercent}% · RAM ${a.lastResources.memoryPercent}% · battery ${a.lastResources.battery ? `${a.lastResources.battery.percent}%` : 'n/a'} · GPU ${a.lastResources.gpu?.length ? `${a.lastResources.gpu[0].utilPercent}%` : 'n/a'}`
                      : 'no resource report'}
                  </span>
                </p>
              ))
            )}
          </Card>
        </div>
      ) : null}

      {admin && (
        <Card
          title="Backups"
          actions={
            <>
              <button type="button" className="btn btn-small" disabled={action.pending} onClick={() => void action.run(async () => { await post('/api/backups/database'); await backups.reload(); }, 'Database backup created')}>
                Back up database
              </button>
              <button type="button" className="btn btn-small" disabled={action.pending} onClick={() => void action.run(async () => { await post('/api/backups/config'); await backups.reload(); }, 'Configuration exported')}>
                Export configuration
              </button>
            </>
          }
        >
          {!backups.data?.length ? (
            <Empty>No backups yet.</Empty>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Created</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Size</th>
                  <th scope="col">Restore test</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {backups.data.map((b) => (
                  <tr key={b.id}>
                    <td className="small">
                      {formatTime(b.createdAt)}
                      {!b.fileExists && <span className="badge badge-danger"> file missing</span>}
                    </td>
                    <td>{b.kind}</td>
                    <td>{Math.round(Number(b.sizeBytes) / 1024)} KB</td>
                    <td className="small">{b.restoreTestResult ? `${b.restoreTestResult} (${formatTime(b.restoreTestedAt)})` : 'not tested'}</td>
                    <td>
                      {b.kind === 'database' && (
                        <button type="button" className="btn btn-small" disabled={action.pending} onClick={() => void action.run(async () => { await post(`/api/backups/${b.id}/verify-restore`); await backups.reload(); }, 'Restore verification finished')}>
                          Verify restore
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
    </div>
  );
}
