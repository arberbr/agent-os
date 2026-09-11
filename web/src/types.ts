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
}

export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface RunSummary {
  id: string;
  agentId: string;
  agentName: string;
  title: string;
  status: RunStatus;
  output: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  steps: number;
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
}

export type RunEvent =
  | { type: 'start'; runId: string }
  | { type: 'step'; runId: string; step: RunStep }
  | { type: 'message'; runId: string; message: ChatMessage }
  | { type: 'done'; runId: string; output: string }
  | { type: 'error'; runId: string; error: string };
