import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post, put } from '../lib/api';
import { useAction, useAsync } from '../lib/hooks';
import { useLiveEvents } from '../lib/live';
import type { Notification, PrivacyLevel } from '../lib/types';
import { voiceInputSupported } from '../lib/voice';
import { Card, Empty, ErrorBox, formatTime, Loading, SuccessBox } from '../components/ui';
import { PRIVACY_HELP } from './NewTask';

interface Prefs {
  theme: 'system' | 'light' | 'dark';
  voiceInput: boolean;
  spokenFeedback: boolean;
  approveMediumRisk: boolean;
  cloudCostLimitUsd: number;
  defaultPrivacyLevel: PrivacyLevel;
  historyRetentionDays: number;
}

export function applyTheme(theme: Prefs['theme']): void {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}

export function SettingsPage() {
  const prefs = useAsync(() => get<Prefs>('/api/preferences'));
  const notes = useAsync(() => get<Notification[]>('/api/notifications'));
  const [draft, setDraft] = useState<Prefs | null>(null);
  const action = useAction();
  useLiveEvents(['notification'], () => void notes.reload());

  useEffect(() => {
    if (prefs.data) setDraft(prefs.data);
  }, [prefs.data]);

  const save = () =>
    void action.run(async () => {
      const saved = await put<Prefs>('/api/preferences', draft);
      applyTheme(saved.theme);
      await prefs.reload();
    }, 'Settings saved');

  return (
    <div className="page">
      <h1>General settings</h1>
      <ErrorBox message={action.error ?? prefs.error} />
      <SuccessBox message={action.success} />
      {!draft ? (
        <Loading />
      ) : (
        <Card title="Preferences">
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <label>
              Theme
              <select value={draft.theme} onChange={(e) => setDraft({ ...draft, theme: e.target.value as Prefs['theme'] })}>
                <option value="system">Follow Windows</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </label>
            <label>
              Default privacy for new tasks
              <select value={draft.defaultPrivacyLevel} onChange={(e) => setDraft({ ...draft, defaultPrivacyLevel: e.target.value as PrivacyLevel })}>
                {(Object.keys(PRIVACY_HELP) as PrivacyLevel[]).map((p) => (
                  <option key={p} value={p}>
                    {PRIVACY_HELP[p]}
                  </option>
                ))}
              </select>
            </label>
            <label className="checkbox">
              <input type="checkbox" checked={draft.approveMediumRisk} onChange={(e) => setDraft({ ...draft, approveMediumRisk: e.target.checked })} /> Also ask me to approve medium-risk actions (high-risk actions always need approval)
            </label>
            <label className="checkbox">
              <input type="checkbox" checked={draft.voiceInput} onChange={(e) => setDraft({ ...draft, voiceInput: e.target.checked })} disabled={!voiceInputSupported()} /> Voice task input {voiceInputSupported() ? '' : '(not supported by this browser)'}
            </label>
            <label className="checkbox">
              <input type="checkbox" checked={draft.spokenFeedback} onChange={(e) => setDraft({ ...draft, spokenFeedback: e.target.checked })} /> Spoken progress and completion reports
            </label>
            <p className="hint">Voice is for input and feedback only. Approvals always require an explicit click.</p>
            <label>
              Cloud cost limit per task (USD)
              <input type="number" min={0} max={10} step="0.01" value={draft.cloudCostLimitUsd} onChange={(e) => setDraft({ ...draft, cloudCostLimitUsd: Number(e.target.value) })} />
            </label>
            <label>
              Keep finished task history for (days)
              <input type="number" min={1} max={3650} value={draft.historyRetentionDays} onChange={(e) => setDraft({ ...draft, historyRetentionDays: Number(e.target.value) })} />
            </label>
            <button type="submit" className="btn btn-primary" disabled={action.pending}>
              Save settings
            </button>
          </form>
        </Card>
      )}

      <div id="notifications">
        <Card title="Notifications" actions={<button type="button" className="btn btn-small" onClick={() => void action.run(async () => { await post('/api/notifications/read-all'); await notes.reload(); })}>Mark all read</button>}>
          <ErrorBox message={notes.error} onRetry={notes.reload} />
          {!notes.data?.length ? (
            <Empty>No notifications.</Empty>
          ) : (
            <ul className="list">
              {notes.data.map((n) => (
                <li key={n.id} className={`list-row ${n.readAt ? 'muted' : ''}`}>
                  {!n.readAt && <span className="badge badge-info">new</span>}
                  <span className="grow">
                    <strong>{n.title}</strong> — {n.body}
                  </span>
                  {n.link && <Link to={n.link}>Open</Link>}
                  <span className="small">{formatTime(n.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
