import { randomBytes } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import { config } from '../config.js';
import { store } from '../store.js';
import type { AgentDef, RunEvent } from '../types.js';
import { chatCompletion } from '../llm/openaiCompat.js';
import { listTools } from '../tools/index.js';
import { runAgent } from '../agents/runAgent.js';
import {
  buildAuthUrl, disconnectGoogle, googleStatus, handleAuthCode, isGoogleConfigured, getAuthedClient,
} from '../google/auth.js';
import { gmailSearch } from '../google/gmail.js';
import { calendarListEvents } from '../google/calendar.js';
import { driveListFiles } from '../google/drive.js';
import { youtubeListMyVideos } from '../google/youtube.js';
import {
  githubGetUser, githubListRepos, githubStatus, makeGithubClient,
} from '../github/client.js';
import {
  makeVercelClient, vercelGetUser, vercelListProjects, vercelStatus,
} from '../vercel/client.js';
import {
  makeSupabaseClient, supabaseAdminPing, supabaseHealth, supabaseProjectInfo, supabaseStatus,
} from '../supabase/client.js';

export function createApp(): express.Express {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  /**
   * Live run streams, so removing a session that is still running actually
   * stops the work instead of leaving an agent talking to a deleted record.
   */
  const activeRuns = new Map<string, AbortController>();

  // ── Health & public config ────────────────────────────────────────────

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
  });

  app.get('/api/config', (_req, res) => {
    const tools = listTools().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      requiresGoogle: t.requiresGoogle ?? false,
      requiresGithub: t.requiresGithub ?? false,
      requiresVercel: t.requiresVercel ?? false,
      requiresSupabase: t.requiresSupabase ?? false,
      isTeam: t.name === 'delegate',
    }));
    res.json({
      llm: {
        configured: Boolean(config.llmApiKey) || config.llmMock,
        mock: config.llmMock,
        model: config.llmModel,
        baseUrl: config.llmBaseUrl,
      },
      google: googleStatus(),
      github: githubStatus(),
      vercel: vercelStatus(),
      supabase: supabaseStatus(),
      tools,
      defaults: { maxSteps: config.agentMaxSteps },
    });
  });

  // ── Agents CRUD ───────────────────────────────────────────────────────

  const agentInput = (body: Record<string, unknown>): Omit<AgentDef, 'id' | 'createdAt' | 'updatedAt'> => {
    const name = String(body.name ?? '').trim();
    if (!name) throw new Error('Agent name is required.');
    return {
      name,
      description: String(body.description ?? '').trim(),
      instructions: String(body.instructions ?? '').trim(),
      model: String(body.model ?? '').trim(),
      enabledTools: Array.isArray(body.enabledTools) ? body.enabledTools.filter((t): t is string => typeof t === 'string') : [],
      teamAgentIds: Array.isArray(body.teamAgentIds) ? body.teamAgentIds.filter((t): t is string => typeof t === 'string') : [],
      color: String(body.color ?? '#6366f1').trim(),
    };
  };

  app.get('/api/agents', (_req, res) => {
    res.json(store.listAgents());
  });

  app.post('/api/agents', (req, res) => {
    try {
      const agent = store.createAgent(agentInput(req.body ?? {}));
      res.status(201).json(agent);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/agents/:id', (req, res) => {
    const agent = store.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found.' });
    res.json(agent);
  });

  app.put('/api/agents/:id', (req, res) => {
    try {
      const agent = store.updateAgent(req.params.id, agentInput(req.body ?? {}));
      if (!agent) return res.status(404).json({ error: 'Agent not found.' });
      res.json(agent);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete('/api/agents/:id', (req, res) => {
    const ok = store.deleteAgent(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Agent not found.' });
    res.status(204).end();
  });

  // ── Runs ──────────────────────────────────────────────────────────────

  app.get('/api/runs', (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
    res.json(store.listRuns(limit).map((r) => ({
      id: r.id,
      agentId: r.agentId,
      agentName: store.getAgent(r.agentId)?.name ?? 'deleted agent',
      title: r.title,
      status: r.status,
      output: r.output,
      error: r.error,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      steps: r.steps.length,
    })));
  });

  app.get('/api/runs/:id', (req, res) => {
    const run = store.getRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found.' });
    res.json(run);
  });

  /** Remove a session from the history. Aborts it first when it is live. */
  app.delete('/api/runs/:id', (req, res) => {
    activeRuns.get(req.params.id)?.abort();
    activeRuns.delete(req.params.id);
    const ok = store.deleteRun(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Run not found.' });
    res.status(204).end();
  });

  /** Start an agent run and stream progress + final output as SSE. */
  app.post('/api/agents/:id/run', async (req, res) => {
    const agent = store.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found.' });

    const input = String((req.body as { input?: unknown } | undefined)?.input ?? '').trim();
    if (!input) return res.status(400).json({ error: 'input is required.' });

    const run = store.createRun(agent.id, input.slice(0, 100));
    store.pruneRuns();

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const ac = new AbortController();
    activeRuns.set(run.id, ac);
    // NOTE: on Node >= 18, IncomingMessage 'close' fires when the request body
    // is consumed — not on disconnect. The response stream's 'close' is the
    // reliable client-disconnect signal for SSE.
    res.on('close', () => ac.abort());

    const send = (event: RunEvent): void => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    send({ type: 'start', runId: run.id });

    try {
      const result = await runAgent({
        agent,
        input,
        runId: run.id,
        signal: ac.signal,
        onEvent: (event) => {
          send(event);
          if (event.type === 'step') store.updateRun(run.id, { steps: [...(store.getRun(run.id)?.steps ?? []), event.step!] });
          if (event.type === 'message' && event.message) store.updateRun(run.id, { messages: [...(store.getRun(run.id)?.messages ?? []), event.message] });
        },
      });
      const cancelled = ac.signal.aborted;
      store.updateRun(run.id, {
        status: cancelled ? 'cancelled' : 'completed',
        messages: result.messages,
        steps: result.steps,
        output: cancelled ? null : result.output,
        finishedAt: new Date().toISOString(),
      });
      send({ type: 'done', runId: run.id, output: cancelled ? '' : result.output });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const cancelled = ac.signal.aborted;
      store.updateRun(run.id, {
        status: cancelled ? 'cancelled' : 'failed',
        error: message,
        finishedAt: new Date().toISOString(),
      });
      send({ type: 'error', runId: run.id, error: message });
    }
    activeRuns.delete(run.id);
    res.end();
  });

  // ── LLM ───────────────────────────────────────────────────────────────

  app.post('/api/llm/test', async (req, res) => {
    try {
      const prompt = String((req.body as { prompt?: unknown } | undefined)?.prompt ?? 'Reply with the single word: ok');
      const t0 = Date.now();
      const result = await chatCompletion({ messages: [{ role: 'user', content: prompt }] });
      res.json({ ok: true, model: config.llmModel, reply: result.message.content, ms: Date.now() - t0 });
    } catch (err) {
      res.status(502).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Google OAuth & status ─────────────────────────────────────────────

  app.get('/api/google/auth-url', (req, res) => {
    if (!isGoogleConfigured()) {
      return res.status(400).json({ error: 'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first.' });
    }
    // Google refuses to combine YouTube scopes with Drive/Workspace scopes in
    // one request, so consent is requested per group.
    const group = req.query.group === 'youtube' ? 'youtube' : 'workspace';
    const state = `${group}:${randomBytes(12).toString('hex')}`;
    res.redirect(buildAuthUrl(state, group));
  });

  app.get('/api/google/callback', async (req, res) => {
    const { code, error } = req.query as { code?: string; error?: string };
    const state = String((req.query as { state?: string }).state ?? '');
    const group = state.split(':')[0] === 'youtube' ? 'youtube' : 'workspace';
    const webOrigin = (process.env.WEB_ORIGIN ?? config.publicUrl).replace(/\/+$/, '');
    if (error) return res.redirect(`${webOrigin}/integrations?google=error&group=${group}&reason=${encodeURIComponent(error)}`);
    if (!code) return res.redirect(`${webOrigin}/integrations?google=error&group=${group}&reason=no_code`);
    try {
      await handleAuthCode(code, group);
      res.redirect(`${webOrigin}/integrations?google=connected&group=${group}`);
    } catch (err) {
      res.redirect(`${webOrigin}/integrations?google=error&group=${group}&reason=${encodeURIComponent(err instanceof Error ? err.message : String(err))}`);
    }
  });

  app.get('/api/google/status', (_req, res) => {
    res.json(googleStatus());
  });

  app.post('/api/google/disconnect', async (_req, res) => {
    await disconnectGoogle();
    res.json({ connected: false });
  });

  /** Verify each Google service with a lightweight live call. */
  app.post('/api/google/test', async (_req, res) => {
    const [workspace, youtube] = await Promise.all([
      getAuthedClient('workspace').catch(() => null),
      getAuthedClient('youtube').catch(() => null),
    ]);
    if (!workspace && !youtube) return res.status(400).json({ error: 'Google is not connected.' });

    const checks: Record<string, unknown> = {};
    const runCheck = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
      try {
        const sample = await fn();
        checks[name] = { ok: true, sample };
      } catch (err) {
        checks[name] = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    };
    const missing = (group: string) => () => Promise.reject(new Error(`Not connected — connect the ${group} group on the Integrations page.`));

    await runCheck('gmail', workspace ? () => gmailSearch(workspace, { maxResults: 1, query: 'in:inbox' }) : missing('Gmail/Calendar/Drive'));
    await runCheck('calendar', workspace ? () => calendarListEvents(workspace, { timeMin: new Date().toISOString(), maxResults: 1 }) : missing('Gmail/Calendar/Drive'));
    await runCheck('drive', workspace ? () => driveListFiles(workspace, { maxResults: 1 }) : missing('Gmail/Calendar/Drive'));
    await runCheck('youtube', youtube ? () => youtubeListMyVideos(youtube, { maxResults: 1 }) : missing('YouTube'));

    res.json({ connected: true, checks });
  });

  // ── GitHub (personal access token) ────────────────────────────────────

  app.get('/api/github/status', (_req, res) => {
    res.json(githubStatus());
  });

  /** Verify the GitHub token with live API calls. */
  app.post('/api/github/test', async (_req, res) => {
    const client = makeGithubClient();
    if (!client) return res.status(400).json({ error: 'GitHub is not configured. Set GITHUB_TOKEN in .env and restart.' });

    const checks: Record<string, unknown> = {};
    const runCheck = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
      try {
        const sample = await fn();
        checks[name] = { ok: true, sample };
      } catch (err) {
        checks[name] = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    };

    await runCheck('identity', () => githubGetUser(client));
    await runCheck('repos', () => githubListRepos(client, { perPage: 1 }));
    const identity = checks['identity'] as { ok: boolean } | undefined;

    res.json({ connected: identity?.ok ?? false, checks });
  });

  // ── Vercel (access token) ─────────────────────────────────────────────

  app.get('/api/vercel/status', (_req, res) => {
    res.json(vercelStatus());
  });

  /** Verify the Vercel token with live API calls. */
  app.post('/api/vercel/test', async (_req, res) => {
    const client = makeVercelClient();
    if (!client) return res.status(400).json({ error: 'Vercel is not configured. Set VERCEL_TOKEN in .env and restart.' });

    const checks: Record<string, unknown> = {};
    const runCheck = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
      try {
        const sample = await fn();
        checks[name] = { ok: true, sample };
      } catch (err) {
        checks[name] = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    };

    await runCheck('identity', () => vercelGetUser(client));
    await runCheck('projects', () => vercelListProjects(client, { limit: 1 }));
    const identity = checks['identity'] as { ok: boolean } | undefined;

    res.json({ connected: identity?.ok ?? false, checks });
  });

  // ── Supabase (service_role key + optional management token) ───────────

  app.get('/api/supabase/status', (_req, res) => {
    res.json(supabaseStatus());
  });

  /** Verify the Supabase project and keys with live API calls. */
  app.post('/api/supabase/test', async (_req, res) => {
    const client = makeSupabaseClient();
    if (!client) {
      return res.status(400).json({ error: 'Supabase is not configured. Set SUPABASE_PROJECT_REF and SUPABASE_SERVICE_ROLE_KEY in .env and restart.' });
    }

    const checks: Record<string, unknown> = {};
    const runCheck = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
      try {
        const sample = await fn();
        checks[name] = { ok: true, sample };
      } catch (err) {
        checks[name] = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    };

    await runCheck('project', () => supabaseHealth(client));
    await runCheck('service_role_key', () => supabaseAdminPing(client));
    if (client.accessToken) await runCheck('management_api', () => supabaseProjectInfo(client));

    const key = checks['service_role_key'] as { ok: boolean } | undefined;
    res.json({ connected: key?.ok ?? false, checks });
  });

  return app;
}
