import { FormEvent, useState } from 'react';
import { del, get, patch, post } from '../lib/api';
import { useAction, useAsync } from '../lib/hooks';
import { Card, ConfirmDialog, Empty, ErrorBox, Loading, SuccessBox } from './ui';

interface Integration {
  id: string;
  name: string;
  kind: 'REST' | 'MCP';
  description: string;
  baseUrl: string;
  allowedPaths: string[];
  allowedTools: string[];
  authHeader: string | null;
  authScheme: string | null;
  secretRef: string | null;
  enabled: boolean;
}

const EMPTY = { name: '', kind: 'REST' as Integration['kind'], description: '', baseUrl: 'https://', allowed: '', authHeader: 'Authorization', authScheme: 'Bearer', secretRef: '' };
const splitList = (s: string): string[] =>
  s
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);

/** Administrator allow list of external REST APIs and MCP servers (FR-17). */
export function IntegrationsCard() {
  const list = useAsync(() => get<Integration[]>('/api/integrations'));
  const [form, setForm] = useState(EMPTY);
  const [deleting, setDeleting] = useState<Integration | null>(null);
  const [tools, setTools] = useState<{ id: string; tools: Array<{ name: string; description: string }> } | null>(null);
  const action = useAction();

  const add = (e: FormEvent) => {
    e.preventDefault();
    const allowed = splitList(form.allowed);
    void action.run(async () => {
      await post('/api/integrations', {
        name: form.name,
        kind: form.kind,
        description: form.description,
        baseUrl: form.baseUrl,
        ...(form.kind === 'REST' ? { allowedPaths: allowed } : { allowedTools: allowed }),
        authHeader: form.secretRef ? form.authHeader || null : null,
        authScheme: form.secretRef ? form.authScheme || null : null,
        secretRef: form.secretRef || null,
      });
      setForm(EMPTY);
      await list.reload();
    }, 'Integration added');
  };

  return (
    <Card title="Integrations (REST APIs and MCP servers)">
      <p className="muted small">
        Plans can only call integrations listed here, and only the allowed paths or tools. Reading (GET) is medium risk. Sending data (POST) and every MCP tool call always need your approval. Credentials are stored as encrypted
        secrets under AI &amp; models; only the secret&apos;s name is kept here. MCP servers are reached over HTTP only; no local programs are started.
      </p>
      <ErrorBox message={action.error ?? list.error} />
      <SuccessBox message={action.success} />
      {list.loading ? (
        <Loading />
      ) : !list.data?.length ? (
        <Empty>No integrations registered.</Empty>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Type</th>
              <th scope="col">Address</th>
              <th scope="col">Allowed</th>
              <th scope="col">Status</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {list.data.map((i) => (
              <tr key={i.id}>
                <td>
                  <strong>{i.name}</strong>
                  {i.description && <div className="muted small">{i.description}</div>}
                </td>
                <td>{i.kind}</td>
                <td className="small">{i.baseUrl}</td>
                <td className="small">{(i.kind === 'REST' ? i.allowedPaths : i.allowedTools).join(', ') || <span className="muted">nothing</span>}</td>
                <td>{i.enabled ? 'Enabled' : 'Disabled'}</td>
                <td className="row">
                  <button type="button" className="btn btn-small" onClick={() => void action.run(async () => { await patch(`/api/integrations/${i.id}`, { enabled: !i.enabled }); await list.reload(); })}>
                    {i.enabled ? 'Disable' : 'Enable'}
                  </button>
                  {i.kind === 'MCP' && (
                    <button type="button" className="btn btn-small" onClick={() => void action.run(async () => setTools({ id: i.id, ...(await post<{ tools: Array<{ name: string; description: string }> }>(`/api/integrations/${i.id}/tools`)) }))}>
                      Show tools
                    </button>
                  )}
                  <button type="button" className="btn btn-small btn-danger" onClick={() => setDeleting(i)}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {tools && (
        <div className="alert" role="status">
          <strong>Tools offered by the server</strong> (allow only the ones tasks need):
          <ul>
            {tools.tools.map((t) => (
              <li key={t.name}>
                <code>{t.name}</code> {t.description && <span className="muted small">— {t.description}</span>}
              </li>
            ))}
          </ul>
          <button type="button" className="btn btn-small" onClick={() => setTools(null)}>
            Close
          </button>
        </div>
      )}

      <form className="form" onSubmit={add}>
        <h3>Add integration</h3>
        <div className="grid-3">
          <label>
            Integration name
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required pattern="[a-z][a-z0-9_-]{0,31}" title="Lowercase letters, digits, - and _ (max 32)" />
          </label>
          <label>
            Integration type
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as Integration['kind'] })}>
              <option value="REST">REST API</option>
              <option value="MCP">MCP server (HTTP)</option>
            </select>
          </label>
          <label>
            Integration address
            <input type="url" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} required maxLength={500} aria-describedby="integration-url-help" />
          </label>
        </div>
        <p id="integration-url-help" className="hint">
          https:// only (http:// is allowed for services on this computer). For MCP, enter the server&apos;s endpoint, e.g. https://example.com/mcp.
        </p>
        <label>
          {form.kind === 'REST' ? 'Allowed path prefixes (comma or one per line), e.g. /v1/forecast' : 'Allowed tools (comma or one per line). Use "Show tools" after adding to see what the server offers.'}
          <textarea value={form.allowed} onChange={(e) => setForm({ ...form, allowed: e.target.value })} rows={2} required={form.kind === 'REST'} />
        </label>
        <label>
          Description (shown to the planner)
          <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} maxLength={500} />
        </label>
        <div className="grid-3">
          <label>
            Secret name (optional)
            <input value={form.secretRef} onChange={(e) => setForm({ ...form, secretRef: e.target.value })} pattern="[a-z0-9_-]{1,100}" />
          </label>
          <label>
            Auth header
            <input value={form.authHeader} onChange={(e) => setForm({ ...form, authHeader: e.target.value })} disabled={!form.secretRef} />
          </label>
          <label>
            Auth scheme (empty sends the secret as-is)
            <input value={form.authScheme} onChange={(e) => setForm({ ...form, authScheme: e.target.value })} disabled={!form.secretRef} />
          </label>
        </div>
        <button type="submit" className="btn btn-primary" disabled={action.pending}>
          Add integration
        </button>
      </form>

      <ConfirmDialog
        open={deleting !== null}
        title={`Remove integration ${deleting?.name}?`}
        confirmLabel="Remove"
        danger
        onCancel={() => setDeleting(null)}
        onConfirm={() =>
          void action.run(async () => {
            await del(`/api/integrations/${deleting!.id}`);
            setDeleting(null);
            await list.reload();
          })
        }
      >
        <p>Plans will no longer be able to use it. Tasks that still reference it will be blocked by policy.</p>
      </ConfirmDialog>
    </Card>
  );
}
