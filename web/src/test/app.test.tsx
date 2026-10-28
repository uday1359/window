import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, errorText } from '../lib/api';
import { ApprovalCard } from '../components/ApprovalCard';
import { StatusBadge } from '../components/ui';
import { AuthProvider } from '../lib/auth';
import { LoginPage } from '../pages/Login';
import { TaskDetailPage } from '../pages/TaskDetail';
import { NewTaskPage } from '../pages/NewTask';
import type { Approval, TaskDetail } from '../lib/types';

type Handler = (url: string, init: RequestInit) => { status?: number; body: unknown };
let handler: Handler;
const calls: Array<{ url: string; init: RequestInit }> = [];

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      const { status = 200, body } = handler(url, init);
      return new Response(body === undefined ? '' : JSON.stringify(body), { status });
    }),
  );
});

const json = (init: RequestInit) => JSON.parse(String(init.body ?? '{}'));

describe('api client', () => {
  it('sends the CSRF header on mutations only and surfaces validation issues', async () => {
    handler = (url) => (url === '/api/x' ? { status: 400, body: { message: 'Validation failed', issues: [{ path: 'instruction', message: 'Required' }] } } : { body: {} });
    await api('GET', '/api/ok');
    expect((calls[0].init.headers as Record<string, string>)['x-winagent-csrf']).toBeUndefined();
    const err = await api('POST', '/api/x', {}).catch((e) => e);
    expect((calls[1].init.headers as Record<string, string>)['x-winagent-csrf']).toBe('1');
    expect(err).toBeInstanceOf(ApiError);
    expect(errorText(err)).toBe('Validation failed: instruction: Required');
  });

  it('reports an unreachable server clearly', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('network'))));
    const err = (await api('GET', '/api/x').catch((e) => e)) as ApiError;
    expect(err.status).toBe(0);
    expect(err.message).toMatch(/Cannot reach/);
  });
});

describe('StatusBadge', () => {
  it('conveys status with text, not only colour', () => {
    render(<StatusBadge status="SUCCEEDED" />);
    expect(screen.getByText(/Verified complete/)).toBeInTheDocument();
  });
});

const approval: Approval = {
  id: 'a1',
  taskId: 't1',
  stepId: 's1',
  actionHash: 'f'.repeat(64),
  operation: 'file.delete',
  target: 'test:old.txt',
  summary: 'Delete old.txt',
  consequences: 'Removes the file.',
  riskLevel: 'HIGH',
  status: 'PENDING',
  expiresAt: new Date(Date.now() + 60000).toISOString(),
  createdAt: new Date().toISOString(),
  step: { index: 0, params: { root: 'test', path: 'old.txt' } },
};

describe('ApprovalCard', () => {
  it('shows the exact action and submits the displayed action hash after confirmation', async () => {
    handler = () => ({ body: { ok: true } });
    const onDecided = vi.fn();
    render(
      <MemoryRouter>
        <ApprovalCard approval={approval} onDecided={onDecided} />
      </MemoryRouter>,
    );
    expect(screen.getAllByText('test:old.txt').length).toBeGreaterThan(0);
    expect(screen.getByText(/"path": "old.txt"/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Approve…' }));
    expect(calls).toHaveLength(0); // nothing is sent before the explicit confirmation
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(onDecided).toHaveBeenCalled());
    expect(calls[0].url).toBe('/api/approvals/a1/decision');
    expect(json(calls[0].init)).toEqual({ decision: 'APPROVE', actionHash: approval.actionHash, channel: 'web' });
  });
});

describe('LoginPage', () => {
  it('offers first-run setup when no users exist', async () => {
    handler = (url) => (url === '/api/auth/status' ? { body: { needsBootstrap: true } } : { status: 401, body: { message: 'no' } });
    render(
      <AuthProvider>
        <LoginPage />
      </AuthProvider>,
    );
    expect(await screen.findByRole('heading', { name: 'Set up WinAgent' })).toBeInTheDocument();
    expect(screen.getByLabelText('Display name')).toBeInTheDocument();
  });

  it('shows a sign-in error from the server', async () => {
    handler = (url) => (url === '/api/auth/status' ? { body: { needsBootstrap: false } } : url === '/api/auth/login' ? { status: 401, body: { message: 'Invalid email or password' } } : { status: 401, body: {} });
    render(
      <AuthProvider>
        <LoginPage />
      </AuthProvider>,
    );
    await screen.findByRole('heading', { name: 'Sign in to WinAgent' });
    await userEvent.type(screen.getByLabelText('Email'), 'a@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password');
  });
});

describe('NewTaskPage', () => {
  it('submits with an idempotency key and the chosen privacy level', async () => {
    handler = (url, init) => {
      if (url === '/api/preferences') return { body: { defaultPrivacyLevel: 'LOCAL_ONLY', voiceInput: false } };
      if (url.startsWith('/api/tasks?')) return { body: { items: [] } };
      if (url === '/api/tasks' && init.method === 'POST') return { status: 201, body: { id: 'new-id' } };
      return { body: {} };
    };
    render(
      <MemoryRouter initialEntries={['/tasks/new']}>
        <Routes>
          <Route path="/tasks/new" element={<NewTaskPage />} />
          <Route path="/tasks/:id" element={<p>task page</p>} />
        </Routes>
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole('button', { name: /acceptance-test example/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Submit task' }));
    expect(await screen.findByText('task page')).toBeInTheDocument();
    const post = calls.find((c) => c.url === '/api/tasks' && c.init.method === 'POST')!;
    expect((post.init.headers as Record<string, string>)['idempotency-key']).toMatch(/^[0-9a-f]{32}$/);
    expect(json(post.init)).toMatchObject({ privacyLevel: 'LOCAL_ONLY', instruction: expect.stringContaining('hello.txt') });
  });
});

const detail: TaskDetail = {
  id: 't1',
  title: 'Create hello.txt',
  status: 'SUCCEEDED',
  statusReason: 'All success criteria verified with evidence',
  progress: 100,
  riskLevel: 'LOW',
  privacyLevel: 'LOCAL_ONLY',
  queuePosition: 1,
  createdAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  planSource: 'rules',
  instruction: 'Create hello.txt …',
  plan: { title: 'Create hello.txt' },
  successCriteria: [],
  steps: [],
  approvals: [],
  checkpoints: [],
  executions: [],
  agentDevice: null,
  startedAt: null,
  evidence: [
    { id: 'e1', criterion: 'File test:hello.txt contains exactly the expected text', kind: 'file_content_equals', outcome: 'PASS', expected: 'Hello from my AI agent.', actual: 'Hello from my AI agent.', sha256: 'a'.repeat(64), source: 'agent', isSimulated: true, createdAt: new Date().toISOString() },
  ],
};

describe('TaskDetailPage', () => {
  it('displays actual evidence and clearly labels simulated results', async () => {
    handler = (url) => (url === '/api/tasks/t1' ? { body: detail } : url.endsWith('/audit') ? { body: [] } : { body: { spokenFeedback: false } });
    render(
      <MemoryRouter initialEntries={['/tasks/t1']}>
        <Routes>
          <Route path="/tasks/:id" element={<TaskDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: 'Create hello.txt' })).toBeInTheDocument();
    expect(screen.getByText(/Verified complete/)).toBeInTheDocument();
    expect(screen.getByText('PASS')).toBeInTheDocument();
    expect(screen.getAllByText('Hello from my AI agent.')).toHaveLength(2);
    expect(screen.getByText('SIMULATED')).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent(/simulated/);
  });
});
