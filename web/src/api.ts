import type {
  AgentDef, PublicConfig, RunDetail, RunSummary, GoogleStatus,
} from './types';

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const message = (json as { error?: string } | undefined)?.error ?? `HTTP ${res.status}`;
    throw new Error(message);
  }
  return json as T;
}

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
