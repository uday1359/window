import { FormEvent, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, newIdempotencyKey, post } from '../lib/api';
import { useAction, useAsync } from '../lib/hooks';
import type { PrivacyLevel, TaskSummary } from '../lib/types';
import { listenOnce, voiceInputSupported } from '../lib/voice';
import { Card, ErrorBox } from '../components/ui';

const EXAMPLE = 'Create hello.txt in the approved test folder containing exactly: Hello from my AI agent. Read the file back and verify its contents.';
const MAX_SCREENSHOTS = 3;
const MAX_SCREENSHOT_BYTES = 1_500_000;

interface Screenshot {
  name: string;
  mediaType: 'image/png' | 'image/jpeg';
  data: string; // base64 without the data: prefix
  size: number;
}

const readScreenshot = (file: File): Promise<Screenshot> =>
  new Promise((resolve, reject) => {
    if (file.type !== 'image/png' && file.type !== 'image/jpeg') return reject(new Error(`${file.name}: only PNG or JPEG images can be attached`));
    if (file.size > MAX_SCREENSHOT_BYTES) return reject(new Error(`${file.name}: images must be 1.5 MB or smaller`));
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, mediaType: file.type as Screenshot['mediaType'], data: String(reader.result).split(',', 2)[1] ?? '', size: file.size });
    reader.onerror = () => reject(new Error(`${file.name}: could not be read`));
    reader.readAsDataURL(file);
  });

export const PRIVACY_HELP: Record<PrivacyLevel, string> = {
  LOCAL_ONLY: 'Local only — nothing leaves this computer; only local models are used.',
  CLOUD_REDACTED: 'Cloud with redaction — secrets and personal data are removed before any cloud model sees the request.',
  CLOUD_ALLOWED: 'Cloud allowed — secrets are still removed; other content may be sent to approved cloud models.',
};

export function NewTaskPage() {
  const navigate = useNavigate();
  const prefs = useAsync(() => get<{ defaultPrivacyLevel: PrivacyLevel; voiceInput: boolean }>('/api/preferences'));
  const open = useAsync(() => get<{ items: TaskSummary[] }>('/api/tasks?status=QUEUED,RUNNING,PAUSED,AWAITING_APPROVAL,BLOCKED&pageSize=50'));
  const [instruction, setInstruction] = useState('');
  const [privacy, setPrivacy] = useState<PrivacyLevel>('LOCAL_ONLY');
  const [priority, setPriority] = useState(0);
  const [deadline, setDeadline] = useState('');
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const [listening, setListening] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [screenshots, setScreenshots] = useState<Screenshot[]>([]);
  const [screenshotError, setScreenshotError] = useState<string | null>(null);
  const action = useAction();

  const addScreenshots = async (files: FileList | null) => {
    setScreenshotError(null);
    const picked = Array.from(files ?? []);
    if (screenshots.length + picked.length > MAX_SCREENSHOTS) {
      setScreenshotError(`You can attach at most ${MAX_SCREENSHOTS} screenshots.`);
      return;
    }
    try {
      const read = await Promise.all(picked.map(readScreenshot));
      setScreenshots((prev) => [...prev, ...read]);
    } catch (err) {
      setScreenshotError((err as Error).message);
    }
  };
  // One key per form fill: re-submitting after a network error cannot create a duplicate.
  const idemKey = useRef(newIdempotencyKey());
  const stopVoice = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (prefs.data) setPrivacy(prefs.data.defaultPrivacyLevel);
  }, [prefs.data]);
  useEffect(() => () => stopVoice.current(), []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    let id = '';
    const ok = await action.run(async () => {
      const task = await post<{ id: string }>(
        '/api/tasks',
        {
          instruction,
          privacyLevel: privacy,
          priority,
          dependsOn,
          ...(deadline ? { deadline: new Date(deadline).toISOString() } : {}),
          ...(screenshots.length ? { attachments: screenshots.map(({ mediaType, data }) => ({ mediaType, data })) } : {}),
        },
        { 'idempotency-key': idemKey.current },
      );
      id = task.id;
    });
    if (ok) {
      idemKey.current = newIdempotencyKey();
      setScreenshots([]);
      navigate(`/tasks/${id}`);
    }
  };

  const voice = () => {
    setVoiceError(null);
    setListening(true);
    stopVoice.current = listenOnce(
      (text) => setInstruction((prev) => (prev ? `${prev} ${text}` : text)),
      setVoiceError,
      () => setListening(false),
    );
  };

  return (
    <div className="page">
      <h1>New task</h1>
      <Card>
        <form onSubmit={submit} className="form">
          <ErrorBox message={action.error} />
          <label htmlFor="instruction">What should the agent do?</label>
          <textarea id="instruction" value={instruction} onChange={(e) => setInstruction(e.target.value)} rows={5} required maxLength={5000} placeholder={EXAMPLE} aria-describedby="instruction-help" />
          <p id="instruction-help" className="hint">
            Describe the goal in plain language. Never include passwords or keys: they are refused. Sensitive actions will ask for your approval before they run.
          </p>
          <div className="row">
            <button type="button" className="btn btn-small" onClick={() => setInstruction(EXAMPLE)}>
              Use acceptance-test example
            </button>
            {voiceInputSupported() && prefs.data?.voiceInput && (
              <button type="button" className="btn btn-small" onClick={listening ? () => stopVoice.current() : voice} aria-pressed={listening}>
                {listening ? '■ Stop listening' : '🎤 Dictate'}
              </button>
            )}
          </div>
          {voiceError && (
            <p role="alert" className="error-text">
              {voiceError}
            </p>
          )}

          <label htmlFor="screenshots">Screenshots (optional)</label>
          <input
            id="screenshots"
            type="file"
            accept="image/png,image/jpeg"
            multiple
            disabled={screenshots.length >= MAX_SCREENSHOTS}
            onChange={(e) => {
              void addScreenshots(e.target.files);
              e.target.value = '';
            }}
            aria-describedby="screenshots-help"
          />
          <p id="screenshots-help" className="hint">
            Up to {MAX_SCREENSHOTS} PNG or JPEG images, 1.5 MB each. They are read only by models that can see images. With &quot;Cloud with redaction&quot; they stay on local models, because
            images cannot be redacted.
          </p>
          {screenshotError && (
            <p role="alert" className="error-text">
              {screenshotError}
            </p>
          )}
          {screenshots.length > 0 && (
            <ul className="attachments">
              {screenshots.map((s, i) => (
                <li key={`${s.name}-${i}`}>
                  {s.name} <span className="muted small">({Math.round(s.size / 1024)} KB)</span>{' '}
                  <button type="button" className="btn btn-small" onClick={() => setScreenshots((prev) => prev.filter((_, j) => j !== i))} aria-label={`Remove ${s.name}`}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}

          <fieldset>
            <legend>Privacy</legend>
            {(Object.keys(PRIVACY_HELP) as PrivacyLevel[]).map((p) => (
              <label key={p} className="radio">
                <input type="radio" name="privacy" value={p} checked={privacy === p} onChange={() => setPrivacy(p)} />
                {PRIVACY_HELP[p]}
              </label>
            ))}
          </fieldset>

          <div className="grid-3">
            <label>
              Priority
              <input type="number" min={-10} max={10} value={priority} onChange={(e) => setPriority(Number(e.target.value))} />
            </label>
            <label>
              Deadline (optional)
              <input type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
            </label>
            <label>
              Run after (dependencies)
              <select multiple value={dependsOn} onChange={(e) => setDependsOn(Array.from(e.target.selectedOptions, (o) => o.value))}>
                {open.data?.items.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button type="submit" className="btn btn-primary" disabled={action.pending || !instruction.trim()}>
            {action.pending ? 'Submitting…' : 'Submit task'}
          </button>
        </form>
      </Card>
    </div>
  );
}
