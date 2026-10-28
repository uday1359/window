import { NavLink, Outlet } from 'react-router-dom';
import { get } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAsync, useOnline } from '../lib/hooks';
import { useLiveEvents, useLiveStatus } from '../lib/live';
import type { Notification } from '../lib/types';
import { EmergencyStop } from './EmergencyStop';

const NAV: Array<{ to: string; label: string; permission?: string }> = [
  { to: '/', label: 'Dashboard' },
  { to: '/tasks/new', label: 'New task', permission: 'task:create' },
  { to: '/monitor', label: 'Live monitor' },
  { to: '/approvals', label: 'Approvals' },
  { to: '/history', label: 'Task history' },
  { to: '/ai', label: 'AI & models' },
  { to: '/policies', label: 'Permissions', permission: 'policy:manage' },
  { to: '/memory', label: 'Memory & skills', permission: 'memory:manage' },
  { to: '/agents', label: 'Agent devices' },
  { to: '/diagnostics', label: 'Diagnostics' },
  { to: '/security', label: 'Security' },
  { to: '/settings', label: 'Settings' },
];

export function Layout() {
  const { me, logout, can } = useAuth();
  const online = useOnline();
  const live = useLiveStatus();
  const unread = useAsync(() => get<Notification[]>('/api/notifications?unread=1'));
  const pendingApprovals = useAsync(() => get<unknown[]>('/api/approvals?status=PENDING'));
  useLiveEvents(['notification', 'approval.'], (e) => {
    // Inside the desktop shell, surface notifications as native Windows notifications.
    const n = e.notification as { title?: string; body?: string } | undefined;
    if (e.type === 'notification' && n?.title) void window.winagentDesktop?.notify(n.title, n.body ?? '');
    void unread.reload();
    void pendingApprovals.reload();
  });

  return (
    <div className="shell">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <header className="topbar">
        <span className="brand">WinAgent</span>
        <span className={`badge ${live ? 'badge-ok' : 'badge-warn'}`} title="Live updates">
          {live ? '● Live' : '○ Reconnecting…'}
        </span>
        <EmergencyStop />
        <span className="spacer" />
        <NavLink to="/settings#notifications" className="topbar-link">
          Notifications{unread.data?.length ? ` (${unread.data.length})` : ''}
        </NavLink>
        <span className="muted">{me?.displayName}</span>
        <button type="button" className="btn btn-small" onClick={() => void logout()}>
          Sign out
        </button>
      </header>
      {!online && (
        <div className="alert alert-warn banner" role="status">
          You are offline. Local tasks keep running on the agent; the dashboard will refresh when the connection returns.
        </div>
      )}
      <div className="body">
        <nav className="sidebar" aria-label="Main">
          <ul>
            {NAV.filter((n) => !n.permission || can(n.permission)).map((n) => (
              <li key={n.to}>
                <NavLink to={n.to} end={n.to === '/'}>
                  {n.label}
                  {n.to === '/approvals' && pendingApprovals.data?.length ? <span className="count">{pendingApprovals.data.length}</span> : null}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <main id="main" className="content" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
