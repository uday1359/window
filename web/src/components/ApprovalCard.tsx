import { useState } from 'react';
import { Link } from 'react-router-dom';
import { post } from '../lib/api';
import { useAction } from '../lib/hooks';
import type { Approval } from '../lib/types';
import { ConfirmDialog, ErrorBox, formatTime, RiskBadge } from './ui';

/**
 * Shows the exact action, target, parameters and consequences. The decision is sent
 * with the action hash that was displayed, so the server rejects it if anything changed.
 */
export function ApprovalCard({ approval, onDecided }: { approval: Approval; onDecided: () => void }) {
  const [choice, setChoice] = useState<'APPROVE' | 'REJECT' | null>(null);
  const [comment, setComment] = useState('');
  const action = useAction();
  const params = approval.step?.params;

  const decide = async () => {
    if (!choice) return;
    const ok = await action.run(() => post(`/api/approvals/${approval.id}/decision`, { decision: choice, actionHash: approval.actionHash, comment: comment || undefined, channel: 'web' }));
    if (ok) {
      setChoice(null);
      onDecided();
    }
  };

  return (
    <article className="approval" aria-labelledby={`appr-${approval.id}`}>
      <header className="row">
        <h3 id={`appr-${approval.id}`}>{approval.summary}</h3>
        <RiskBadge risk={approval.riskLevel} />
        <span className="badge badge-neutral">{approval.status}</span>
      </header>
      <dl className="kv">
        {approval.task && (
          <>
            <dt>Task</dt>
            <dd>
              <Link to={`/tasks/${approval.task.id}`}>{approval.task.title}</Link>
            </dd>
          </>
        )}
        <dt>Action</dt>
        <dd>
          <code>{approval.operation}</code>
        </dd>
        <dt>Target</dt>
        <dd>
          <code>{approval.target}</code>
        </dd>
        {params && (
          <>
            <dt>Exact parameters</dt>
            <dd>
              <pre className="code">{JSON.stringify(params, null, 2)}</pre>
            </dd>
          </>
        )}
        <dt>Consequences</dt>
        <dd>{approval.consequences}</dd>
        <dt>Expires</dt>
        <dd>{formatTime(approval.expiresAt)}</dd>
        {approval.decision && (
          <>
            <dt>Decision</dt>
            <dd>
              {approval.decision.decision} {approval.decision.comment ? `— “${approval.decision.comment}”` : ''} ({formatTime(approval.decision.createdAt)})
            </dd>
          </>
        )}
      </dl>
      <ErrorBox message={action.error} />
      {approval.status === 'PENDING' && (
        <div className="row">
          <button type="button" className="btn btn-primary" onClick={() => setChoice('APPROVE')}>
            Approve…
          </button>
          <button type="button" className="btn btn-danger" onClick={() => setChoice('REJECT')}>
            Reject…
          </button>
        </div>
      )}
      <ConfirmDialog
        open={choice !== null}
        title={choice === 'APPROVE' ? 'Approve this exact action?' : 'Reject this action?'}
        confirmLabel={choice === 'APPROVE' ? 'Approve' : 'Reject'}
        danger={choice === 'REJECT'}
        pending={action.pending}
        onConfirm={decide}
        onCancel={() => setChoice(null)}
      >
        <p>
          <strong>{approval.operation}</strong> on <code>{approval.target}</code>
        </p>
        <p>{approval.consequences}</p>
        <label>
          Comment (optional)
          <input value={comment} onChange={(e) => setComment(e.target.value)} maxLength={500} />
        </label>
        {choice === 'REJECT' && <p className="hint">Rejecting stops the task. Nothing in this step is executed.</p>}
      </ConfirmDialog>
    </article>
  );
}
