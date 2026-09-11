import { config } from '../config.js';

/**
 * Supabase client: PostgREST data API (service_role key), the Storage API and
 * the Management API (optional personal access token for SQL / table listing).
 * https://supabase.com/docs/reference — keys live in .env, no OAuth.
 */

export interface SupabaseClient {
  /** Project ref, e.g. "abcdwxyz" for https://abcdwxyz.supabase.co. */
  ref: string;
  url: string;
  serviceRoleKey: string;
  /** Management-API PAT; null when not configured (SQL/table tools then unavailable). */
  accessToken: string | null;
}

export function isSupabaseConfigured(): boolean {
  return Boolean(config.supabaseProjectRef && config.supabaseServiceRoleKey);
}

export function supabaseStatus() {
  const configured = isSupabaseConfigured();
  return {
    configured,
    projectRef: configured ? config.supabaseProjectRef : null,
    url: configured ? `https://${config.supabaseProjectRef}.supabase.co` : null,
    managementConfigured: Boolean(config.supabaseAccessToken),
  };
}

export function makeSupabaseClient(): SupabaseClient | null {
  if (!isSupabaseConfigured()) return null;
  return {
    ref: config.supabaseProjectRef,
    url: `https://${config.supabaseProjectRef}.supabase.co`,
    serviceRoleKey: config.supabaseServiceRoleKey,
    accessToken: config.supabaseAccessToken || null,
  };
}

const MGMT_ROOT = 'https://api.supabase.com';

/** Human-friendly Supabase error messages. */
export function supabaseErrorMessage(err: unknown, context: 'postgrest' | 'management' | 'storage' | 'auth'): string {
  const e = err as {
    status?: number;
    body?: { message?: string; hint?: string; details?: string; error?: string; code?: string };
  };
  const raw = e?.body?.message?.trim() || e?.body?.error?.trim() || String(err);
  const status = e?.status ?? 0;

  if (context === 'management' && status === 401) {
    return `Supabase management API authentication failed (${raw}). The SUPABASE_ACCESS_TOKEN in .env is invalid or expired — create a new one at supabase.com/dashboard/account/tokens and restart.`;
  }
  if ((status === 401 || status === 403) && (context === 'postgrest' || context === 'storage' || context === 'auth')) {
    return `Supabase authentication failed (${raw}). Check SUPABASE_PROJECT_REF and SUPABASE_SERVICE_ROLE_KEY in .env (Dashboard → Project Settings → API), then restart.`;
  }
  if (status === 404 && context === 'postgrest') {
    const hint = e?.body?.hint ? ` ${e.body.hint}` : '';
    return `Supabase table or row not found (${raw}).${hint}`;
  }
  if (status === 400) {
    const hint = e?.body?.hint ? ` Hint: ${e.body.hint}` : '';
    const details = e?.body?.details ? ` Details: ${e.body.details}` : '';
    return `Supabase rejected the request: ${raw}${details}${hint}`;
  }
  if (status === 409) {
    return `Supabase conflict (${raw}) — likely a duplicate key or constraint violation.`;
  }
  return raw || 'Unknown Supabase error.';
}

interface SgInit {
  method?: string;
  body?: string | Uint8Array;
  headers?: Record<string, string>;
  context: 'postgrest' | 'management' | 'storage' | 'auth';
}

async function sgRequest(client: SupabaseClient, url: string, init: SgInit): Promise<unknown> {
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: init.headers,
    body: init.body,
  });
  const text = await res.text();
  let data: unknown = undefined;
  try {
    data = text ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    data = text;
  }
  if (!res.ok) {
    throw new Error(supabaseErrorMessage({ status: res.status, body: data as { message?: string } }, init.context));
  }
  return data;
}

function dataHeaders(client: SupabaseClient, extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: client.serviceRoleKey,
    Authorization: `Bearer ${client.serviceRoleKey}`,
    ...extra,
  };
}

/** Build PostgREST query params from select/order/limit + raw filter strings. */
function pgQuery(params: {
  select?: string;
  order?: string;
  limit?: number;
  filters?: string[];
  upsert?: boolean;
}): URLSearchParams {
  const q = new URLSearchParams();
  if (params.select) q.set('select', params.select);
  if (params.order) q.set('order', params.order);
  if (params.limit != null) q.set('limit', String(Math.min(params.limit, 1000)));
  if (params.upsert) q.set('on_conflict', '*');
  // Filters are raw PostgREST filter expressions like "status=eq.open";
  // they become query parameters verbatim (filters on the same column are
  // comma-combined by the caller, e.g. "id=in.(1,2,3)").
  for (const f of params.filters ?? []) {
    const eq = f.indexOf('=');
    if (eq <= 0) continue;
    const key = f.slice(0, eq);
    const value = f.slice(eq + 1);
    q.set(key, value);
  }
  return q;
}

// ── PostgREST (table data) ──────────────────────────────────────────────

export async function supabaseQueryRows(
  client: SupabaseClient,
  args: { table: string; select?: string; filters?: string[]; order?: string; limit?: number },
): Promise<Record<string, unknown>[]> {
  const q = pgQuery({ select: args.select, order: args.order, limit: args.limit, filters: args.filters });
  const data = await sgRequest(
    client,
    `${client.url}/rest/v1/${encodeURIComponent(args.table)}?${q}`,
    { headers: dataHeaders(client), context: 'postgrest' },
  );
  return data as Record<string, unknown>[];
}

export async function supabaseInsertRows(
  client: SupabaseClient,
  args: { table: string; rows: unknown[] },
): Promise<Record<string, unknown>[]> {
  const data = await sgRequest(client, `${client.url}/rest/v1/${encodeURIComponent(args.table)}`, {
    method: 'POST',
    headers: dataHeaders(client, { 'Content-Type': 'application/json', Prefer: 'return=representation' }),
    body: JSON.stringify(args.rows),
    context: 'postgrest',
  });
  return data as Record<string, unknown>[];
}

export async function supabaseUpdateRows(
  client: SupabaseClient,
  args: { table: string; filters?: string[]; values: Record<string, unknown> },
): Promise<Record<string, unknown>[]> {
  const q = pgQuery({ filters: args.filters });
  const data = await sgRequest(client, `${client.url}/rest/v1/${encodeURIComponent(args.table)}?${q}`, {
    method: 'PATCH',
    headers: dataHeaders(client, { 'Content-Type': 'application/json', Prefer: 'return=representation' }),
    body: JSON.stringify(args.values),
    context: 'postgrest',
  });
  return data as Record<string, unknown>[];
}

export async function supabaseDeleteRows(
  client: SupabaseClient,
  args: { table: string; filters?: string[] },
): Promise<Record<string, unknown>[]> {
  const q = pgQuery({ filters: args.filters });
  const data = await sgRequest(client, `${client.url}/rest/v1/${encodeURIComponent(args.table)}?${q}`, {
    method: 'DELETE',
    headers: dataHeaders(client, { Prefer: 'return=representation' }),
    context: 'postgrest',
  });
  return data as Record<string, unknown>[];
}

// ── Management API (needs SUPABASE_ACCESS_TOKEN) ────────────────────────

export interface SupabaseTable {
  schema: string;
  name: string;
  rlsEnabled: boolean;
}

export async function supabaseListTables(client: SupabaseClient): Promise<SupabaseTable[]> {
  if (!client.accessToken) {
    throw new Error('SUPABASE_ACCESS_TOKEN is not set in .env — it is required for listing tables (Dashboard → supabase.com/dashboard/account/tokens).');
  }
  const data = await sgRequest(client, `${MGMT_ROOT}/v1/projects/${client.ref}/database/tables`, {
    headers: { Authorization: `Bearer ${client.accessToken}` },
    context: 'management',
  });
  return (data as Array<{ schema?: string; name?: string; rls_enabled?: boolean }>).map((t) => ({
    schema: t.schema ?? '',
    name: t.name ?? '',
    rlsEnabled: t.rls_enabled ?? false,
  }));
}

/** Run arbitrary SQL against the project database (returns rows). */
export async function supabaseRunSql(
  client: SupabaseClient,
  query: string,
): Promise<Record<string, unknown>[]> {
  if (!client.accessToken) {
    throw new Error('SUPABASE_ACCESS_TOKEN is not set in .env — it is required for running SQL (Dashboard → supabase.com/dashboard/account/tokens).');
  }
  const data = await sgRequest(client, `${MGMT_ROOT}/v1/projects/${client.ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${client.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    context: 'management',
  });
  return (Array.isArray(data) ? data : []) as Record<string, unknown>[];
}

// ── Storage ─────────────────────────────────────────────────────────────

export async function supabaseUploadFile(
  client: SupabaseClient,
  args: { bucket: string; path: string; contentBase64: string; contentType?: string; upsert?: boolean },
): Promise<{ key: string; publicUrl: string }> {
  const keyPath = args.path.split('/').map(encodeURIComponent).join('/');
  await sgRequest(client, `${client.url}/storage/v1/object/${encodeURIComponent(args.bucket)}/${keyPath}`, {
    method: 'POST',
    headers: dataHeaders(client, {
      'Content-Type': args.contentType ?? 'application/octet-stream',
      ...(args.upsert !== false ? { 'x-upsert': 'true' } : {}),
    }),
    body: Buffer.from(args.contentBase64, 'base64'),
    context: 'storage',
  });
  return {
    key: `${args.bucket}/${args.path}`,
    publicUrl: `${client.url}/storage/v1/object/public/${encodeURIComponent(args.bucket)}/${keyPath}`,
  };
}

// ── Auth admin (service_role) ───────────────────────────────────────────

export async function supabaseCreateUser(
  client: SupabaseClient,
  args: { email: string; password: string; emailConfirm?: boolean; displayName?: string },
): Promise<{ id: string; email: string; createdAt: string }> {
  const data = await sgRequest(client, `${client.url}/auth/v1/admin/users`, {
    method: 'POST',
    headers: dataHeaders(client, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      email: args.email,
      password: args.password,
      email_confirm: args.emailConfirm ?? true,
      ...(args.displayName ? { user_metadata: { display_name: args.displayName } } : {}),
    }),
    context: 'auth',
  });
  const user = data as { id?: string; email?: string; created_at?: string };
  return { id: user.id ?? '', email: user.email ?? args.email, createdAt: user.created_at ?? '' };
}

// ── Live checks (used by the test endpoint) ─────────────────────────────

/** Project reachability — public health endpoint, no credentials needed. */
export async function supabaseHealth(client: SupabaseClient): Promise<{ name: string; version: string }> {
  const data = await sgRequest(client, `${client.url}/auth/v1/health`, { context: 'auth' });
  const health = data as { name?: string; version?: string };
  return { name: health.name ?? 'GoTrue', version: health.version ?? '' };
}

/** Verify the service_role key with a minimal admin API call. */
export async function supabaseAdminPing(client: SupabaseClient): Promise<{ users: number }> {
  const data = await sgRequest(client, `${client.url}/auth/v1/admin/users?page=1&per_page=1`, {
    headers: dataHeaders(client),
    context: 'auth',
  });
  const res = data as { users?: unknown[] };
  return { users: Array.isArray(res.users) ? res.users.length : 0 };
}

/** Management-API project info (needs SUPABASE_ACCESS_TOKEN). */
export async function supabaseProjectInfo(client: SupabaseClient): Promise<{ name: string; region: string; status: string }> {
  if (!client.accessToken) {
    throw new Error('SUPABASE_ACCESS_TOKEN is not set in .env — only needed for the SQL and table-listing tools.');
  }
  const data = await sgRequest(client, `${MGMT_ROOT}/v1/projects/${client.ref}`, {
    headers: { Authorization: `Bearer ${client.accessToken}` },
    context: 'management',
  });
  const project = data as { name?: string; region?: string; status?: string };
  return { name: project.name ?? '', region: project.region ?? '', status: project.status ?? '' };
}
