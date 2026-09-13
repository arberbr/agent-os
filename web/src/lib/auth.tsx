import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  UNAUTHORIZED_EVENT, getAuthState, login as loginRequest, logout as logoutRequest,
  signup as signupRequest,
} from '../api';
import type { AuthState, PublicUser } from '../types';

/**
 * Who is signed in.
 *
 * The session itself lives in an HttpOnly cookie the browser cannot read, so
 * the only source of truth is `GET /api/auth/state`. Every 401 from any API
 * call re-asks that endpoint, which is what makes an expired session fall back
 * to the login screen instead of an empty console.
 */
interface AuthValue {
  status: 'loading' | 'ready';
  user: PublicUser | null;
  /** Signup rules and session length, as reported by the server. */
  state: AuthState | null;
  isAdmin: boolean;
  refresh: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  signup: (input: { email: string; password: string; name?: string }) => Promise<void>;
  logout: () => Promise<void>;
  /** Replace the cached user after a profile edit. */
  setUser: (user: PublicUser) => void;
}

const AuthContext = createContext<AuthValue>({
  status: 'loading',
  user: null,
  state: null,
  isAdmin: false,
  refresh: async () => {},
  login: async () => {},
  signup: async () => {},
  logout: async () => {},
  setUser: () => {},
});

export function useAuth(): AuthValue {
  return useContext(AuthContext);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<'loading' | 'ready'>('loading');
  const [state, setState] = useState<AuthState | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const next = await getAuthState();
      if (mounted.current) setState(next);
    } catch {
      // The API is unreachable; the console's own error screen covers it.
    } finally {
      if (mounted.current) setStatus('ready');
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const onUnauthorized = () => void refresh();
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => {
      mounted.current = false;
      window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    };
  }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    const { user } = await loginRequest(email, password);
    setState((prev) => (prev ? { ...prev, authenticated: true, user } : prev));
    await refresh();
  }, [refresh]);

  const signup = useCallback(async (input: { email: string; password: string; name?: string }) => {
    const { user } = await signupRequest(input);
    setState((prev) => (prev ? { ...prev, authenticated: true, user, needsSetup: false } : prev));
    await refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await logoutRequest();
    } finally {
      await refresh();
    }
  }, [refresh]);

  const setUser = useCallback((user: PublicUser) => {
    setState((prev) => (prev ? { ...prev, user } : prev));
  }, []);

  const value = useMemo<AuthValue>(() => ({
    status,
    user: state?.user ?? null,
    state,
    isAdmin: state?.user?.role === 'admin',
    refresh,
    login,
    signup,
    logout,
    setUser,
  }), [status, state, refresh, login, signup, logout, setUser]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
