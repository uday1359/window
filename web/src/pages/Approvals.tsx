import { useState } from 'react';
import { get } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { useLiveEvents } from '../lib/live';
import type { Approval } from '../lib/types';
import { ApprovalCard } from '../components/ApprovalCard';
import { Empty, ErrorBox, Loading } from '../components/ui';

const TABS = ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'SUPERSEDED'] as const;

export function ApprovalsPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]>('PENDING');
  const list = useAsync(() => get<Approval[]>(`/api/approvals?status=${tab}`), [tab]);
  useLiveEvents(['approval.', 'task.'], () => void list.reload());

  return (
    <div className="page">
      <h1>Approval center</h1>
      <p className="muted">Sensitive, destructive or external actions wait here. Each approval applies only to the exact action shown; if the action changes, a new approval is required. Voice can never approve.</p>
      <div role="tablist" aria-label="Approval status" className="tabs">
        {TABS.map((t) => (
          <button key={t} role="tab" type="button" aria-selected={tab === t} className={`tab ${tab === t ? 'tab-active' : ''}`} onClick={() => setTab(t)}>
            {t.charAt(0) + t.slice(1).toLowerCase()}
          </button>
        ))}
      </div>
      <ErrorBox message={list.error} onRetry={list.reload} />
      {list.loading && !list.data ? (
        <Loading />
      ) : !list.data?.length ? (
        <Empty>{tab === 'PENDING' ? 'Nothing is waiting for your approval.' : 'No approvals in this list.'}</Empty>
      ) : (
        list.data.map((a) => <ApprovalCard key={a.id} approval={a} onDecided={() => void list.reload()} />)
      )}
    </div>
  );
}
