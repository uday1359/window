import { useState } from 'react';
import { Link } from 'react-router-dom';
import { get } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { useLiveEvents } from '../lib/live';
import type { TaskStatus, TaskSummary } from '../lib/types';
import { Empty, ErrorBox, formatTime, Loading, RiskBadge, StatusBadge } from '../components/ui';

const FILTERS: Array<{ label: string; value: string }> = [
  { label: 'All', value: '' },
  { label: 'Verified complete', value: 'SUCCEEDED' },
  { label: 'Partial', value: 'PARTIAL' },
  { label: 'Failed', value: 'FAILED' },
  { label: 'Blocked / interrupted', value: 'BLOCKED,INTERRUPTED' },
  { label: 'Cancelled / rejected', value: 'CANCELLED,REJECTED' },
  { label: 'In progress', value: 'PLANNING,QUEUED,RUNNING,AWAITING_APPROVAL,PAUSED,NEEDS_CLARIFICATION' },
];
const PAGE_SIZE = 25;

export function HistoryPage() {
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const list = useAsync(
    () => get<{ items: TaskSummary[]; total: number }>(`/api/tasks?page=${page}&pageSize=${PAGE_SIZE}${status ? `&status=${status}` : ''}${query ? `&search=${encodeURIComponent(query)}` : ''}`),
    [status, query, page],
  );
  useLiveEvents(['task.'], () => void list.reload());
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / PAGE_SIZE));

  return (
    <div className="page">
      <h1>Task history</h1>
      <form
        className="row"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          setQuery(search.trim());
        }}
      >
        <label>
          Status{' '}
          <select
            value={status}
            onChange={(e) => {
              setPage(1);
              setStatus(e.target.value);
            }}
          >
            {FILTERS.map((f) => (
              <option key={f.label} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Search <input value={search} onChange={(e) => setSearch(e.target.value)} maxLength={200} />
        </label>
        <button type="submit" className="btn btn-small">
          Search
        </button>
      </form>
      <ErrorBox message={list.error} onRetry={list.reload} />
      {list.loading && !list.data ? (
        <Loading />
      ) : !list.data?.items.length ? (
        <Empty>No tasks match.</Empty>
      ) : (
        <>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Task</th>
                <th scope="col">Status</th>
                <th scope="col">Risk</th>
                <th scope="col">Created</th>
                <th scope="col">Finished</th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((t) => (
                <tr key={t.id}>
                  <td>
                    <Link to={`/tasks/${t.id}`}>{t.title}</Link>
                  </td>
                  <td>
                    <StatusBadge status={t.status as TaskStatus} />
                  </td>
                  <td>
                    <RiskBadge risk={t.riskLevel} />
                  </td>
                  <td className="small">{formatTime(t.createdAt)}</td>
                  <td className="small">{formatTime(t.finishedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <nav className="row" aria-label="Pagination">
            <button type="button" className="btn btn-small" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              Previous
            </button>
            <span>
              Page {page} of {pages} ({list.data.total} tasks)
            </span>
            <button type="button" className="btn btn-small" disabled={page >= pages} onClick={() => setPage(page + 1)}>
              Next
            </button>
          </nav>
        </>
      )}
    </div>
  );
}
