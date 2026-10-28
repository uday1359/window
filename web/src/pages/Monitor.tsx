import { useState } from 'react';
import { Link } from 'react-router-dom';
import { get } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { LiveEvent, useLiveEvents, useLiveStatus } from '../lib/live';
import type { Device, Resources, TaskDetail, TaskSummary } from '../lib/types';
import { Card, Empty, ErrorBox, Loading, ProgressBar, StatusBadge } from '../components/ui';

const ACTIVE = 'PLANNING,QUEUED,RUNNING,AWAITING_APPROVAL,PAUSED,BLOCKED';

function ResourceLine({ r }: { r: Resources | null }) {
  if (!r) return <span className="muted">No resource report yet</span>;
  return (
    <span className="small">
      CPU {r.cpuPercent ?? '?'}% · RAM {r.memoryPercent ?? '?'}% ({r.memoryAvailableMb ?? '?'} MB free)
      {r.battery ? ` · Battery ${r.battery.percent}%${r.battery.plugged ? ' (charging)' : ''}` : ''}
      {r.gpu?.length ? ` · GPU ${r.gpu[0].utilPercent}% ${r.gpu[0].temperatureC}°C` : ' · GPU n/a'}
      {r.temperature == null ? ' · CPU temp n/a' : ` · ${r.temperature}°C`}
    </span>
  );
}

export function MonitorPage() {
  const live = useLiveStatus();
  const tasks = useAsync(() => get<{ items: TaskSummary[] }>(`/api/tasks?status=${ACTIVE}&pageSize=20`));
  const running = tasks.data?.items.find((t) => t.status === 'RUNNING');
  const detail = useAsync(() => (running ? get<TaskDetail>(`/api/tasks/${running.id}`) : Promise.resolve(null)), [running?.id]);
  const devices = useAsync(() => get<Device[]>('/api/agents'));
  const [feed, setFeed] = useState<LiveEvent[]>([]);

  useLiveEvents(['task.', 'step.', 'approval.', 'agent.', 'system.'], (e) => {
    if (e.type !== 'agent.resources') setFeed((f) => [e, ...f].slice(0, 50));
    if (e.type.startsWith('agent.')) void devices.reload();
    else {
      void tasks.reload();
      void detail.reload();
    }
  });

  return (
    <div className="page">
      <h1>Live execution monitor</h1>
      <p className="muted">{live ? 'Receiving live updates.' : 'Live connection lost; reconnecting automatically.'}</p>
      <div className="grid-2">
        <Card title="Running now">
          {detail.loading && !detail.data ? (
            <Loading />
          ) : !detail.data ? (
            <Empty>Nothing is running.</Empty>
          ) : (
            <>
              <Link to={`/tasks/${detail.data.id}`}>
                <strong>{detail.data.title}</strong>
              </Link>
              <ProgressBar value={detail.data.progress} label="Running task progress" />
              <ol className="steps">
                {detail.data.steps.map((s) => (
                  <li key={s.id} className={`step step-${s.status.toLowerCase()}`}>
                    {s.index + 1}. {s.description} — <span className="badge badge-neutral">{s.status}</span>
                  </li>
                ))}
              </ol>
            </>
          )}
        </Card>
        <Card title="Agents">
          <ErrorBox message={devices.error} onRetry={devices.reload} />
          {devices.data?.filter((d) => d.status === 'ACTIVE').map((d) => (
            <p key={d.id}>
              <strong>{d.name}</strong> <span className={`badge ${d.connected ? 'badge-ok' : 'badge-danger'}`}>{d.connected ? '● connected' : '✕ offline'}</span>
              <br />
              <ResourceLine r={d.lastResources} />
            </p>
          ))}
          {devices.data && devices.data.length === 0 && <Empty>No agents paired.</Empty>}
        </Card>
      </div>
      <Card title="Active tasks">
        <ErrorBox message={tasks.error} onRetry={tasks.reload} />
        {!tasks.data?.items.length ? (
          <Empty>No active tasks.</Empty>
        ) : (
          <ul className="list">
            {tasks.data.items.map((t) => (
              <li key={t.id} className="list-row">
                <Link to={`/tasks/${t.id}`}>{t.title}</Link> <StatusBadge status={t.status} /> <span className="muted small">{t.statusReason}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Event feed">
        {feed.length === 0 ? (
          <Empty>Events appear here as they happen.</Empty>
        ) : (
          <ul className="feed" aria-live="polite">
            {feed.map((e, i) => (
              <li key={`${e.at}-${i}`}>
                <span className="muted small">{e.at ? new Date(e.at).toLocaleTimeString() : ''}</span> <code>{e.type}</code> {typeof e.status === 'string' ? e.status : ''}{' '}
                {typeof e.statusReason === 'string' ? e.statusReason : ''}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
