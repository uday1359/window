import { useState } from 'react';
import { get, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAction, useAsync } from '../lib/hooks';
import { useLiveEvents } from '../lib/live';
import type { Device } from '../lib/types';
import { Card, ConfirmDialog, Empty, ErrorBox, formatTime, Loading, SuccessBox } from '../components/ui';

export function AgentsPage() {
  const { can } = useAuth();
  const devices = useAsync(() => get<Device[]>('/api/agents'));
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [revoking, setRevoking] = useState<Device | null>(null);
  const action = useAction();
  useLiveEvents(['agent.'], () => void devices.reload());

  const server = window.location.origin.replace(':5173', ':3710');
  return (
    <div className="page">
      <h1>Agent devices and connectivity</h1>
      <ErrorBox message={action.error ?? devices.error} />
      <SuccessBox message={action.success} />
      {can('agent:manage') && (
        <Card title="Pair a computer">
          <p>The agent runs on the Windows computer with normal user privileges and connects out to this server. Approved folders and applications are configured locally on that computer.</p>
          <button type="button" className="btn btn-primary" onClick={() => void action.run(async () => setCode(await post('/api/agents/pairing-codes')))}>
            Create pairing code
          </button>
          {code && (
            <div className="alert alert-info" role="status">
              <p>
                One-time code (expires {formatTime(code.expiresAt)}): <strong className="code-big">{code.code}</strong>
              </p>
              <p>On the Windows computer, run:</p>
              <pre className="code">{`.venv\\Scripts\\python -m winagent pair --server ${server} --code ${code.code}\n.venv\\Scripts\\python -m winagent run`}</pre>
            </div>
          )}
        </Card>
      )}
      <Card title="Devices">
        {devices.loading && !devices.data ? (
          <Loading />
        ) : !devices.data?.length ? (
          <Empty>No devices paired yet.</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Device</th>
                <th scope="col">Status</th>
                <th scope="col">Approved folders</th>
                <th scope="col">Allowed apps</th>
                <th scope="col">Last seen</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {devices.data.map((d) => (
                <tr key={d.id}>
                  <td>
                    <strong>{d.name}</strong>
                    <br />
                    <span className="muted small">
                      {d.hostname} · {d.osVersion ?? 'unknown OS'} · agent {d.agentVersion ?? '?'}
                    </span>
                  </td>
                  <td>
                    {d.status === 'REVOKED' ? (
                      <span className="badge badge-neutral">Revoked</span>
                    ) : (
                      <span className={`badge ${d.connected ? 'badge-ok' : 'badge-danger'}`}>{d.connected ? '● Connected' : '✕ Not connected'}</span>
                    )}
                  </td>
                  <td>{d.allowedRoots?.map((r) => <code key={r}>{r} </code>) ?? '—'}</td>
                  <td>{Array.isArray(d.capabilities?.apps) ? (d.capabilities!.apps as string[]).join(', ') : '—'}</td>
                  <td className="small">{formatTime(d.lastSeenAt)}</td>
                  <td>
                    {d.status === 'ACTIVE' && can('agent:manage') && (
                      <button type="button" className="btn btn-small btn-danger" onClick={() => setRevoking(d)}>
                        Revoke access
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <ConfirmDialog
        open={revoking !== null}
        title={`Revoke ${revoking?.name}?`}
        confirmLabel="Revoke access"
        danger
        pending={action.pending}
        onCancel={() => setRevoking(null)}
        onConfirm={() => void action.run(async () => { await post(`/api/agents/${revoking!.id}/revoke`); setRevoking(null); await devices.reload(); }, 'Device access revoked')}
      >
        <p>The device is disconnected immediately and its token stops working. Tasks assigned to it will be blocked. Re-pairing requires a new code.</p>
      </ConfirmDialog>
    </div>
  );
}
