import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { get } from './lib/api';
import { AuthProvider, useAuth } from './lib/auth';
import { LiveProvider } from './lib/live';
import { Layout } from './components/Layout';
import { Loading } from './components/ui';
import { LoginPage } from './pages/Login';
import { DashboardPage } from './pages/Dashboard';
import { NewTaskPage } from './pages/NewTask';
import { TaskDetailPage } from './pages/TaskDetail';
import { MonitorPage } from './pages/Monitor';
import { ApprovalsPage } from './pages/Approvals';
import { HistoryPage } from './pages/History';
import { AiSettingsPage } from './pages/AiSettings';
import { PoliciesPage } from './pages/Policies';
import { MemoryPage } from './pages/Memory';
import { AgentsPage } from './pages/Agents';
import { DiagnosticsPage } from './pages/Diagnostics';
import { SecurityPage } from './pages/Security';
import { applyTheme, SettingsPage } from './pages/Settings';

function Routed() {
  const { me, loading } = useAuth();

  useEffect(() => {
    if (!me) return;
    get<{ theme: 'system' | 'light' | 'dark' }>('/api/preferences')
      .then((p) => applyTheme(p.theme))
      .catch(() => undefined);
  }, [me]);

  if (loading) return <Loading label="Connecting to WinAgent…" />;
  if (!me) return <LoginPage />;
  return (
    <LiveProvider enabled>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<DashboardPage />} />
          <Route path="tasks/new" element={<NewTaskPage />} />
          <Route path="tasks/:id" element={<TaskDetailPage />} />
          <Route path="monitor" element={<MonitorPage />} />
          <Route path="approvals" element={<ApprovalsPage />} />
          <Route path="history" element={<HistoryPage />} />
          <Route path="ai" element={<AiSettingsPage />} />
          <Route path="policies" element={<PoliciesPage />} />
          <Route path="memory" element={<MemoryPage />} />
          <Route path="agents" element={<AgentsPage />} />
          <Route path="diagnostics" element={<DiagnosticsPage />} />
          <Route path="security" element={<SecurityPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </LiveProvider>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routed />
      </AuthProvider>
    </BrowserRouter>
  );
}
