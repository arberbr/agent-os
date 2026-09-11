import { config } from '../config.js';

/**
 * Vercel REST API client (access token from vercel.com/account/tokens).
 * https://vercel.com/docs/rest-api — one token, optional team scoping.
 */

export interface VercelClient {
  token: string;
  teamId: string | null;
}

export function isVercelConfigured(): boolean {
  return Boolean(config.vercelToken);
}

export function vercelStatus() {
  return {
    configured: isVercelConfigured(),
    tokenHint: config.vercelToken ? `${config.vercelToken.slice(0, 4)}…` : null,
    teamId: config.vercelTeamId || null,
  };
}

export function makeVercelClient(): VercelClient | null {
  return config.vercelToken ? { token: config.vercelToken, teamId: config.vercelTeamId || null } : null;
}

const API_ROOT = 'https://api.vercel.com';

/** Human-friendly Vercel API error messages. */
export function vercelErrorMessage(err: unknown): string {
  const e = err as {
    status?: number;
    body?: { error?: { message?: string; code?: string } };
  };
  const raw = e?.body?.error?.message?.trim() || String(err);
  const status = e?.status ?? 0;

  if (status === 401) {
    return `Vercel authentication failed (${raw}). The VERCEL_TOKEN in .env is invalid, expired or revoked — create a new one at vercel.com/account/tokens and restart.`;
  }
  if (status === 403) {
    return `Vercel refused the request (403): ${raw} — the token likely lacks the required scope. Use the "Full Account" scope${config.vercelTeamId ? '' : ' or make sure VERCEL_TEAM_ID matches the token\'s team'}.`;
  }
  if (status === 404) {
    return `Not found on Vercel (${raw}). Check the project/deployment/domain id${config.vercelTeamId ? ` and the VERCEL_TEAM_ID setting` : ''}.`;
  }
  return raw || 'Unknown Vercel error.';
}

interface VcInit {
  method?: string;
  body?: unknown;
}

/** Fetch from the Vercel API and parse JSON (throws friendly errors). */
export async function vcRequest(
  client: VercelClient,
  path: string,
  init: VcInit = {},
): Promise<unknown> {
  const url = new URL(`${API_ROOT}${path}`);
  if (client.teamId) url.searchParams.set('teamId', client.teamId);

  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${client.token}`,
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let data: unknown = undefined;
  try {
    data = text ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    data = text;
  }
  if (!res.ok) {
    throw new Error(vercelErrorMessage({ status: res.status, body: data as { error?: { message?: string } } }));
  }
  return data;
}

// ── Identity (used by status/test endpoints) ────────────────────────────

export async function vercelGetUser(client: VercelClient): Promise<{ id: string; username: string; email: string | null; name: string | null }> {
  const data = (await vcRequest(client, '/v2/user')) as {
    user?: { id?: string; username?: string; email?: string | null; name?: string | null };
  };
  const user = data.user ?? {};
  return {
    id: user.id ?? '',
    username: user.username ?? '',
    email: user.email ?? null,
    name: user.name ?? null,
  };
}

// ── Projects ────────────────────────────────────────────────────────────

export interface ProjectInfo {
  id: string;
  name: string;
  framework: string | null;
  gitSource: { type: string; repo: string } | null;
  updatedAt: string | null;
  createdAt: string | null;
}

type ProjectJson = {
  id?: string;
  name?: string;
  framework?: string | null;
  updatedAt?: number | null;
  createdAt?: number | null;
  link?: { type?: string; repo?: string };
};

function toProjectInfo(p: ProjectJson): ProjectInfo {
  return {
    id: p.id ?? '',
    name: p.name ?? '',
    framework: p.framework ?? null,
    gitSource: p.link?.type && p.link?.repo ? { type: p.link.type, repo: p.link.repo } : null,
    updatedAt: p.updatedAt != null ? new Date(p.updatedAt).toISOString() : null,
    createdAt: p.createdAt != null ? new Date(p.createdAt).toISOString() : null,
  };
}

export async function vercelListProjects(
  client: VercelClient,
  args: { limit?: number },
): Promise<ProjectInfo[]> {
  const limit = Math.min(args.limit ?? 20, 100);
  const data = (await vcRequest(client, `/v9/projects?limit=${limit}`)) as { projects?: ProjectJson[] };
  return (data.projects ?? []).map(toProjectInfo);
}

export async function vercelGetProject(
  client: VercelClient,
  idOrName: string,
): Promise<ProjectInfo & { envKeys: string[]; productionAlias: string | null }> {
  const data = (await vcRequest(client, `/v9/projects/${encodeURIComponent(idOrName)}`)) as ProjectJson & {
    env?: Array<{ key?: string }>;
    alias?: Array<{ alias?: string; target?: string }>;
  };
  const info = toProjectInfo(data);
  return {
    ...info,
    envKeys: (data.env ?? []).map((e) => e.key ?? '').filter(Boolean),
    productionAlias: data.alias?.find((a) => a.target === 'production')?.alias ?? null,
  };
}

// ── Deployments ─────────────────────────────────────────────────────────

export interface DeploymentInfo {
  id: string;
  name: string;
  state: string;
  readyState: string | null;
  target: string | null;
  url: string;
  aliases: string[];
  createdAt: string | null;
  ready: string | null;
}

type DeploymentJson = {
  uid?: string;
  id?: string;
  name?: string;
  state?: string;
  readyState?: string | null;
  target?: string | null;
  url?: string;
  alias?: string[];
  createdAt?: number | string | null;
  ready?: number | string | null;
};

function toDeploymentInfo(d: DeploymentJson): DeploymentInfo {
  const createdAt = typeof d.createdAt === 'number' ? d.createdAt : Date.parse(String(d.createdAt ?? ''));
  const ready = typeof d.ready === 'number' ? d.ready : Date.parse(String(d.ready ?? ''));
  return {
    id: d.uid ?? d.id ?? '',
    name: d.name ?? '',
    state: d.state ?? '',
    readyState: d.readyState ?? null,
    target: d.target ?? null,
    url: d.url ?? '',
    aliases: d.alias ?? [],
    createdAt: Number.isFinite(createdAt) ? new Date(createdAt).toISOString() : null,
    ready: Number.isFinite(ready) ? new Date(ready).toISOString() : null,
  };
}

export async function vercelListDeployments(
  client: VercelClient,
  args: { projectId: string; limit?: number; state?: string },
): Promise<DeploymentInfo[]> {
  const params = new URLSearchParams();
  params.set('projectId', args.projectId);
  params.set('limit', String(Math.min(args.limit ?? 10, 100)));
  if (args.state) params.set('state', args.state);
  const data = (await vcRequest(client, `/v6/deployments?${params}`)) as { deployments?: DeploymentJson[] };
  return (data.deployments ?? []).map(toDeploymentInfo);
}

export async function vercelGetDeployment(client: VercelClient, id: string): Promise<DeploymentInfo> {
  const data = (await vcRequest(client, `/v13/deployments/${encodeURIComponent(id)}`)) as DeploymentJson;
  return toDeploymentInfo(data);
}

/** Redeploy a deployment from the same source (git or previous build). */
export async function vercelRedeploy(
  client: VercelClient,
  args: { deploymentId: string },
): Promise<DeploymentInfo> {
  const data = (await vcRequest(
    client,
    `/v13/deployments?deploymentId=${encodeURIComponent(args.deploymentId)}&forceNew=1`,
    { method: 'POST', body: {} },
  )) as DeploymentJson;
  return toDeploymentInfo(data);
}

/** Cancel a running deployment. */
export async function vercelCancelDeployment(
  client: VercelClient,
  id: string,
): Promise<{ ok: boolean; state: string }> {
  const data = (await vcRequest(client, `/v12/deployments/${encodeURIComponent(id)}/cancel`, { method: 'PATCH' })) as {
    state?: string;
  };
  return { ok: data.state === 'CANCELED', state: data.state ?? '' };
}

// ── Domains & env vars ──────────────────────────────────────────────────

export interface DomainInfo {
  name: string;
  verified: boolean;
}

export async function vercelListDomains(
  client: VercelClient,
  args: { limit?: number },
): Promise<DomainInfo[]> {
  const limit = Math.min(args.limit ?? 20, 100);
  const data = (await vcRequest(client, `/v9/domains?limit=${limit}`)) as {
    domains?: Array<{ name?: string; verified?: boolean }>;
  };
  return (data.domains ?? []).map((d) => ({ name: d.name ?? '', verified: d.verified ?? false }));
}

export interface EnvVarInfo {
  key: string;
  targets: string[];
  type: string;
  value: string | null;
}

export async function vercelListProjectEnv(
  client: VercelClient,
  args: { projectId: string; decrypt?: boolean },
): Promise<EnvVarInfo[]> {
  const decrypt = args.decrypt ?? false;
  const data = (await vcRequest(client, `/v9/projects/${encodeURIComponent(args.projectId)}/env?decrypt=${decrypt}`)) as {
    envs?: Array<{ key?: string; target?: string[]; type?: string; value?: string | null }>;
  };
  return (data.envs ?? []).map((e) => ({
    key: e.key ?? '',
    targets: e.target ?? [],
    type: e.type ?? '',
    value: decrypt ? (e.value ?? null) : null,
  }));
}
