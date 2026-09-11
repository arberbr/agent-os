import { registerTool, type ToolContext } from './registry.js';
import {
  supabaseCreateUser, supabaseDeleteRows, supabaseInsertRows, supabaseListTables,
  supabaseQueryRows, supabaseRunSql, supabaseUpdateRows, supabaseUploadFile,
} from '../supabase/client.js';

async function requireSupabase(ctx: ToolContext) {
  if (ctx.supabase) return ctx.supabase;
  throw new Error('Supabase is not connected. Set SUPABASE_PROJECT_REF and SUPABASE_SERVICE_ROLE_KEY in .env (Dashboard → Project Settings → API), restart the server, then check the Integrations page.');
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : v == null ? fallback : String(v));
const num = (v: unknown, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const strArr = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

// ── Schema & SQL ────────────────────────────────────────────────────────

registerTool({
  name: 'supabase_list_tables',
  description: 'List all tables in the Supabase project database (schema, name, row-level-security enabled).',
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  requiresSupabase: true,
  async execute(_args, ctx) {
    const client = await requireSupabase(ctx);
    return supabaseListTables(client);
  },
});

registerTool({
  name: 'supabase_run_sql',
  description: 'Run a SQL query/statement against the Supabase project database and return the rows. Always confirm with the user before running INSERT/UPDATE/DELETE/DDL statements.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'SQL query, e.g. "select id, email from auth.users limit 10"' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  requiresSupabase: true,
  async execute(args, ctx) {
    const client = await requireSupabase(ctx);
    return supabaseRunSql(client, str(args.query));
  },
});

// ── Table data (PostgREST) ──────────────────────────────────────────────

registerTool({
  name: 'supabase_query_rows',
  description: 'Query rows from a Supabase table via PostgREST. select is a comma-separated column list (or "*"); filters are PostgREST expressions like "status=eq.open", "age=gte.18", "name=ilike.*smith*"; order like "created_at.desc".',
  parameters: {
    type: 'object',
    properties: {
      table: { type: 'string', description: 'Table name (optionally schema-qualified, e.g. "public.todos")' },
      select: { type: 'string', description: 'Columns to return, default *' },
      filters: { type: 'array', items: { type: 'string' }, description: 'PostgREST filter expressions' },
      order: { type: 'string', description: 'e.g. created_at.desc' },
      limit: { type: 'number', description: 'Default 100, max 1000' },
    },
    required: ['table'],
    additionalProperties: false,
  },
  requiresSupabase: true,
  async execute(args, ctx) {
    const client = await requireSupabase(ctx);
    return supabaseQueryRows(client, {
      table: str(args.table),
      select: str(args.select) || undefined,
      filters: strArr(args.filters),
      order: str(args.order) || undefined,
      limit: num(args.limit, 100),
    });
  },
});

registerTool({
  name: 'supabase_insert_rows',
  description: 'Insert rows into a Supabase table and return the stored rows. Always confirm with the user before inserting.',
  parameters: {
    type: 'object',
    properties: {
      table: { type: 'string', description: 'Table name' },
      rows: { type: 'array', description: 'Row objects to insert' },
    },
    required: ['table', 'rows'],
    additionalProperties: false,
  },
  requiresSupabase: true,
  async execute(args, ctx) {
    const client = await requireSupabase(ctx);
    const rows = Array.isArray(args.rows) ? args.rows.map(obj) : [obj(args.rows)];
    return supabaseInsertRows(client, { table: str(args.table), rows });
  },
});

registerTool({
  name: 'supabase_update_rows',
  description: 'Update rows in a Supabase table (matched by filters) and return the updated rows. Always confirm with the user before updating.',
  parameters: {
    type: 'object',
    properties: {
      table: { type: 'string', description: 'Table name' },
      filters: { type: 'array', items: { type: 'string' }, description: 'PostgREST filter expressions, e.g. "id=eq.42" — required so you update exactly the intended rows' },
      values: { type: 'object', description: 'Column values to set' },
    },
    required: ['table', 'filters', 'values'],
    additionalProperties: false,
  },
  requiresSupabase: true,
  async execute(args, ctx) {
    const client = await requireSupabase(ctx);
    return supabaseUpdateRows(client, {
      table: str(args.table),
      filters: strArr(args.filters),
      values: obj(args.values),
    });
  },
});

registerTool({
  name: 'supabase_delete_rows',
  description: 'Delete rows from a Supabase table (matched by filters) and return the deleted rows. Always confirm with the user before deleting.',
  parameters: {
    type: 'object',
    properties: {
      table: { type: 'string', description: 'Table name' },
      filters: { type: 'array', items: { type: 'string' }, description: 'PostgREST filter expressions, e.g. "id=eq.42" — required so you delete exactly the intended rows' },
    },
    required: ['table', 'filters'],
    additionalProperties: false,
  },
  requiresSupabase: true,
  async execute(args, ctx) {
    const client = await requireSupabase(ctx);
    return supabaseDeleteRows(client, { table: str(args.table), filters: strArr(args.filters) });
  },
});

// ── Storage ─────────────────────────────────────────────────────────────

registerTool({
  name: 'supabase_upload_file',
  description: 'Upload a file to a Supabase Storage bucket. contentBase64 is the base64-encoded file content. Returns the storage key and the public URL (public buckets only).',
  parameters: {
    type: 'object',
    properties: {
      bucket: { type: 'string', description: 'Bucket name' },
      path: { type: 'string', description: 'Object path inside the bucket, e.g. "avatars/team.png"' },
      contentBase64: { type: 'string', description: 'Base64 file content' },
      contentType: { type: 'string', description: 'MIME type, e.g. image/png' },
    },
    required: ['bucket', 'path', 'contentBase64'],
    additionalProperties: false,
  },
  requiresSupabase: true,
  async execute(args, ctx) {
    const client = await requireSupabase(ctx);
    return supabaseUploadFile(client, {
      bucket: str(args.bucket),
      path: str(args.path),
      contentBase64: str(args.contentBase64),
      contentType: str(args.contentType) || undefined,
    });
  },
});

// ── Auth admin ──────────────────────────────────────────────────────────

registerTool({
  name: 'supabase_create_user',
  description: 'Create an auth user in the Supabase project (admin API). The user\'s email is confirmed by default, so they can sign in immediately.',
  parameters: {
    type: 'object',
    properties: {
      email: { type: 'string' },
      password: { type: 'string', description: 'Initial password' },
      emailConfirm: { type: 'boolean', description: 'Confirm the email now (default true)' },
      displayName: { type: 'string' },
    },
    required: ['email', 'password'],
    additionalProperties: false,
  },
  requiresSupabase: true,
  async execute(args, ctx) {
    const client = await requireSupabase(ctx);
    return supabaseCreateUser(client, {
      email: str(args.email),
      password: str(args.password),
      emailConfirm: args.emailConfirm === undefined ? true : args.emailConfirm === true,
      displayName: str(args.displayName) || undefined,
    });
  },
});
