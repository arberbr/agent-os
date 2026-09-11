import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config, type ScopeGroup } from './config.js';
import type { AgentDef, DatabaseShape, GoogleToken, Run } from './types.js';

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
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<DatabaseShape> & { googleToken?: GoogleToken | null };
      const stored = parsed.googleTokens;
      return {
        agents: Array.isArray(parsed.agents) ? parsed.agents : [],
        runs: Array.isArray(parsed.runs) ? parsed.runs : [],
        // Migrate a legacy single token into the workspace group.
        googleTokens: {
          workspace: stored?.workspace ?? parsed.googleToken ?? null,
          youtube: stored?.youtube ?? null,
        },
        agentMemory: parsed.agentMemory && typeof parsed.agentMemory === 'object' ? parsed.agentMemory : {},
      };
    } catch {
      return { agents: [], runs: [], googleTokens: { workspace: null, youtube: null }, agentMemory: {} };
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
    if (this.data.agents.length !== before) {
      this.scheduleSave();
      return true;
    }
    return false;
  }

  // ── Runs ──────────────────────────────────────────────────────────────

  createRun(agentId: string, title: string): Run {
    const run: Run = {
      id: randomUUID(),
      agentId,
      title,
      status: 'running',
      messages: [],
      steps: [],
      output: null,
      error: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
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
