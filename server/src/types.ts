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

export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

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
  /** Per-agent long-term memory: agentId -> key -> value */
  agentMemory: Record<string, Record<string, string>>;
}
