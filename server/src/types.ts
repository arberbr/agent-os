export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // JSON string
}

export interface ChatMessage {
  role: Role;
  content: string | null;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  /** DeepSeek V4: chain-of-thought trace that must be passed back when the
   *  assistant message emitted tool calls (API 400s otherwise). */
  reasoningContent?: string;
}

/** An agent the user created. A team is formed via `teamAgentIds`. */
export interface AgentDef {
  id: string;
  name: string;
  description: string;
  instructions: string;
  model: string; // '' = default model from config
  enabledTools: string[];
  teamAgentIds: string[];
  color: string;
  createdAt: string;
  updatedAt: string;
}

// ── Accounts & access ─────────────────────────────────────────────────

/** `admin` manages the instance (people + settings); `member` uses it. */
export type UserRole = 'admin' | 'member';

/** A stored account. `passwordHash` never leaves the server. */
export interface User {
  id: string;
  /** Lowercase, unique. The login identifier. */
  email: string;
  name: string;
  role: UserRole;
  /** `scrypt$<salt hex>$<key hex>`. */
  passwordHash: string;
  createdAt: string;
  lastLoginAt: string | null;
}

/** The shape of a user that may be sent to the browser. */
export type PublicUser = Omit<User, 'passwordHash'>;

/**
 * A signed-in browser. Only the sha-256 of the cookie token is stored, so a
 * leaked database file cannot be replayed as a live session.
 */
export interface Session {
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string;
}

/** Instance-wide settings, editable by an admin on the Settings page. */
export interface AppSettings {
  /** When false, only an admin can add people. */
  signupsEnabled: boolean;
  /** Empty = any email domain. Otherwise one of these suffixes (e.g. acme.com). */
  allowedSignupDomains: string[];
  /** How long a login lasts. */
  sessionDays: number;
  /** How many sessions (runs) the history keeps before pruning the oldest. */
  runHistoryLimit: number;
}

// ── Outgoing mail (SMTP) ────────────────────────────────────────────────

/**
 * How the SMTP connection is protected.
 *  - `starttls` — plaintext connect, then upgrade (port 587, the common case);
 *  - `tls`      — TLS from the first byte, implicit TLS (port 465);
 *  - `none`     — no encryption at all (port 25; only sane on a trusted LAN).
 */
export type MailSecurity = 'starttls' | 'tls' | 'none';

/**
 * The SMTP relay Agents OS sends notifications through, entered by an admin on
 * the Settings page and stored in the JSON database next to everything else.
 *
 * `password` is a live secret: it is never returned to the browser (the API
 * redacts it to a `hasPassword` flag) and never reaches the model provider.
 */
export interface MailSettings {
  /** Master switch: when false nothing is ever sent, whatever a schedule asks for. */
  enabled: boolean;
  host: string;
  port: number;
  security: MailSecurity;
  username: string;
  /** SMTP password / API key. Write-only from the console's point of view. */
  password: string;
  /** Display name on the From header (falls back to the sender address). */
  fromName: string;
  /** Sender address. Also the envelope sender. */
  fromEmail: string;
  /** Optional Reply-To. */
  replyTo: string;
  /**
   * true  → a self-signed or otherwise untrusted certificate fails the send;
   * false → accept it (internal relays). Defaults to true.
   */
  verifyCertificate: boolean;
  /** When the credentials were last written from the console. */
  updatedAt: string | null;
}

/** What the console may see about the SMTP setup — never the password. */
export interface MailStatus {
  /** Enabled *and* usable (host + sender address present). */
  configured: boolean;
  enabled: boolean;
  host: string;
  port: number;
  security: MailSecurity;
  username: string;
  fromName: string;
  fromEmail: string;
  replyTo: string;
  verifyCertificate: boolean;
  /** True when a password is on file — the console shows "leave blank to keep". */
  hasPassword: boolean;
  updatedAt: string | null;
}

export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * When a schedule emails the outcome of a firing:
 *  - `never`   — silent; notifications stay off (the default for a new schedule);
 *  - `failure` — only runs that failed or were cancelled (the "tell me when it breaks" case);
 *  - `success` — only runs that completed;
 *  - `always`  — every firing, whatever the outcome.
 */
export type ScheduleNotifyOn = 'never' | 'failure' | 'success' | 'always';

export type RunStepKind = 'llm' | 'tool_call' | 'tool_result' | 'delegate' | 'note';

export interface RunStep {
  index: number;
  kind: RunStepKind;
  toolName?: string;
  args?: unknown;
  result?: string;
  error?: string;
  note?: string;
  durationMs?: number;
  at: string;
}

export interface Run {
  id: string;
  agentId: string;
  /** Account that opened the session; null for runs stored before accounts. */
  createdBy: string | null;
  title: string;
  status: RunStatus;
  messages: ChatMessage[];
  steps: RunStep[];
  output: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** Set when the run was fired by a schedule (see Schedule); null otherwise. */
  scheduleId?: string | null;
}

/**
 * A recurring agent run: "every weekday at 09:00, send this task to that
 * agent". The schedule owns no session of its own — every firing opens a fresh
 * `Run` (titled after the task, tagged `scheduleId`), so the history reads as a
 * series of executions and long-term continuity lives in agent memory.
 */
export interface Schedule {
  id: string;
  agentId: string;
  /** Label shown in the console; falls back to the agent's name when empty. */
  name: string;
  /** The task handed to the agent on every firing. */
  input: string;
  /** Five-field cron, evaluated in the server's local time zone. */
  cron: string;
  enabled: boolean;
  /** Account that created it; null for schedules stored before accounts. */
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  /** Precomputed by the scheduler so the console can show it directly. */
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunId: string | null;
  lastStatus: RunStatus | null;
  lastError: string | null;
  runCount: number;
  /** Consecutive failures; the scheduler pauses the schedule at the cap. */
  failures: number;
  /** Why the scheduler paused it (agent deleted, repeated failures). */
  pausedReason: string | null;
  /** When to email about a firing (see ScheduleNotifyOn). */
  notifyOn: ScheduleNotifyOn;
  /**
   * Extra recipients. The account that created the schedule is always notified
   * as well; this list only adds people (or overrides it when there is no
   * creator, e.g. a schedule stored before accounts existed).
   */
  notifyEmails: string[];
  /** When the last notification was handed to the relay. */
  lastNotifyAt: string | null;
  /** Why the last notification could not be sent (null = it went out, or none was due). */
  lastNotifyError: string | null;
}

export interface GoogleToken {
  userId: string;
  email: string;
  name?: string;
  picture?: string;
  scopes: string[];
  accessToken: string;
  refreshToken: string | null;
  expiryDate: number;
  connectedAt: string;
}

export interface RunEvent {
  type: 'start' | 'step' | 'message' | 'done' | 'error';
  runId: string;
  step?: RunStep;
  message?: ChatMessage;
  output?: string;
  error?: string;
}

export interface DatabaseShape {
  agents: AgentDef[];
  runs: Run[];
  /** Cron-style recurring runs (see Schedule). */
  schedules: Schedule[];
  /** Accounts and their live sessions (see auth.ts). */
  users: User[];
  sessions: Session[];
  settings: AppSettings;
  /**
   * Google credentials per scope group. The groups are separate OAuth grants
   * (Google refuses to combine YouTube scopes with Drive scopes in one
   * authorization request), so they hold separate refresh tokens.
   */
  googleTokens: { workspace: GoogleToken | null; youtube: GoogleToken | null };
  /** Legacy single-token field, migrated into googleTokens.workspace on load. */
  googleToken?: GoogleToken | null;
  /**
   * The SMTP relay used for scheduled-run notifications, entered by an admin on
   * the Settings page. Holds a credential, so `db.json` deserves the same care
   * as the Google refresh token.
   */
  mail: MailSettings;
  /** Per-agent long-term memory: agentId -> key -> value */
  agentMemory: Record<string, Record<string, string>>;
}
