import { FormEvent, useState } from 'react';
import { del, get, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAction, useAsync } from '../lib/hooks';
import { IntegrationsCard } from '../components/IntegrationsCard';
import { Card, Empty, ErrorBox, formatTime, Loading, SuccessBox } from '../components/ui';

interface Policy {
  id: string;
  kind: 'FOLDER' | 'WEBSITE' | 'APPLICATION' | 'ACTION';
  value: string;
  effect: 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL';
  note: string | null;
  createdAt: string;
}

const KIND_HELP: Record<Policy['kind'], string> = {
  FOLDER: 'Agent root name, optionally with a sub-folder: test or test:private',
  WEBSITE: 'Domain (covers sub-domains): example.com',
  APPLICATION: 'Allow-listed app name on the agent: notepad',
  ACTION: 'Operation name or *: file.delete',
};
const EFFECT_LABEL = { ALLOW: 'Allow', DENY: 'Deny', REQUIRE_APPROVAL: 'Require approval' };

export function PoliciesPage() {
  const { can } = useAuth();
  const list = useAsync(() => get<Policy[]>('/api/policies'));
  const [kind, setKind] = useState<Policy['kind']>('WEBSITE');
  const [value, setValue] = useState('');
  const [effect, setEffect] = useState<Policy['effect']>('ALLOW');
  const [note, setNote] = useState('');
  const action = useAction();

  const add = (e: FormEvent) => {
    e.preventDefault();
    void action.run(async () => {
      await post('/api/policies', { kind, value, effect, note: note || undefined });
      setValue('');
      setNote('');
      await list.reload();
    }, 'Policy added');
  };

  return (
    <div className="page">
      <h1>Permissions and policies</h1>
      <p className="muted">
        Deny always wins over Require approval, which wins over Allow. High-risk and external actions always need approval, even if allowed. Folders must also be approved in the agent’s local configuration; the dashboard can only narrow
        access, never widen it. Revoking a policy takes effect before the next action.
      </p>
      <ErrorBox message={action.error ?? list.error} />
      <SuccessBox message={action.success} />
      <Card title="Active policies">
        {list.loading && !list.data ? (
          <Loading />
        ) : !list.data?.length ? (
          <Empty>No policies. Websites not on an allow list require approval; agent folders and apps follow the agent’s configuration.</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Type</th>
                <th scope="col">Value</th>
                <th scope="col">Effect</th>
                <th scope="col">Note</th>
                <th scope="col">Added</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((p) => (
                <tr key={p.id}>
                  <td>{p.kind.toLowerCase()}</td>
                  <td>
                    <code>{p.value}</code>
                  </td>
                  <td>
                    <span className={`badge badge-${p.effect === 'DENY' ? 'danger' : p.effect === 'ALLOW' ? 'ok' : 'warn'}`}>{EFFECT_LABEL[p.effect]}</span>
                  </td>
                  <td>{p.note}</td>
                  <td className="small">{formatTime(p.createdAt)}</td>
                  <td>
                    <button type="button" className="btn btn-small" onClick={() => void action.run(async () => { await del(`/api/policies/${p.id}`); await list.reload(); }, 'Policy revoked')}>
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Card title="Add policy">
        <form className="form" onSubmit={add}>
          <div className="grid-3">
            <label>
              Type
              <select value={kind} onChange={(e) => setKind(e.target.value as Policy['kind'])}>
                <option value="FOLDER">Folder</option>
                <option value="WEBSITE">Website</option>
                <option value="APPLICATION">Application</option>
                <option value="ACTION">Action</option>
              </select>
            </label>
            <label>
              Value
              <input value={value} onChange={(e) => setValue(e.target.value)} required maxLength={500} aria-describedby="kind-help" />
            </label>
            <label>
              Effect
              <select value={effect} onChange={(e) => setEffect(e.target.value as Policy['effect'])}>
                <option value="ALLOW">Allow</option>
                <option value="REQUIRE_APPROVAL">Require approval</option>
                <option value="DENY">Deny</option>
              </select>
            </label>
          </div>
          <p id="kind-help" className="hint">
            {KIND_HELP[kind]}
          </p>
          <label>
            Note (optional) <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={255} />
          </label>
          <button type="submit" className="btn btn-primary" disabled={action.pending}>
            Add policy
          </button>
        </form>
      </Card>
      {can('settings:manage') && <IntegrationsCard />}
    </div>
  );
}
