import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config, type ScopeGroup } from './config.js';
import type {
  AgentDef, AppSettings, DatabaseShape, GoogleToken, Run, Schedule, Session, User, UserRole,
} from './types.js';

const DEFAULT_SETTINGS: AppSettings = {
  signupsEnabled: true,
  allowedSignupDomains: [],
  sessionDays: 30,
  runHistoryLimit: 200,
};

/** Coerce whatever was stored (or posted) into a usable settings object. */
export function normalizeSettings(input: Partial<AppSettings> | undefined): AppSettings {
  const raw = input ?? {};
  const domains = Array.isArray(raw.allowedSignupDomains) ? raw.allowedSignupDomains : [];
  return {
    signupsEnabled: raw.signupsEnabled !== false,
    allowedSignupDomains: [...new Set(
      domains
        .map((d) => String(d).trim().toLowerCase().replace(/^@/, ''))
        .filter(Boolean),
    )].slice(0, 50),
    sessionDays: clamp(Math.round(Number(raw.sessionDays) || DEFAULT_SETTINGS.sessionDays), 1, 365),
    runHistoryLimit: clamp(Math.round(Number(raw.runHistoryLimit) || DEFAULT_SETTINGS.runHistoryLimit), 10, 5000),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

const RUN_STATUSES = new Set(['running', 'completed', 'failed', 'cancelled']);

/**
 * Coerce a stored schedule into a complete record. `db.json` is hand-editable,
 * and a half-filled schedule would otherwise reach an engine that runs
 * unattended — so every field is guaranteed to exist here.
 */
export function normalizeSchedule(input: Partial<Schedule>): Schedule {
  const now = new Date().toISOString();
  const createdAt = typeof input.createdAt === 'string' && input.createdAt ? input.createdAt : now;
  const count = (value: unknown): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
  };
  return {
    id: typeof input.id === 'string' && input.id ? input.id : randomUUID(),
    agentId: String(input.agentId ?? ''),
    name: String(input.name ?? ''),
    input: String(input.input ?? ''),
    cron: String(input.cron ?? ''),
    enabled: input.enabled !== false,
    createdBy: input.createdBy ?? null,
    createdAt,
    updatedAt: typeof input.updatedAt === 'string' && input.updatedAt ? input.updatedAt : createdAt,
    nextRunAt: input.nextRunAt ?? null,
    lastRunAt: input.lastRunAt ?? null,
    lastRunId: input.lastRunId ?? null,
    lastStatus: RUN_STATUSES.has(String(input.lastStatus)) ? input.lastStatus! : null,
    lastError: input.lastError ?? null,
    runCount: count(input.runCount),
    failures: count(input.failures),
    pausedReason: input.pausedReason ?? null,
  };
}

/**
 * Simple durable JSON-file store. Good enough for a self-hosted single-user
 * Agents OS and keeps the project free of native dependencies.
 * Writes are atomic (tmp file + rename) and debounced.
 */
export class Store {
  private readonly filePath: string;
  private data: DatabaseShape;
  private saveTimer: NodeJS.Timeout | null = null;
  private saving: Promise<void> = Promise.resolve();

  constructor() {
    this.filePath = path.join(config.dataDir, 'db.json');
    this.data = this.load();
  }

  private load(): DatabaseShape {
    const empty: DatabaseShape = {
      agents: [],
      runs: [],
      schedules: [],
      users: [],
      sessions: [],
      settings: { ...DEFAULT_SETTINGS },
      googleTokens: { workspace: null, youtube: null },
      agentMemory: {},
    };
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<DatabaseShape> & { googleToken?: GoogleToken | null };
      const stored = parsed.googleTokens;
      const sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
      const now = Date.now();
      return {
        agents: Array.isArray(parsed.agents) ? parsed.agents : [],
        runs: Array.isArray(parsed.runs) ? parsed.runs : [],
        // Schedules are normalized on read: the file is hand-editable, and the
        // scheduler must not meet a half-filled record at 3am.
        schedules: (Array.isArray(parsed.schedules) ? parsed.schedules : []).map(normalizeSchedule),
        users: Array.isArray(parsed.users) ? parsed.users : [],
        // Expired sessions are dropped on load instead of lingering in the file.
        sessions: sessions.filter((s) => Date.parse(s.expiresAt) > now),
        settings: normalizeSettings(parsed.settings),
        // Migrate a legacy single token into the workspace group.
        googleTokens: {
          workspace: stored?.workspace ?? parsed.googleToken ?? null,
          youtube: stored?.youtube ?? null,
        },
        agentMemory: parsed.agentMemory && typeof parsed.agentMemory === 'object' ? parsed.agentMemory : {},
      };
    } catch {
      return empty;
    }
  }

  /** Schedule a save; coalesces rapid updates. */
  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saving = this.saveNow();
    }, 120);
  }

  private saveNow(): Promise<void> {
    const tmp = `${this.filePath}.tmp`;
    const json = JSON.stringify(this.data, null, 2);
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(tmp, json, 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.error('[store] save failed:', err);
    }
    return Promise.resolve();
  }

  /** Flush pending writes (used before process exit). */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.saving;
    await this.saveNow();
  }

  // ── Agents ────────────────────────────────────────────────────────────

  listAgents(): AgentDef[] {
    return [...this.data.agents].sort((a, b) => a.name.localeCompare(b.name));
  }

  getAgent(id: string): AgentDef | undefined {
    return this.data.agents.find((a) => a.id === id);
  }

  createAgent(input: Omit<AgentDef, 'id' | 'createdAt' | 'updatedAt'>): AgentDef {
    const now = new Date().toISOString();
    const agent: AgentDef = { ...input, id: randomUUID(), createdAt: now, updatedAt: now };
    this.data.agents.push(agent);
    this.scheduleSave();
    return agent;
  }

  updateAgent(id: string, patch: Partial<Omit<AgentDef, 'id' | 'createdAt'>>): AgentDef | undefined {
    const agent = this.getAgent(id);
    if (!agent) return undefined;
    Object.assign(agent, patch, { id: agent.id, createdAt: agent.createdAt, updatedAt: new Date().toISOString() });
    this.scheduleSave();
    return agent;
  }

  deleteAgent(id: string): boolean {
    const before = this.data.agents.length;
    this.data.agents = this.data.agents.filter((a) => a.id !== id);
    if (this.data.agents.length === before) return false;
    // Schedules without their agent could only ever fail, so they go with it.
    this.data.schedules = this.data.schedules.filter((s) => s.agentId !== id);
    this.scheduleSave();
    return true;
  }

  // ── Schedules ─────────────────────────────────────────────────────────

  listSchedules(): Schedule[] {
    return [...this.data.schedules].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getSchedule(id: string): Schedule | undefined {
    return this.data.schedules.find((s) => s.id === id);
  }

  /** Enabled schedules, soonest first — the order the engine works through. */
  listDueSchedules(now: Date = new Date()): Schedule[] {
    const at = now.getTime();
    return this.data.schedules
      .filter((s) => s.enabled && s.nextRunAt !== null && Date.parse(s.nextRunAt) <= at)
      .sort((a, b) => String(a.nextRunAt).localeCompare(String(b.nextRunAt)));
  }

  createSchedule(input: Omit<Schedule, 'id' | 'createdAt' | 'updatedAt'>): Schedule {
    const now = new Date().toISOString();
    const schedule: Schedule = normalizeSchedule({ ...input, createdAt: now, updatedAt: now });
    this.data.schedules.push(schedule);
    this.scheduleSave();
    return schedule;
  }

  updateSchedule(id: string, patch: Partial<Omit<Schedule, 'id' | 'createdAt'>>): Schedule | undefined {
    const schedule = this.getSchedule(id);
    if (!schedule) return undefined;
    Object.assign(schedule, patch, {
      id: schedule.id,
      createdAt: schedule.createdAt,
      updatedAt: new Date().toISOString(),
    });
    this.scheduleSave();
    return schedule;
  }

  deleteSchedule(id: string): boolean {
    const before = this.data.schedules.length;
    this.data.schedules = this.data.schedules.filter((s) => s.id !== id);
    if (this.data.schedules.length === before) return false;
    this.scheduleSave();
    return true;
  }

  // ── Runs ──────────────────────────────────────────────────────────────

  createRun(
    agentId: string,
    title: string,
    createdBy: string | null = null,
    scheduleId: string | null = null,
  ): Run {
    const run: Run = {
      id: randomUUID(),
      agentId,
      createdBy,
      title,
      status: 'running',
      messages: [],
      steps: [],
      output: null,
      error: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      scheduleId,
    };
    this.data.runs.push(run);
    this.scheduleSave();
    return run;
  }

  updateRun(id: string, patch: Partial<Omit<Run, 'id'>>): Run | undefined {
    const run = this.getRun(id);
    if (!run) return undefined;
    Object.assign(run, patch);
    this.scheduleSave();
    return run;
  }

  getRun(id: string): Run | undefined {
    return this.data.runs.find((r) => r.id === id);
  }

  listRuns(limit = 50): Run[] {
    return [...this.data.runs]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit);
  }

  pruneRuns(keep = 200): void {
    if (this.data.runs.length <= keep) return;
    const sorted = [...this.data.runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const keepIds = new Set(sorted.slice(0, keep).map((r) => r.id));
    this.data.runs = this.data.runs.filter((r) => keepIds.has(r.id));
    this.scheduleSave();
  }

  /** Remove one run from history. False when it is already gone. */
  deleteRun(id: string): boolean {
    const before = this.data.runs.length;
    this.data.runs = this.data.runs.filter((r) => r.id !== id);
    if (this.data.runs.length === before) return false;
    this.scheduleSave();
    return true;
  }

  /**
   * Close runs that were still marked `running` when the process stopped.
   * Nothing survives a restart, so a boot is exactly when they became stale —
   * without this a scheduled run killed by a restart would sit "Running" in
   * the history forever.
   */
  failInterruptedRuns(reason = 'Interrupted by a server restart.'): number {
    let closed = 0;
    const finishedAt = new Date().toISOString();
    for (const run of this.data.runs) {
      if (run.status !== 'running') continue;
      run.status = 'failed';
      run.error = run.error ?? reason;
      run.finishedAt = run.finishedAt ?? finishedAt;
      closed++;
    }
    if (closed > 0) this.scheduleSave();
    return closed;
  }

  // ── Accounts, sessions & settings ─────────────────────────────────────

  /** Oldest account first: the first one created is the instance admin. */
  listUsers(): User[] {
    return [...this.data.users].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getUser(id: string): User | undefined {
    return this.data.users.find((u) => u.id === id);
  }

  findUserByEmail(email: string): User | undefined {
    const wanted = email.trim().toLowerCase();
    return this.data.users.find((u) => u.email === wanted);
  }

  countUsers(): number {
    return this.data.users.length;
  }

  createUser(input: { email: string; name: string; role: UserRole; passwordHash: string }): User {
    const user: User = {
      id: randomUUID(),
      email: input.email.trim().toLowerCase(),
      name: input.name.trim(),
      role: input.role,
      passwordHash: input.passwordHash,
      createdAt: new Date().toISOString(),
      lastLoginAt: null,
    };
    this.data.users.push(user);
    this.scheduleSave();
    return user;
  }

  updateUser(id: string, patch: Partial<Omit<User, 'id' | 'createdAt'>>): User | undefined {
    const user = this.getUser(id);
    if (!user) return undefined;
    Object.assign(user, patch, { id: user.id, createdAt: user.createdAt });
    this.scheduleSave();
    return user;
  }

  /** Removes the account together with every session it owns. */
  deleteUser(id: string): boolean {
    const before = this.data.users.length;
    this.data.users = this.data.users.filter((u) => u.id !== id);
    if (this.data.users.length === before) return false;
    this.data.sessions = this.data.sessions.filter((s) => s.userId !== id);
    this.scheduleSave();
    return true;
  }

  createSession(userId: string, tokenHash: string, expiresAt: string): Session {
    const now = new Date().toISOString();
    const session: Session = {
      id: randomUUID(), userId, tokenHash, createdAt: now, expiresAt, lastUsedAt: now,
    };
    this.data.sessions.push(session);
    this.scheduleSave();
    return session;
  }

  /**
   * Resolve a cookie token to its account, dropping the session as soon as it
   * has expired. `lastUsedAt` is only rewritten when it is already stale, so a
   * busy console does not rewrite the database on every request.
   */
  findUserBySession(tokenHash: string, now: Date = new Date()): User | undefined {
    const session = this.data.sessions.find((s) => s.tokenHash === tokenHash);
    if (!session) return undefined;
    if (Date.parse(session.expiresAt) <= now.getTime()) {
      this.deleteSession(tokenHash);
      return undefined;
    }
    if (now.getTime() - Date.parse(session.lastUsedAt) > 3_600_000) {
      session.lastUsedAt = now.toISOString();
      this.scheduleSave();
    }
    return this.getUser(session.userId);
  }

  deleteSession(tokenHash: string): boolean {
    const before = this.data.sessions.length;
    this.data.sessions = this.data.sessions.filter((s) => s.tokenHash !== tokenHash);
    if (this.data.sessions.length === before) return false;
    this.scheduleSave();
    return true;
  }

  /** Sign a user out everywhere (used after a password change). */
  deleteUserSessions(userId: string, exceptTokenHash?: string): number {
    const before = this.data.sessions.length;
    this.data.sessions = this.data.sessions.filter(
      (s) => s.userId !== userId || (exceptTokenHash !== undefined && s.tokenHash === exceptTokenHash),
    );
    const removed = before - this.data.sessions.length;
    if (removed > 0) this.scheduleSave();
    return removed;
  }

  countSessions(): number {
    const now = Date.now();
    return this.data.sessions.filter((s) => Date.parse(s.expiresAt) > now).length;
  }

  getSettings(): AppSettings {
    return { ...this.data.settings };
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    this.data.settings = normalizeSettings({ ...this.data.settings, ...patch });
    this.scheduleSave();
    return this.getSettings();
  }

  // ── Google tokens (one per scope group) ───────────────────────────────

  getGoogleToken(group: ScopeGroup): GoogleToken | null {
    return this.data.googleTokens[group] ?? null;
  }

  setGoogleToken(group: ScopeGroup, token: GoogleToken): void {
    this.data.googleTokens[group] = token;
    this.scheduleSave();
  }

  listGoogleTokens(): { workspace: GoogleToken | null; youtube: GoogleToken | null } {
    return { ...this.data.googleTokens };
  }

  clearGoogleTokens(): void {
    this.data.googleTokens = { workspace: null, youtube: null };
    this.scheduleSave();
  }

  // ── Agent memory ──────────────────────────────────────────────────────

  getAgentMemory(agentId: string, key: string): string | null {
    return this.data.agentMemory[agentId]?.[key] ?? null;
  }

  setAgentMemory(agentId: string, key: string, value: string): void {
    this.data.agentMemory[agentId] ??= {};
    this.data.agentMemory[agentId][key] = value;
    this.scheduleSave();
  }

  deleteAgentMemory(agentId: string, key: string): void {
    if (this.data.agentMemory[agentId]) {
      delete this.data.agentMemory[agentId][key];
      this.scheduleSave();
    }
  }

  listAgentMemory(agentId: string): Record<string, string> {
    return { ...(this.data.agentMemory[agentId] ?? {}) };
  }
}

export const store = new Store();
