import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { del, get, patch, post } from '../lib/api';
import { useAction, useAsync } from '../lib/hooks';
import { Card, ConfirmDialog, Empty, ErrorBox, formatTime, Loading, SuccessBox } from '../components/ui';

interface MemoryRecord {
  id: string;
  kind: string;
  content: string;
  updatedAt: string;
}

interface Skill {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  validationStatus: 'VALID' | 'INVALID' | 'UNVALIDATED';
  validationError: string | null;
  lastValidatedAt: string | null;
  useCount: number;
}

export function MemoryPage() {
  const navigate = useNavigate();
  const memory = useAsync(() => get<MemoryRecord[]>('/api/memory'));
  const skills = useAsync(() => get<Skill[]>('/api/skills'));
  const [kind, setKind] = useState('preference');
  const [content, setContent] = useState('');
  const [editing, setEditing] = useState<{ id: string; content: string } | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const action = useAction();

  const add = (e: FormEvent) => {
    e.preventDefault();
    void action.run(async () => {
      await post('/api/memory', { kind, content });
      setContent('');
      await memory.reload();
    }, 'Saved');
  };

  const exportAll = () =>
    void action.run(async () => {
      const data = await get<unknown>('/api/memory/export');
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'winagent-memory-export.json';
      a.click();
      URL.revokeObjectURL(url);
    }, 'Export downloaded');

  return (
    <div className="page">
      <h1>Memory and skills</h1>
      <ErrorBox message={action.error} />
      <SuccessBox message={action.success} />
      <Card
        title="Memory"
        actions={
          <>
            <button type="button" className="btn btn-small" onClick={exportAll}>
              Export all
            </button>
            <button type="button" className="btn btn-small btn-danger" onClick={() => setConfirmAll(true)} disabled={!memory.data?.length}>
              Delete all…
            </button>
          </>
        }
      >
        <p className="hint">Everything the agent remembers about you is listed here. Passwords, tokens and keys are refused.</p>
        <ErrorBox message={memory.error} onRetry={memory.reload} />
        {memory.loading && !memory.data ? (
          <Loading />
        ) : !memory.data?.length ? (
          <Empty>No stored memory.</Empty>
        ) : (
          <ul className="list">
            {memory.data.map((m) => (
              <li key={m.id} className="list-row">
                <span className="badge badge-neutral">{m.kind}</span>
                {editing?.id === m.id ? (
                  <form
                    className="row grow"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void action.run(async () => {
                        await patch(`/api/memory/${m.id}`, { content: editing.content });
                        setEditing(null);
                        await memory.reload();
                      }, 'Updated');
                    }}
                  >
                    <input className="grow" value={editing.content} onChange={(e) => setEditing({ id: m.id, content: e.target.value })} aria-label="Memory content" maxLength={5000} />
                    <button type="submit" className="btn btn-small btn-primary">
                      Save
                    </button>
                    <button type="button" className="btn btn-small" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                  </form>
                ) : (
                  <>
                    <span className="grow">{m.content}</span>
                    <span className="muted small">{formatTime(m.updatedAt)}</span>
                    <button type="button" className="btn btn-small" onClick={() => setEditing({ id: m.id, content: m.content })}>
                      Edit
                    </button>
                    <button type="button" className="btn btn-small btn-danger" onClick={() => void action.run(async () => { await del(`/api/memory/${m.id}`); await memory.reload(); }, 'Deleted')}>
                      Delete
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        <form className="row" onSubmit={add}>
          <label>
            Kind
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="preference">Preference</option>
              <option value="fact">Fact</option>
              <option value="recovery_strategy">Recovery strategy</option>
              <option value="task_summary">Task summary</option>
            </select>
          </label>
          <label className="grow">
            Content <input value={content} onChange={(e) => setContent(e.target.value)} required maxLength={5000} />
          </label>
          <button type="submit" className="btn">
            Add
          </button>
        </form>
      </Card>

      <Card title="Reusable skills">
        <p className="hint">Skills are saved from verified tasks. They are re-validated against current policies before every run and disabled automatically if validation fails.</p>
        <ErrorBox message={skills.error} onRetry={skills.reload} />
        {!skills.data?.length ? (
          <Empty>No skills yet. Open a verified task and choose “Save as reusable skill”.</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Skill</th>
                <th scope="col">Validation</th>
                <th scope="col">Enabled</th>
                <th scope="col">Uses</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {skills.data.map((s) => (
                <tr key={s.id}>
                  <td>
                    <strong>{s.name}</strong>
                    <br />
                    <span className="muted small">{s.description}</span>
                  </td>
                  <td>
                    <span className={`badge badge-${s.validationStatus === 'VALID' ? 'ok' : s.validationStatus === 'INVALID' ? 'danger' : 'warn'}`}>{s.validationStatus}</span>
                    {s.validationError && <p className="error-text small">{s.validationError}</p>}
                  </td>
                  <td>
                    <input type="checkbox" checked={s.enabled} aria-label={`Enable ${s.name}`} onChange={(e) => void action.run(async () => { await patch(`/api/skills/${s.id}`, { enabled: e.target.checked }); await skills.reload(); })} />
                  </td>
                  <td>{s.useCount}</td>
                  <td className="row">
                    <button type="button" className="btn btn-small" onClick={() => void action.run(async () => { await post(`/api/skills/${s.id}/validate`); await skills.reload(); }, 'Validated')}>
                      Validate
                    </button>
                    <button
                      type="button"
                      className="btn btn-small btn-primary"
                      disabled={!s.enabled}
                      onClick={() =>
                        void action.run(async () => {
                          const task = await post<{ id: string }>(`/api/skills/${s.id}/run`);
                          navigate(`/tasks/${task.id}`);
                        })
                      }
                    >
                      Run
                    </button>
                    <button type="button" className="btn btn-small btn-danger" onClick={() => void action.run(async () => { await del(`/api/skills/${s.id}`); await skills.reload(); }, 'Skill deleted')}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <ConfirmDialog
        open={confirmAll}
        title="Delete all memory?"
        confirmLabel="Delete all memory"
        danger
        pending={action.pending}
        onCancel={() => setConfirmAll(false)}
        onConfirm={() => void action.run(async () => { await post('/api/memory/delete-all', { confirm: true }); setConfirmAll(false); await memory.reload(); }, 'All memory deleted')}
      >
        <p>This permanently deletes every memory record. Skills and task history are kept. Consider exporting first.</p>
      </ConfirmDialog>
    </div>
  );
}
