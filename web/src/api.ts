import type {
  AgentDef, AdminStats, AppSettings, AuthState, PublicConfig, PublicUser, RunDetail, RunSummary,
  GoogleStatus, MailInput, MailStatus, Schedule, ScheduleInput, SchedulePreview, UserRole,
} from './types';

/**
 * Fired whenever the server answers 401 — the session expired or was revoked.
 * The auth provider listens for it and drops straight back to the login screen
 * instead of leaving a half-dead console on screen.
 */
export const UNAUTHORIZED_EVENT = 'agentos:unauthorized';

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (res.status === 204) return undefined as T;
  // `window.Event` on purpose: this also has to work under jsdom (smoke test),
  // where the bare `Event` global is Node's, not the one dispatchEvent accepts.
  if (res.status === 401) window.dispatchEvent(new window.Event(UNAUTHORIZED_EVENT));
  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const message = (json as { error?: string } | undefined)?.error ?? `HTTP ${res.status}`;
    throw new Error(message);
  }
  return json as T;
}

/* ── Accounts ──────────────────────────────────────────────────────────── */

export const getAuthState = () => api<AuthState>('/api/auth/state');
export const login = (email: string, password: string) =>
  api<{ user: PublicUser }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
export const signup = (input: { email: string; password: string; name?: string }) =>
  api<{ user: PublicUser }>('/api/auth/signup', { method: 'POST', body: JSON.stringify(input) });
export const logout = () => api<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });
export const updateProfile = (input: { name?: string; currentPassword?: string; newPassword?: string }) =>
  api<{ user: PublicUser }>('/api/auth/me', { method: 'PATCH', body: JSON.stringify(input) });

/* ── Administration ────────────────────────────────────────────────────── */

export const getSettings = () =>
  api<{ settings: AppSettings; stats: AdminStats }>('/api/admin/settings');
export const updateSettings = (patch: Partial<AppSettings>) =>
  api<{ settings: AppSettings; stats: AdminStats }>('/api/admin/settings', {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
export const listUsers = () => api<PublicUser[]>('/api/admin/users');
export const createUser = (input: { email: string; name?: string; password: string; role: UserRole }) =>
  api<PublicUser>('/api/admin/users', { method: 'POST', body: JSON.stringify(input) });
export const updateUser = (id: string, patch: { name?: string; role?: UserRole; password?: string }) =>
  api<PublicUser>(`/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
export const deleteUser = (id: string) => api<void>(`/api/admin/users/${id}`, { method: 'DELETE' });

/* ── Email notifications (admins) ──────────────────────────────────────── */

export const getMail = () => api<{ mail: MailStatus }>('/api/admin/mail');
/** Omitting `password` keeps the stored one; an empty string clears it. */
export const updateMail = (patch: MailInput) =>
  api<{ mail: MailStatus }>('/api/admin/mail', { method: 'PUT', body: JSON.stringify(patch) });
export const clearMail = () => api<{ mail: MailStatus }>('/api/admin/mail', { method: 'DELETE' });
/** Open the connection and authenticate; with `to`, also deliver a real test. */
export const testMail = (to?: string) =>
  api<{ ok: boolean; to: string | null; checks: Record<string, { ok: boolean; sample?: unknown; error?: string }> }>(
    '/api/admin/mail/test',
    { method: 'POST', body: JSON.stringify({ to }) },
  );

/* ── Console data ──────────────────────────────────────────────────────── */

export const getConfig = () => api<PublicConfig>('/api/config');
export const listAgents = () => api<AgentDef[]>('/api/agents');
export const createAgent = (input: Partial<AgentDef>) =>
  api<AgentDef>('/api/agents', { method: 'POST', body: JSON.stringify(input) });
export const updateAgent = (id: string, input: Partial<AgentDef>) =>
  api<AgentDef>(`/api/agents/${id}`, { method: 'PUT', body: JSON.stringify(input) });
export const deleteAgent = (id: string) =>
  api<void>(`/api/agents/${id}`, { method: 'DELETE' });
export const listRuns = (limit = 50) => api<RunSummary[]>(`/api/runs?limit=${limit}`);
export const getRun = (id: string) => api<RunDetail>(`/api/runs/${id}`);
export const deleteRun = (id: string) => api<void>(`/api/runs/${id}`, { method: 'DELETE' });

/* ── Scheduled runs ────────────────────────────────────────────────────── */

export const listSchedules = () => api<Schedule[]>('/api/schedules');
export const getSchedule = (id: string) => api<Schedule>(`/api/schedules/${id}`);
export const createSchedule = (input: ScheduleInput) =>
  api<Schedule>('/api/schedules', { method: 'POST', body: JSON.stringify(input) });
export const updateSchedule = (id: string, input: ScheduleInput) =>
  api<Schedule>(`/api/schedules/${id}`, { method: 'PUT', body: JSON.stringify(input) });
export const deleteSchedule = (id: string) => api<void>(`/api/schedules/${id}`, { method: 'DELETE' });
/** Fire a schedule immediately; the run continues in the background. */
export const runScheduleNow = (id: string) =>
  api<{ runId: string; schedule: Schedule }>(`/api/schedules/${id}/run`, { method: 'POST' });
/** Validate a cron expression and preview its next firing times. */
export const previewSchedule = (cron: string, count = 3) =>
  api<SchedulePreview>('/api/schedules/preview', {
    method: 'POST',
    body: JSON.stringify({ cron, count }),
  });
export const llmTest = (prompt?: string) =>
  api<{ ok: boolean; model?: string; reply?: string; ms?: number; error?: string }>('/api/llm/test', {
    method: 'POST',
    body: JSON.stringify({ prompt }),
  });
export const googleStatus = () => api<GoogleStatus>('/api/google/status');
export const googleDisconnect = () => api<{ connected: boolean }>('/api/google/disconnect', { method: 'POST' });
export const googleTest = () =>
  api<{ connected: boolean; checks: Record<string, { ok: boolean; sample?: unknown; error?: string }> }>(
    '/api/google/test',
    { method: 'POST' },
  );
export const githubTest = () =>
  api<{ connected: boolean; checks: Record<string, { ok: boolean; sample?: unknown; error?: string }> }>(
    '/api/github/test',
    { method: 'POST' },
  );
export const vercelTest = () =>
  api<{ connected: boolean; checks: Record<string, { ok: boolean; sample?: unknown; error?: string }> }>(
    '/api/vercel/test',
    { method: 'POST' },
  );
export const supabaseTest = () =>
  api<{ connected: boolean; checks: Record<string, { ok: boolean; sample?: unknown; error?: string }> }>(
    '/api/supabase/test',
    { method: 'POST' },
  );
