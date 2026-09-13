export interface AgentDef {
  id: string;
  name: string;
  description: string;
  instructions: string;
  model: string;
  enabledTools: string[];
  teamAgentIds: string[];
  color: string;
  createdAt: string;
  updatedAt: string;
}

/* ── Accounts & access ─────────────────────────────────────────────────── */

export type UserRole = 'admin' | 'member';

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  createdAt: string;
  lastLoginAt: string | null;
}

/** What the login screen needs before anyone is signed in. */
export interface AuthState {
  authenticated: boolean;
  user: PublicUser | null;
  signupsEnabled: boolean;
  /** True until the instance has its first account (which becomes the admin). */
  needsSetup: boolean;
  canSignup: boolean;
  allowedSignupDomains: string[];
  sessionDays: number;
}

export interface AppSettings {
  signupsEnabled: boolean;
  allowedSignupDomains: string[];
  sessionDays: number;
  runHistoryLimit: number;
}

/* ── Outgoing mail (SMTP) ──────────────────────────────────────────────── */

export type MailSecurity = 'starttls' | 'tls' | 'none';

/** The SMTP relay, as the console may see it — never the password itself. */
export interface MailStatus {
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
  /** True when a password is on file; the field is then left blank to keep it. */
  hasPassword: boolean;
  updatedAt: string | null;
}

/** What the Settings form posts. `password` absent = leave the stored one. */
export interface MailInput {
  enabled?: boolean;
  host?: string;
  port?: number;
  security?: MailSecurity;
  username?: string;
  password?: string;
  fromName?: string;
  fromEmail?: string;
  replyTo?: string;
  verifyCertificate?: boolean;
}

export interface AdminStats {
  users: number;
  admins: number;
  sessions: number;
}

export interface ToolInfo {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  requiresGoogle: boolean;
  requiresGithub: boolean;
  requiresVercel: boolean;
  requiresSupabase: boolean;
  isTeam: boolean;
}

export interface GoogleStatus {
  configured: boolean;
  connected: boolean;
  email: string | null;
  name: string | null;
  picture: string | null;
  scopes: string[];
  groups: {
    workspace: { connected: boolean; scopes: string[]; email: string | null };
    youtube: { connected: boolean; scopes: string[]; email: string | null };
  };
  connectedAt: string | null;
}

export interface GithubStatus {
  configured: boolean;
  tokenHint: string | null;
}

export interface VercelStatus {
  configured: boolean;
  tokenHint: string | null;
  teamId: string | null;
}

export interface SupabaseStatus {
  configured: boolean;
  projectRef: string | null;
  url: string | null;
  managementConfigured: boolean;
}

export interface PublicConfig {
  llm: { configured: boolean; mock: boolean; model: string; baseUrl: string };
  google: GoogleStatus;
  github: GithubStatus;
  vercel: VercelStatus;
  supabase: SupabaseStatus;
  tools: ToolInfo[];
  defaults: { maxSteps: number };
  /** Whether scheduled runs can be reported by email, and from where. */
  mail: MailConfigInfo;
  /** The schedule engine's knobs, so the console can warn when it is off. */
  scheduler: SchedulerInfo;
}

export interface MailConfigInfo {
  /** A relay is switched on, has a host and a sender address. */
  configured: boolean;
  /** The sender address notifications come from. */
  from: string | null;
}

export interface SchedulerInfo {
  enabled: boolean;
  tickSeconds: number;
  maxConcurrency: number;
  maxFailures: number;
}

/* ── Scheduled runs ────────────────────────────────────────────────────── */

export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * When a schedule emails the outcome of a firing: never, only on failure, only
 * on success, or on every run.
 */
export type ScheduleNotifyOn = 'never' | 'failure' | 'success' | 'always';

export const NOTIFY_MODES: ScheduleNotifyOn[] = ['never', 'failure', 'success', 'always'];

export const NOTIFY_LABELS: Record<ScheduleNotifyOn, string> = {
  never: 'Never',
  failure: 'On failure',
  success: 'On success',
  always: 'Every run',
};

/** One-line description of each mode, shown under the picker. */
export const NOTIFY_NOTES: Record<ScheduleNotifyOn, string> = {
  never: 'Silent — the run is only recorded in the history.',
  failure: 'Email when a run fails or is cut short. The one you want on an unattended schedule.',
  success: 'Email only when a run completes.',
  always: 'Email after every run, whatever the outcome.',
};

/** A cron-style recurring run, as the console sees it. */
export interface Schedule {
  id: string;
  agentId: string;
  name: string;
  input: string;
  cron: string;
  enabled: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunId: string | null;
  lastStatus: RunStatus | null;
  lastError: string | null;
  runCount: number;
  failures: number;
  pausedReason: string | null;
  /** When this schedule emails its outcome. */
  notifyOn: ScheduleNotifyOn;
  /** Extra recipients; the account that created it is always included. */
  notifyEmails: string[];
  lastNotifyAt: string | null;
  lastNotifyError: string | null;
  /* Joined by the server for display. */
  agentName: string;
  agentColor: string;
  label: string;
  description: string;
  createdByEmail: string | null;
  running: boolean;
  /** Everyone a notification would reach, creator included. */
  notifyRecipients: string[];
  /** Whether an SMTP relay is available at all right now. */
  mailConfigured: boolean;
}

export interface ScheduleInput {
  agentId?: string;
  name?: string;
  input?: string;
  cron?: string;
  enabled?: boolean;
  notifyOn?: ScheduleNotifyOn;
  notifyEmails?: string[];
}

export interface SchedulePreview {
  valid: boolean;
  error?: string;
  cron: string;
  description: string;
  /** The next few firing times (ISO), empty when the cadence is invalid. */
  next: string[];
}

export interface RunSummary {
  id: string;
  agentId: string;
  agentName: string;
  createdByEmail: string | null;
  title: string;
  status: RunStatus;
  output: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  steps: number;
  /** Set when a schedule fired this run. */
  scheduleId: string | null;
  scheduleName: string | null;
}

export interface RunStep {
  index: number;
  kind: 'llm' | 'tool_call' | 'tool_result' | 'delegate' | 'note';
  toolName?: string;
  args?: unknown;
  result?: string;
  error?: string;
  note?: string;
  durationMs?: number;
  at: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  toolCallId?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  reasoningContent?: string;
}

export interface RunDetail {
  id: string;
  agentId: string;
  title: string;
  status: RunStatus;
  messages: ChatMessage[];
  steps: RunStep[];
  output: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** Present when a schedule fired this run. */
  scheduleId?: string | null;
  scheduleName?: string | null;
}

export type RunEvent =
  | { type: 'start'; runId: string }
  | { type: 'step'; runId: string; step: RunStep }
  | { type: 'message'; runId: string; message: ChatMessage }
  | { type: 'done'; runId: string; output: string }
  | { type: 'error'; runId: string; error: string };
