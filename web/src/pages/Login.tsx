import { FormEvent, useState } from 'react';
import { post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAction } from '../lib/hooks';
import { ErrorBox } from '../components/ui';

export function LoginPage() {
  const { needsBootstrap, refresh, serverError } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const action = useAction();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await action.run(async () => {
      if (needsBootstrap) await post('/api/auth/bootstrap', { email, displayName, password });
      await post('/api/auth/login', { email, password });
    });
    if (ok) await refresh();
  };

  return (
    <main className="login" id="main">
      <form className="card login-card" onSubmit={submit} aria-labelledby="login-title">
        <h1 id="login-title">{needsBootstrap ? 'Set up WinAgent' : 'Sign in to WinAgent'}</h1>
        {needsBootstrap && <p className="muted">Create the first administrator account. This is only possible while no accounts exist.</p>}
        <ErrorBox message={serverError ?? action.error} />
        {needsBootstrap && (
          <label>
            Display name
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required maxLength={100} autoComplete="name" />
          </label>
        )}
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" autoFocus />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={needsBootstrap ? 12 : 1}
            autoComplete={needsBootstrap ? 'new-password' : 'current-password'}
            aria-describedby={needsBootstrap ? 'pw-help' : undefined}
          />
        </label>
        {needsBootstrap && (
          <p id="pw-help" className="hint">
            At least 12 characters.
          </p>
        )}
        <button type="submit" className="btn btn-primary" disabled={action.pending}>
          {action.pending ? 'Please wait…' : needsBootstrap ? 'Create administrator' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
