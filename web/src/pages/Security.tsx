import { FormEvent, useState } from 'react';
import { del, get, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAction, useAsync } from '../lib/hooks';
import { Card, Empty, ErrorBox, formatTime, Loading, SuccessBox } from '../components/ui';

interface Session {
  id: string;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  current: boolean;
}

interface AuditEvent {
  id: string;
  actorType: string;
  actorId: string | null;
  action: string;
  outcome: string;
  taskId: string | null;
  createdAt: string;
}

export function SecurityPage() {
  const { can } = useAuth();
  const sessions = useAsync(() => get<Session[]>('/api/auth/sessions'));
  const [filter, setFilter] = useState('');
  const audit = useAsync(() => (can('audit:read') ? get<AuditEvent[]>(`/api/audit?limit=100${filter ? `&action=${encodeURIComponent(filter)}` : ''}`) : Promise.resolve([])), [filter]);
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [user, setUser] = useState({ email: '', displayName: '', password: '', role: 'OPERATOR' });
  const action = useAction();

  const changePassword = (e: FormEvent) => {
    e.preventDefault();
    if (pw.newPassword !== pw.confirm) {
      action.setError('The new passwords do not match.');
      return;
    }
    void action.run(async () => {
      await post('/api/auth/password', { currentPassword: pw.currentPassword, newPassword: pw.newPassword });
      setPw({ currentPassword: '', newPassword: '', confirm: '' });
      await sessions.reload();
    }, 'Password changed. All other sessions were signed out.');
  };

  const createUser = (e: FormEvent) => {
    e.preventDefault();
    void action.run(async () => {
      await post('/api/auth/users', user);
      setUser({ email: '', displayName: '', password: '', role: 'OPERATOR' });
    }, 'User created');
  };

  return (
    <div className="page">
      <h1>Security settings</h1>
      <ErrorBox message={action.error} />
      <SuccessBox message={action.success} />
      <Card title="Active sessions">
        {sessions.loading && !sessions.data ? (
          <Loading />
        ) : (
          <ul className="list">
            {sessions.data?.map((s) => (
              <li key={s.id} className="list-row">
                <span className="grow">
                  {s.userAgent?.slice(0, 80) ?? 'Unknown client'} {s.current && <span className="badge badge-ok">this session</span>}
                  <br />
                  <span className="muted small">
                    Signed in {formatTime(s.createdAt)} · last active {formatTime(s.lastSeenAt)} · expires {formatTime(s.expiresAt)}
                  </span>
                </span>
                {!s.current && (
                  <button type="button" className="btn btn-small btn-danger" onClick={() => void action.run(async () => { await del(`/api/auth/sessions/${s.id}`); await sessions.reload(); }, 'Session revoked')}>
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Change password">
        <form className="form" onSubmit={changePassword}>
          <label>
            Current password <input type="password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} required autoComplete="current-password" />
          </label>
          <label>
            New password (12+ characters) <input type="password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} required minLength={12} autoComplete="new-password" />
          </label>
          <label>
            Confirm new password <input type="password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} required minLength={12} autoComplete="new-password" />
          </label>
          <button type="submit" className="btn btn-primary" disabled={action.pending}>
            Change password
          </button>
        </form>
      </Card>

      {can('system:admin') && (
        <Card title="Add user">
          <form className="form" onSubmit={createUser}>
            <div className="grid-3">
              <label>
                Email <input type="email" value={user.email} onChange={(e) => setUser({ ...user, email: e.target.value })} required />
              </label>
              <label>
                Display name <input value={user.displayName} onChange={(e) => setUser({ ...user, displayName: e.target.value })} required />
              </label>
              <label>
                Initial password <input type="password" value={user.password} onChange={(e) => setUser({ ...user, password: e.target.value })} required minLength={12} autoComplete="new-password" />
              </label>
              <label>
                Role
                <select value={user.role} onChange={(e) => setUser({ ...user, role: e.target.value })}>
                  <option value="OPERATOR">Operator — runs own tasks</option>
                  <option value="VIEWER">Viewer — read only</option>
                  <option value="ADMIN">Administrator</option>
                </select>
              </label>
            </div>
            <button type="submit" className="btn">
              Create user
            </button>
          </form>
        </Card>
      )}

      <Card title="Audit log">
        <label>
          Filter by action prefix <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="e.g. approval. or auth.login" maxLength={64} />
        </label>
        <ErrorBox message={audit.error} onRetry={audit.reload} />
        {!audit.data?.length ? (
          <Empty>No audit events.</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Actor</th>
                <th scope="col">Action</th>
                <th scope="col">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {audit.data.map((a) => (
                <tr key={a.id}>
                  <td className="small">{formatTime(a.createdAt)}</td>
                  <td>{a.actorType}</td>
                  <td>
                    <code>{a.action}</code>
                  </td>
                  <td>{a.outcome}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
