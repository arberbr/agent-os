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
  title: string;
  status: RunStatus;
  messages: ChatMessage[];
  steps: RunStep[];
  output: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
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
