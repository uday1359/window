import { FormEvent, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, get, post } from '../lib/api';
import { useAction, useAsync } from '../lib/hooks';
import { useLiveEvents } from '../lib/live';
import { PAUSABLE, RESUMABLE, TERMINAL, TaskDetail } from '../lib/types';
import { speak } from '../lib/voice';
import { ApprovalCard } from '../components/ApprovalCard';
import { ResearchFindings } from '../components/ResearchFindings';
import { Card, ConfirmDialog, Empty, ErrorBox, formatTime, Loading, ProgressBar, RiskBadge, StatusBadge, SuccessBox } from '../components/ui';

interface AuditEvent {
  id: string;
  action: string;
  actorType: string;
  outcome: string;
  details: Record<string, unknown> | null;
  createdAt: string;
}

export function TaskDetailPage() {
  const { id = '' } = useParams();
  const task = useAsync(() => get<TaskDetail>(`/api/tasks/${id}`), [id]);
  const audit = useAsync(() => get<AuditEvent[]>(`/api/tasks/${id}/audit`), [id]);
  const prefs = useAsync(() => get<{ spokenFeedback: boolean }>('/api/preferences'));
  const control = useAction();
  const [uncertain, setUncertain] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [answer, setAnswer] = useState('');
  const [skillName, setSkillName] = useState('');
  const [inspected, setInspected] = useState<string[]>([]);
  const lastStatus = useRef<string | undefined>(undefined);

  useLiveEvents(['task.', 'step.', 'approval.'], (e) => {
    if (e.taskId === id) {
      void task.reload();
      void audit.reload();
    }
  });

  // Spoken progress / completion reports (opt-in preference).
  useEffect(() => {
    const s = task.data?.status;
    if (s && lastStatus.current && s !== lastStatus.current && prefs.data?.spokenFeedback) {
      speak(`Task ${task.data!.title}: ${s.toLowerCase().replace(/_/g, ' ')}`);
    }
    lastStatus.current = s;
  }, [task.data, prefs.data]);

  const act = (path: string, body?: object, message?: string) =>
    control.run(async () => {
      const res = await post<{ inspected?: string[] }>(`/api/tasks/${id}/${path}`, body);
      if (res?.inspected) setInspected(res.inspected);
      await task.reload();
    }, message);

  const resume = async (confirmUncertain = false) => {
    try {
      const res = await post<{ inspected: string[] }>(`/api/tasks/${id}/resume`, { confirmUncertain });
      setInspected(res.inspected);
      setUncertain(null);
      await task.reload();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && /not safe to repeat/.test(err.message)) setUncertain(err.message);
      else control.setError(err instanceof Error ? err.message : 'Resume failed');
    }
  };

  const clarify = (e: FormEvent) => {
    e.preventDefault();
    void act('clarify', { answer }).then(() => setAnswer(''));
  };

  if (task.loading && !task.data) return <Loading />;
  if (task.error && !task.data) return <ErrorBox message={task.error} onRetry={task.reload} />;
  const t = task.data!;
  const pending = t.approvals.filter((a) => a.status === 'PENDING');
  const simulated = t.evidence.some((e) => e.isSimulated);

  return (
    <div className="page">
      <p>
        <Link to="/history">← Task history</Link>
      </p>
      <h1>{t.title}</h1>
      <div className="row">
        <StatusBadge status={t.status} />
        <RiskBadge risk={t.riskLevel} />
        <span className="badge badge-neutral">{t.privacyLevel.replace('_', ' ').toLowerCase()}</span>
        {t.planSource && <span className="muted small">Planned by {t.planSource}</span>}
      </div>
      {t.statusReason && <p className="status-reason">{t.statusReason}</p>}
      <ProgressBar value={t.progress} label="Task progress" />

      <div className="row controls">
        {PAUSABLE.includes(t.status) && (
          <button type="button" className="btn" onClick={() => void act('pause', {}, 'Task paused')} disabled={control.pending}>
            Pause
          </button>
        )}
        {RESUMABLE.includes(t.status) && (
          <button type="button" className="btn btn-primary" onClick={() => void resume(false)} disabled={control.pending}>
            Resume
          </button>
        )}
        {!TERMINAL.includes(t.status) && (
          <button type="button" className="btn btn-danger" onClick={() => setConfirmCancel(true)} disabled={control.pending}>
            Cancel task
          </button>
        )}
      </div>
      <ErrorBox message={control.error} />
      <SuccessBox message={control.success} />
      {inspected.length > 0 && (
        <div className="alert alert-info" role="status">
          <strong>State inspected before resuming:</strong>
          <ul>
            {inspected.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        </div>
      )}

      {t.status === 'NEEDS_CLARIFICATION' && (
        <Card title="The agent needs more information">
          <form onSubmit={clarify} className="form">
            <label htmlFor="answer">{t.statusReason}</label>
            <input id="answer" value={answer} onChange={(e) => setAnswer(e.target.value)} required maxLength={2000} />
            <button type="submit" className="btn btn-primary" disabled={control.pending}>
              Send answer
            </button>
          </form>
        </Card>
      )}

      {pending.length > 0 && (
        <Card title="Waiting for your approval">
          {pending.map((a) => {
            const step = t.steps.find((s) => s.id === a.stepId);
            return <ApprovalCard key={a.id} approval={{ ...a, step: step && { index: step.index, params: step.params } }} onDecided={() => void task.reload()} />;
          })}
        </Card>
      )}

      <Card title="Instruction">
        <p className="pre-wrap">{t.instruction}</p>
        {t.attachments && t.attachments.length > 0 && (
          <p className="small">
            Screenshots:{' '}
            {t.attachments.map((a, i) => (
              <span key={a.id}>
                {i > 0 && ', '}
                <a href={`/api/tasks/${t.id}/attachments/${a.id}`} target="_blank" rel="noopener noreferrer">
                  Screenshot {i + 1}
                </a>{' '}
                <span className="muted">({Math.round(a.sizeBytes / 1024)} KB)</span>
              </span>
            ))}
          </p>
        )}
        <p className="muted small">
          Created {formatTime(t.createdAt)} · Agent: {t.agentDevice?.name ?? 'none assigned'}
        </p>
      </Card>

      <Card title="Execution steps">
        {t.steps.length === 0 ? (
          <Empty>No plan yet.</Empty>
        ) : (
          <ol className="steps">
            {t.steps.map((s) => (
              <li key={s.id} className={`step step-${s.status.toLowerCase()}`}>
                <div className="row">
                  <strong>
                    {s.index + 1}. {s.description}
                  </strong>
                  <span className="badge badge-neutral">{s.status}</span>
                  <RiskBadge risk={s.riskLevel} />
                  {s.requiresApproval && <span className="badge badge-warn">approval required</span>}
                </div>
                <code className="small">{s.operation}</code> <span className="muted small">attempts: {s.attempts}</span>
                {s.error && <p className="error-text">{s.error}</p>}
                {s.operation === 'browser.research' && s.result?.output && <ResearchFindings output={s.result.output} />}
                {s.result?.output && (
                  <details>
                    <summary>Result</summary>
                    <pre className="code">{JSON.stringify(s.result.output, null, 2)}</pre>
                    {Array.isArray(s.result.output.injectionWarnings) && (s.result.output.injectionWarnings as string[]).length > 0 && (
                      <p className="alert alert-warn">Possible prompt-injection text found on this page. It was treated as data and not followed.</p>
                    )}
                  </details>
                )}
              </li>
            ))}
          </ol>
        )}
      </Card>

      <Card title="Verification evidence">
        {simulated && (
          <div className="alert alert-warn" role="note">
            Some evidence was produced by a <strong>simulated</strong> agent (test fixture), not by real Windows execution.
          </div>
        )}
        {t.evidence.length === 0 ? (
          <Empty>{TERMINAL.includes(t.status) ? 'No evidence was recorded.' : 'Evidence is collected after the steps finish.'}</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Criterion</th>
                <th scope="col">Result</th>
                <th scope="col">Expected</th>
                <th scope="col">Actual</th>
                <th scope="col">SHA-256</th>
              </tr>
            </thead>
            <tbody>
              {t.evidence.map((e) => (
                <tr key={e.id}>
                  <td>
                    {e.criterion}
                    {e.isSimulated && <span className="badge badge-warn"> SIMULATED</span>}
                  </td>
                  <td>
                    <span className={`badge badge-${e.outcome === 'PASS' ? 'ok' : e.outcome === 'FAIL' ? 'danger' : 'warn'}`}>{e.outcome}</span>
                  </td>
                  <td>
                    <code className="pre-wrap">{e.expected ?? '—'}</code>
                  </td>
                  <td>
                    <code className="pre-wrap">{e.actual ?? '—'}</code>
                  </td>
                  <td>
                    <code className="small">{e.sha256 ? `${e.sha256.slice(0, 16)}…` : '—'}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {t.status === 'SUCCEEDED' && (
        <Card title="Save as reusable skill">
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              void control.run(() => post(`/api/skills/from-task/${id}`, { name: skillName }), 'Saved as a skill. It is re-validated before every use.');
            }}
          >
            <label>
              Skill name <input value={skillName} onChange={(e) => setSkillName(e.target.value)} required maxLength={100} />
            </label>
            <button type="submit" className="btn">
              Save skill
            </button>
          </form>
        </Card>
      )}

      <Card title="Checkpoints">
        {t.checkpoints.length === 0 ? (
          <Empty>No checkpoints yet.</Empty>
        ) : (
          <ul className="list">
            {t.checkpoints.map((c) => (
              <li key={c.id} className="list-row">
                Step {c.stepIndex + 1}: <code>{String(c.state.target ?? '')}</code> <span className="muted small">{formatTime(c.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Audit trail">
        <ErrorBox message={audit.error} onRetry={audit.reload} />
        {audit.data && (
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

      <ConfirmDialog open={confirmCancel} title="Cancel this task?" confirmLabel="Cancel task" danger pending={control.pending} onCancel={() => setConfirmCancel(false)} onConfirm={() => void act('cancel', {}, 'Task cancelled').then(() => setConfirmCancel(false))}>
        <p>Any running agent action is stopped. Completed steps are not undone.</p>
      </ConfirmDialog>
      <ConfirmDialog open={uncertain !== null} title="Outcome is uncertain" confirmLabel="I checked — run it again" danger onCancel={() => setUncertain(null)} onConfirm={() => void resume(true)}>
        <p>{uncertain}</p>
        <p>Running it again could repeat an action that already happened. Only continue if you have confirmed it did not.</p>
      </ConfirmDialog>
    </div>
  );
}
