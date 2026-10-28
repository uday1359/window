import { Link } from 'react-router-dom';
import { get, patch } from '../lib/api';
import { useAsync, useAction } from '../lib/hooks';
import { useLiveEvents } from '../lib/live';
import type { Device, TaskSummary } from '../lib/types';
import { Card, Empty, ErrorBox, formatTime, Loading, ProgressBar, StatusBadge } from '../components/ui';

interface QueueItem {
  id: string;
  title: string;
  status: TaskSummary['status'];
  queuePosition: number;
  progress: number;
}

export function DashboardPage() {
  const recent = useAsync(() => get<{ items: TaskSummary[]; total: number }>('/api/tasks?pageSize=8'));
  const queue = useAsync(() => get<QueueItem[]>('/api/tasks/queue'));
  const devices = useAsync(() => get<Device[]>('/api/agents'));
  const attention = useAsync(() => get<{ total: number }>('/api/tasks?status=AWAITING_APPROVAL,NEEDS_CLARIFICATION,BLOCKED,INTERRUPTED&pageSize=1'));
  const reorder = useAction();
  useLiveEvents(['task.', 'step.', 'agent.'], () => {
    void recent.reload();
    void queue.reload();
    void devices.reload();
    void attention.reload();
  });

  const move = (index: number, delta: number) => {
    const items = queue.data ?? [];
    const other = items[index + delta];
    const item = items[index];
    if (!item || !other) return;
    void reorder.run(async () => {
      await patch(`/api/tasks/${item.id}/position`, { queuePosition: other.queuePosition });
      await patch(`/api/tasks/${other.id}/position`, { queuePosition: item.queuePosition });
      await queue.reload();
    });
  };

  const connected = devices.data?.filter((d) => d.connected && d.status === 'ACTIVE') ?? [];
  return (
    <div className="page">
      <h1>Dashboard</h1>
      <div className="stats">
        <div className="stat">
          <span className="stat-value">{queue.data?.length ?? '–'}</span>
          <span className="stat-label">Active tasks</span>
        </div>
        <div className="stat">
          <span className="stat-value">{attention.data?.total ?? '–'}</span>
          <span className="stat-label">Need your attention</span>
        </div>
        <div className="stat">
          <span className="stat-value">{devices.data ? `${connected.length}/${devices.data.filter((d) => d.status === 'ACTIVE').length}` : '–'}</span>
          <span className="stat-label">Agents connected</span>
        </div>
      </div>

      {devices.data && connected.length === 0 && (
        <div className="alert alert-warn" role="status">
          No agent is connected, so tasks cannot run. <Link to="/agents">Pair or start an agent</Link>.
        </div>
      )}

      <div className="grid-2">
        <Card title="Queue" actions={<Link to="/tasks/new" className="btn btn-primary btn-small">New task</Link>}>
          <ErrorBox message={queue.error ?? reorder.error} onRetry={queue.reload} />
          {queue.loading && !queue.data ? (
            <Loading />
          ) : !queue.data?.length ? (
            <Empty>The queue is empty. Tasks run one at a time in this order.</Empty>
          ) : (
            <ol className="list">
              {queue.data.map((t, i) => (
                <li key={t.id} className="list-row">
                  <Link to={`/tasks/${t.id}`}>{t.title}</Link>
                  <StatusBadge status={t.status} />
                  <span className="row-actions">
                    <button type="button" className="btn btn-small" onClick={() => move(i, -1)} disabled={i === 0 || reorder.pending} aria-label={`Move ${t.title} up`}>
                      ↑
                    </button>
                    <button type="button" className="btn btn-small" onClick={() => move(i, 1)} disabled={i === queue.data!.length - 1 || reorder.pending} aria-label={`Move ${t.title} down`}>
                      ↓
                    </button>
                  </span>
                  <ProgressBar value={t.progress} label={`${t.title} progress`} />
                </li>
              ))}
            </ol>
          )}
        </Card>

        <Card title="Recent tasks" actions={<Link to="/history">All history</Link>}>
          <ErrorBox message={recent.error} onRetry={recent.reload} />
          {recent.loading && !recent.data ? (
            <Loading />
          ) : !recent.data?.items.length ? (
            <Empty>
              No tasks yet. <Link to="/tasks/new">Create your first task</Link>.
            </Empty>
          ) : (
            <ul className="list">
              {recent.data.items.map((t) => (
                <li key={t.id} className="list-row">
                  <Link to={`/tasks/${t.id}`}>{t.title}</Link>
                  <StatusBadge status={t.status} />
                  <span className="muted small">{formatTime(t.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
