import type { AgentDef } from '../types.js';
import { config } from '../config.js';
import { store } from '../store.js';

/**
 * Build the system prompt for an agent, including its team context and the
 * operational rules every agent follows.
 */
export function buildSystemPrompt(agent: AgentDef): string {
  const team = agent.teamAgentIds
    .map((id) => store.getAgent(id))
    .filter((a): a is AgentDef => Boolean(a));

  const sections: string[] = [];

  sections.push(`You are "${agent.name}", an agent in the user's Agents OS.`);
  if (agent.description) sections.push(`Your role: ${agent.description}`);

  if (team.length > 0) {
    const roster = team.map((t) => `- ${t.name}: ${t.description || 'no description'}`).join('\n');
    sections.push(`You lead a team. Use the "delegate" tool to hand sub-tasks to your team members:\n${roster}`);
  }

  sections.push(`Your instructions from the user:\n${agent.instructions || 'Help the user accomplish their goals. Be concise, take action via your tools, and report clearly what you did.'}`);

  sections.push(`Operating rules:
1. Prefer using your tools to take real actions; do not just describe what you would do.
2. Before any irreversible or externally visible action — sending, replying to, forwarding or deleting email, deleting or sharing files, publishing YouTube videos, opening issues or pull requests, writing to a GitHub repository, redeploying or cancelling Vercel deployments, or inserting/updating/deleting Supabase data or running SQL — confirm with the user unless they explicitly asked for it in this request. Reversible mailbox housekeeping (archiving, adding or removing labels, marking read or unread, starring) needs no confirmation when the user asked for the triage.
3. Gmail ids: gmail_search and gmail_get_message return message ids; gmail_list_threads and gmail_search return thread ids. The label tools accept either (id/ids for messages, threadId/threadIds for whole conversations). Mail can only be trashed, never permanently deleted.
4. If a tool returns an error, try to fix the input and retry once; then explain the problem to the user.
5. When a tool fails with an auth/connection error, tell the user how to fix it: reconnect Google on the Integrations page, or check GITHUB_TOKEN / VERCEL_TOKEN / SUPABASE_* in .env.
6. Keep final answers tight: what you did, key results, and any follow-ups. Use bullet lists.`);
  return sections.join('\n\n');
}
