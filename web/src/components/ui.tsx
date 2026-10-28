import { ReactNode, useEffect, useId, useRef } from 'react';
import type { Risk, TaskStatus } from '../lib/types';

const STATUS_LABEL: Record<TaskStatus, string> = {
  PENDING: 'Pending',
  PLANNING: 'Planning',
  NEEDS_CLARIFICATION: 'Needs your input',
  AWAITING_APPROVAL: 'Awaiting approval',
  QUEUED: 'Queued',
  RUNNING: 'Running',
  PAUSED: 'Paused',
  INTERRUPTED: 'Interrupted',
  BLOCKED: 'Blocked',
  SUCCEEDED: 'Verified complete',
  PARTIAL: 'Partially complete',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
  REJECTED: 'Rejected',
};

const STATUS_TONE: Record<TaskStatus, string> = {
  PENDING: 'neutral',
  PLANNING: 'info',
  NEEDS_CLARIFICATION: 'warn',
  AWAITING_APPROVAL: 'warn',
  QUEUED: 'neutral',
  RUNNING: 'info',
  PAUSED: 'warn',
  INTERRUPTED: 'warn',
  BLOCKED: 'danger',
  SUCCEEDED: 'ok',
  PARTIAL: 'warn',
  FAILED: 'danger',
  CANCELLED: 'neutral',
  REJECTED: 'neutral',
};

const STATUS_ICON: Record<string, string> = { ok: '✓', danger: '✕', warn: '!', info: '…', neutral: '•' };

/** Status is conveyed by text and an icon, never by colour alone. */
export function StatusBadge({ status }: { status: TaskStatus }) {
  const tone = STATUS_TONE[status] ?? 'neutral';
  return (
    <span className={`badge badge-${tone}`} data-status={status}>
      <span aria-hidden="true">{STATUS_ICON[tone]}</span> {STATUS_LABEL[status] ?? status}
    </span>
  );
}

export function RiskBadge({ risk }: { risk: Risk | null | undefined }) {
  if (!risk) return null;
  const tone = risk === 'LOW' ? 'ok' : risk === 'MEDIUM' ? 'warn' : 'danger';
  return <span className={`badge badge-${tone}`}>{risk} risk</span>;
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <p className="muted" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" /> {label}
    </p>
  );
}

export function ErrorBox({ message, onRetry }: { message: string | null; onRetry?: () => void }) {
  if (!message) return null;
  return (
    <div className="alert alert-danger" role="alert">
      <span>{message}</span>
      {onRetry && (
        <button type="button" className="btn btn-small" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function SuccessBox({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="alert alert-ok" role="status">
      {message}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Card({ title, actions, children }: { title?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section className="card" aria-labelledby={title ? id : undefined}>
      {(title || actions) && (
        <header className="card-header">
          {title && <h2 id={id}>{title}</h2>}
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

/** Accessible modal built on <dialog>: focus is trapped and Escape cancels. */
export function ConfirmDialog(props: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (props.open && !d.open) d.showModal?.();
    if (!props.open && d.open) d.close?.();
  }, [props.open]);
  if (!props.open) return null;
  return (
    <dialog ref={ref} className="dialog" aria-labelledby="dialog-title" onCancel={(e) => { e.preventDefault(); props.onCancel(); }} open>
      <h2 id="dialog-title">{props.title}</h2>
      <div className="dialog-body">{props.children}</div>
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={props.onCancel} autoFocus>
          Cancel
        </button>
        <button type="button" className={`btn ${props.danger ? 'btn-danger' : 'btn-primary'}`} onClick={props.onConfirm} disabled={props.pending}>
          {props.pending ? 'Working…' : props.confirmLabel}
        </button>
      </div>
    </dialog>
  );
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

export function ProgressBar({ value, label }: { value: number; label: string }) {
  return (
    <div className="progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}>
      <div className="progress-fill" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}
