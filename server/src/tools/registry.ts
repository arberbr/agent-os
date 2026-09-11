import type { Auth } from 'googleapis';
import type { ScopeGroup } from '../config.js';
import type { GithubClient } from '../github/client.js';
import type { SupabaseClient } from '../supabase/client.js';
import type { VercelClient } from '../vercel/client.js';
import type { RunStep } from '../types.js';

export interface ToolContext {
  agentId: string;
  runId: string;
  /**
   * Authenticated Google clients, one per scope group (null when that group has
   * not been connected). Google grants must be kept separate, so a tool uses
   * the client for the API family it calls.
   */
  googleAuth: Record<ScopeGroup, Auth.OAuth2Client | null>;
  /** Token-based service clients (null when not configured in .env). */
  github: GithubClient | null;
  vercel: VercelClient | null;
  supabase: SupabaseClient | null;
  /** Memory helpers. */
  memory: {
    get(key: string): string | null;
    set(key: string, value: string): void;
    keys(): string[];
  };
  /** Run another agent and return its final output. */
  delegate(agentId: string, task: string): Promise<string>;
  emitStep(step: RunStep): void;
  signal?: AbortSignal;
}

export interface Tool {
  name: string;
  description: string;
  /** JSON Schema for the tool arguments. */
  parameters: Record<string, unknown>;
  /** When true, the tool is only usable while Google is connected. */
  requiresGoogle?: boolean;
  /** When true, the tool needs GITHUB_TOKEN in .env. */
  requiresGithub?: boolean;
  /** When true, the tool needs VERCEL_TOKEN in .env. */
  requiresVercel?: boolean;
  /** When true, the tool needs SUPABASE_PROJECT_REF + SUPABASE_SERVICE_ROLE_KEY in .env. */
  requiresSupabase?: boolean;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}

const registry = new Map<string, Tool>();

export function registerTool(tool: Tool): void {
  if (registry.has(tool.name)) throw new Error(`Tool "${tool.name}" registered twice.`);
  registry.set(tool.name, tool);
}

export function getTool(name: string): Tool | undefined {
  return registry.get(name);
}

export function listTools(): Tool[] {
  return [...registry.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function toolToLLMSpec(tool: Tool): { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } } {
  return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } };
}
