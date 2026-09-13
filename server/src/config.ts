import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Google scopes are split into groups because Google refuses to combine
 * YouTube scopes with Drive scopes in a single authorization request
 * ("This request contains scopes that cannot be requested together").
 * Each group is granted through its own incremental-authorization consent
 * (include_granted_scopes), and Google merges the grants into one token.
 */
export const IDENTITY_SCOPES = ['openid', 'email', 'profile'];

const DEFAULT_WORKSPACE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/drive.file',
  // Docs/Sheets formatting (Markdown docs, appending, reading sheet values).
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets',
];

const DEFAULT_YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/youtube.upload',
];

export type ScopeGroup = 'workspace' | 'youtube';

function isYoutubeScope(scope: string): boolean {
  return scope.includes('/auth/youtube');
}

/**
 * Resolve the two scope groups. Supports the older single-list `GOOGLE_SCOPES`
 * variable by automatically routing its YouTube entries into their own group.
 */
function resolveScopeGroups(): Record<ScopeGroup, string[]> {
  const legacy = process.env.GOOGLE_SCOPES?.trim();
  if (legacy) {
    const all = parseEnvList(legacy, []).filter((s) => !IDENTITY_SCOPES.includes(s));
    return {
      workspace: all.filter((s) => !isYoutubeScope(s)),
      youtube: all.filter(isYoutubeScope),
    };
  }
  return {
    workspace: parseEnvList(process.env.GOOGLE_SCOPES_WORKSPACE, DEFAULT_WORKSPACE_SCOPES).filter((s) => !IDENTITY_SCOPES.includes(s)),
    youtube: parseEnvList(process.env.GOOGLE_SCOPES_YOUTUBE, DEFAULT_YOUTUBE_SCOPES).filter((s) => !IDENTITY_SCOPES.includes(s)),
  };
}

function parseEnvList(value: string | undefined, fallback: string[]): string[] {
  if (!value || value.trim() === '') return fallback;
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** A positive numeric env var, falling back when unset or unusable. */
function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Like `positiveNumber`, but kept inside a usable range. */
function boundedNumber(value: string | undefined, fallback: number, min: number, max: number, allowZero = false): number {
  const parsed = Number(value);
  const usable = Number.isFinite(parsed) && (parsed > 0 || (allowZero && parsed === 0)) ? parsed : fallback;
  return Math.min(Math.max(usable, min), max);
}

function parseExtraHeaders(value: string | undefined): Record<string, string> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string') out[k] = v;
      }
      return out;
    }
  } catch {
    // fall through to empty
  }
  return {};
}

const serverDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Minimal .env loader (no dependency): applies KEY=VALUE pairs from
 * <cwd>/.env and <cwd>/../.env if they exist and the variable is unset.
 */
function loadDotEnv(): void {
  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '..', '.env'),
  ];
  for (const file of candidates) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq <= 0) continue;
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        if (process.env[key] === undefined) process.env[key] = value;
      }
    } catch {
      // no .env file — fine
    }
  }
}
loadDotEnv();

export interface Config {
  port: number;
  publicUrl: string;
  dataDir: string;
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  llmExtraHeaders: Record<string, string>;
  llmThinkingMode: '' | 'enabled' | 'disabled';
  llmReasoningEffort: string;
  llmMock: boolean;
  agentMaxSteps: number;
  toolResultMaxChars: number;
  /** Prior turns of a continued session replayed into the next request. */
  conversationHistoryMaxChars: number;
  /** Scheduled runs (cron-style recurring agent runs). */
  scheduler: {
    /** false = the engine never starts; schedules are stored but never fire. */
    enabled: boolean;
    /** How often the engine looks for work, in seconds. */
    tickSeconds: number;
    /** Scheduled runs allowed to execute at the same time. */
    maxConcurrency: number;
    /** Consecutive failures before a schedule pauses itself (0 = never). */
    maxFailures: number;
  };
  googleClientId: string;
  googleClientSecret: string;
  /** Per-group scope lists (identity scopes are added by the auth layer). */
  googleScopeGroups: Record<ScopeGroup, string[]>;
  googleRedirectUri: string;
  /** GitHub personal access token (classic or fine-grained). */
  githubToken: string;
  /** Vercel access token (https://vercel.com/account/tokens). */
  vercelToken: string;
  /** Optional Vercel team id for team-scoped tokens. */
  vercelTeamId: string;
  /** Supabase project ref (the xxx in https://xxx.supabase.co). */
  supabaseProjectRef: string;
  /** Supabase service_role key (Dashboard → Project Settings → API). */
  supabaseServiceRoleKey: string;
  /** Optional Supabase management-API personal access token (SQL, table listing). */
  supabaseAccessToken: string;
}

function buildConfig(): Config {
  const port = Number(process.env.PORT ?? 8787);
  const publicUrl = (process.env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, '');
  const dataDir = path.resolve(serverDir, '..', process.env.DATA_DIR ?? './data');
  const googleClientId = process.env.GOOGLE_CLIENT_ID ?? '';
  const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET ?? '';
  const thinkingModeRaw = (process.env.LLM_THINKING_MODE ?? '').toLowerCase();
  const llmThinkingMode = thinkingModeRaw === 'enabled' || thinkingModeRaw === 'disabled'
    ? thinkingModeRaw
    : thinkingModeRaw
      ? 'enabled'
      : '';

  return {
    port,
    publicUrl,
    dataDir,
    llmBaseUrl: (process.env.LLM_BASE_URL ?? 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
    llmApiKey: process.env.LLM_API_KEY ?? '',
    llmModel: process.env.LLM_MODEL ?? 'deepseek-v4-pro',
    llmExtraHeaders: parseExtraHeaders(process.env.LLM_EXTRA_HEADERS),
    llmThinkingMode,
    llmReasoningEffort: process.env.LLM_REASONING_EFFORT ?? 'high',
    llmMock: (process.env.LLM_PROVIDER ?? '').toLowerCase() === 'mock',
    agentMaxSteps: Number(process.env.AGENT_MAX_STEPS ?? 12),
    toolResultMaxChars: Number(process.env.TOOL_RESULT_MAX_CHARS ?? 8000),
    conversationHistoryMaxChars: positiveNumber(process.env.CONVERSATION_HISTORY_MAX_CHARS, 80_000),
    scheduler: {
      // `SCHEDULER_ENABLED=false` parks the engine without deleting anything.
      enabled: (process.env.SCHEDULER_ENABLED ?? 'true').toLowerCase() !== 'false',
      tickSeconds: boundedNumber(process.env.SCHEDULER_TICK_SECONDS, 20, 5, 3600),
      maxConcurrency: boundedNumber(process.env.SCHEDULE_MAX_CONCURRENCY, 2, 1, 10),
      // 0 disables the self-pause, so a flaky integration can be retried forever.
      maxFailures: boundedNumber(process.env.SCHEDULE_MAX_FAILURES, 5, 0, 100, true),
    },
    googleClientId,
    googleClientSecret,
    googleScopeGroups: resolveScopeGroups(),
    googleRedirectUri: `${publicUrl}/api/google/callback`,
    githubToken: process.env.GITHUB_TOKEN?.trim() ?? '',
    vercelToken: process.env.VERCEL_TOKEN?.trim() ?? '',
    vercelTeamId: process.env.VERCEL_TEAM_ID?.trim() ?? '',
    supabaseProjectRef: (process.env.SUPABASE_PROJECT_REF ?? '').trim().replace(/\/+$/, ''),
    supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? '',
    supabaseAccessToken: process.env.SUPABASE_ACCESS_TOKEN?.trim() ?? '',
  };
}

export const config: Config = buildConfig();

/**
 * Browser origins allowed to call the API with credentials: the instance's own
 * origin(s) plus the Vite dev server. Anything else is rejected, so a random
 * page cannot ride the session cookie (see `sameOriginOnly` in auth.ts).
 */
export const allowedOrigins: string[] = [...new Set(
  [
    config.publicUrl,
    ...(process.env.WEB_ORIGIN ?? '').split(',').map((origin) => origin.trim().replace(/\/+$/, '')),
    `http://localhost:${config.port}`,
    `http://127.0.0.1:${config.port}`,
    'http://localhost:5173',
    'http://127.0.0.1:5173',
  ].filter(Boolean),
)];

export function ensureDataDir(): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
}
