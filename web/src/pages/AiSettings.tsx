import { FormEvent, useState } from 'react';
import { del, get, patch, post, put } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAction, useAsync } from '../lib/hooks';
import type { PrivacyLevel } from '../lib/types';
import { Card, ConfirmDialog, Empty, ErrorBox, Loading, SuccessBox } from '../components/ui';

interface Model {
  id: string;
  name: string;
  provider: string;
  model: string;
  endpoint: string;
  isLocal: boolean;
  enabled: boolean;
  maxComplexity: number;
  latencyClass: number;
  costPer1kTokens: string;
  capabilities: string[];
  secretRef: string | null;
}

interface Health {
  aiService: { ok: boolean; ollama?: { reachable: boolean; models: string[] }; secretStore?: string; error?: string };
}

const EMPTY = { name: '', provider: 'ollama', model: '', endpoint: 'http://127.0.0.1:11434', isLocal: true, maxComplexity: 3, latencyClass: 2, costPer1kTokens: 0, secretRef: '' };

export function AiSettingsPage() {
  const { can } = useAuth();
  const admin = can('settings:manage');
  const models = useAsync(() => get<Model[]>('/api/models'));
  const health = useAsync(() => get<Health>('/api/diagnostics'));
  const secrets = useAsync(() => (admin ? get<{ names: string[] }>('/api/secrets') : Promise.resolve({ names: [] })), [admin]);
  const [form, setForm] = useState(EMPTY);
  const [secretName, setSecretName] = useState('');
  const [secretValue, setSecretValue] = useState('');
  const [preview, setPreview] = useState<{ privacyLevel: PrivacyLevel; complexity: number }>({ privacyLevel: 'LOCAL_ONLY', complexity: 2 });
  const [route, setRoute] = useState<Record<string, unknown> | null>(null);
  const [deleting, setDeleting] = useState<Model | null>(null);
  const action = useAction();

  const addModel = (e: FormEvent) => {
    e.preventDefault();
    void action.run(async () => {
      await post('/api/models', { ...form, secretRef: form.secretRef || null, capabilities: ['planning'] });
      setForm(EMPTY);
      await models.reload();
    }, 'Model added');
  };

  const saveSecret = (e: FormEvent) => {
    e.preventDefault();
    void action.run(async () => {
      await put(`/api/secrets/${encodeURIComponent(secretName)}`, { value: secretValue });
      setSecretValue(''); // never keep the secret in UI state longer than needed
      setSecretName('');
      await secrets.reload();
    }, 'Secret stored with Windows DPAPI. It cannot be displayed again.');
  };

  const ai = health.data?.aiService;
  return (
    <div className="page">
      <h1>AI and model settings</h1>
      <ErrorBox message={action.error} />
      <SuccessBox message={action.success} />
      <Card title="AI service status">
        {health.loading && !health.data ? (
          <Loading />
        ) : ai?.ok ? (
          <ul>
            <li>AI service: running</li>
            <li>Local model server (Ollama): {ai.ollama?.reachable ? `reachable — models: ${ai.ollama.models.join(', ') || 'none'}` : 'not reachable'}</li>
            <li>Secret store: {ai.secretStore}</li>
          </ul>
        ) : (
          <ErrorBox message={`AI service unavailable: ${ai?.error ?? health.error ?? 'unknown'}`} onRetry={health.reload} />
        )}
        <p className="hint">Common requests (files, websites, search, apps) are planned by deterministic rules without any model. Other requests are routed to the best permitted model below.</p>
      </Card>

      <Card title="Models">
        <ErrorBox message={models.error} onRetry={models.reload} />
        {!models.data?.length ? (
          <Empty>No models configured. Without a model, only rule-based plans are possible.</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Provider / model</th>
                <th scope="col">Where</th>
                <th scope="col">Max complexity</th>
                <th scope="col">API key</th>
                <th scope="col">Enabled</th>
                {admin && <th scope="col">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {models.data.map((m) => (
                <tr key={m.id}>
                  <td>{m.name}</td>
                  <td>
                    {m.provider} / <code>{m.model}</code>
                  </td>
                  <td>{m.isLocal ? 'Local' : 'Cloud'}</td>
                  <td>{m.maxComplexity}</td>
                  <td>{m.secretRef ? <code>{m.secretRef}</code> : '—'}</td>
                  <td>
                    <input
                      type="checkbox"
                      checked={m.enabled}
                      disabled={!admin}
                      aria-label={`Enable ${m.name}`}
                      onChange={(e) => void action.run(async () => { await patch(`/api/models/${m.id}`, { enabled: e.target.checked }); await models.reload(); })}
                    />
                  </td>
                  {admin && (
                    <td>
                      <button type="button" className="btn btn-small btn-danger" onClick={() => setDeleting(m)}>
                        Remove
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {admin && (
          <form className="form" onSubmit={addModel}>
            <h3>Add model</h3>
            <div className="grid-3">
              <label>
                Name <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
              </label>
              <label>
                Provider
                <select value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value, isLocal: e.target.value === 'ollama', endpoint: e.target.value === 'ollama' ? 'http://127.0.0.1:11434' : 'https://' })}>
                  <option value="ollama">Ollama (local)</option>
                  <option value="openai_compatible">OpenAI-compatible (cloud)</option>
                  <option value="anthropic">Anthropic (cloud)</option>
                </select>
              </label>
              <label>
                Model id <input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} required placeholder="qwen2.5:3b" />
              </label>
              <label>
                Endpoint <input value={form.endpoint} onChange={(e) => setForm({ ...form, endpoint: e.target.value })} required />
              </label>
              <label>
                Max complexity (1–5) <input type="number" min={1} max={5} value={form.maxComplexity} onChange={(e) => setForm({ ...form, maxComplexity: Number(e.target.value) })} />
              </label>
              <label>
                Latency (1 fast – 3 slow) <input type="number" min={1} max={3} value={form.latencyClass} onChange={(e) => setForm({ ...form, latencyClass: Number(e.target.value) })} />
              </label>
              <label>
                Cost per 1k tokens (USD) <input type="number" min={0} step="0.0001" value={form.costPer1kTokens} onChange={(e) => setForm({ ...form, costPer1kTokens: Number(e.target.value) })} />
              </label>
              {!form.isLocal && (
                <label>
                  API key secret name <input value={form.secretRef} onChange={(e) => setForm({ ...form, secretRef: e.target.value })} pattern="[a-z0-9_-]{1,100}" required />
                </label>
              )}
            </div>
            <button type="submit" className="btn btn-primary" disabled={action.pending}>
              Add model
            </button>
          </form>
        )}
      </Card>

      {admin && (
        <Card title="API keys (Windows DPAPI protected)">
          <p className="hint">Keys are encrypted with your Windows account and never stored in the database, logs or prompts. They cannot be viewed after saving.</p>
          {secrets.data?.names.length ? (
            <ul className="list">
              {secrets.data.names.map((n) => (
                <li key={n} className="list-row">
                  <code>{n}</code>
                  <button type="button" className="btn btn-small btn-danger" onClick={() => void action.run(async () => { await del(`/api/secrets/${n}`); await secrets.reload(); }, 'Secret removed')}>
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No API keys stored.</Empty>
          )}
          <form className="row" onSubmit={saveSecret}>
            <label>
              Name <input value={secretName} onChange={(e) => setSecretName(e.target.value)} pattern="[a-z0-9_-]{1,100}" required />
            </label>
            <label>
              Value <input type="password" value={secretValue} onChange={(e) => setSecretValue(e.target.value)} required autoComplete="off" />
            </label>
            <button type="submit" className="btn">
              Store key
            </button>
          </form>
        </Card>
      )}

      <Card title="Routing preview">
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => setRoute(await post('/api/models/route-preview', { ...preview, capability: 'planning' })));
          }}
        >
          <label>
            Privacy
            <select value={preview.privacyLevel} onChange={(e) => setPreview({ ...preview, privacyLevel: e.target.value as PrivacyLevel })}>
              <option value="LOCAL_ONLY">Local only</option>
              <option value="CLOUD_REDACTED">Cloud with redaction</option>
              <option value="CLOUD_ALLOWED">Cloud allowed</option>
            </select>
          </label>
          <label>
            Complexity <input type="number" min={1} max={5} value={preview.complexity} onChange={(e) => setPreview({ ...preview, complexity: Number(e.target.value) })} />
          </label>
          <button type="submit" className="btn btn-small">
            Preview
          </button>
        </form>
        {route && <pre className="code">{JSON.stringify(route, null, 2)}</pre>}
      </Card>

      <ConfirmDialog open={deleting !== null} title={`Remove model ${deleting?.name}?`} confirmLabel="Remove" danger onCancel={() => setDeleting(null)} onConfirm={() => void action.run(async () => { await del(`/api/models/${deleting!.id}`); setDeleting(null); await models.reload(); })}>
        <p>Tasks will no longer be routed to this model.</p>
      </ConfirmDialog>
    </div>
  );
}
