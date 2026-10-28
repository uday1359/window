import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { ApiError, get, post } from './api';
import type { Me } from './types';

interface AuthState {
  me: Me | null;
  loading: boolean;
  needsBootstrap: boolean;
  serverError: string | null;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  can: (permission: string) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [needsBootstrap, setNeedsBootstrap] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const status = await get<{ needsBootstrap: boolean }>('/api/auth/status');
      setNeedsBootstrap(status.needsBootstrap);
      setServerError(null);
      if (status.needsBootstrap) {
        setMe(null);
        return;
      }
      setMe(await get<Me>('/api/auth/me'));
    } catch (err) {
      setMe(null);
      if (err instanceof ApiError && err.status === 0) setServerError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onUnauthorized = () => setMe(null);
    window.addEventListener('winagent:unauthorized', onUnauthorized);
    return () => window.removeEventListener('winagent:unauthorized', onUnauthorized);
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await post('/api/auth/logout');
    } finally {
      setMe(null);
    }
  }, []);

  // UI hints only: the server enforces every permission independently.
  const can = useCallback((permission: string) => !!me?.permissions.includes(permission), [me]);

  return <AuthContext.Provider value={{ me, loading, needsBootstrap, serverError, refresh, logout, can }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
