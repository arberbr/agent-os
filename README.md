# Agents OS

> A self-hosted **Agents OS** — create AI agents, compose them into **teams**, and let them do real work across your **Google services** (Gmail, Calendar, Drive, YouTube), **GitHub**, **Vercel** and **Supabase**.

Agents OS is a small, dependency-light platform (TypeScript, Node + React, JSON-file storage) with a provider-agnostic agent runtime: any OpenAI-compatible LLM endpoint works (OpenAI, DeepSeek, **Gemini**, OpenRouter, local vLLM…).

## Features

- **Create agents** — persona, system instructions, model override, color, and a per-agent **tool picker** (45+ tools).
- **Compose teams** — an agent can **delegate** sub-tasks to other agents (`delegate` tool), with cycle protection, context isolation, and result reports flowing back to the lead.
- **Google integration** — one OAuth consent unlocks:
  - **Gmail**: search (full Gmail query syntax), read messages, send mail, create drafts, delete (move to Trash) and restore emails
  - **Calendar**: list/create/update/delete events, find free time slots
  - **Drive**: list/search files, create **Markdown-formatted Google Docs** (headings, bold/italic, links, lists, blockquotes, code blocks), **append** to existing Docs, create Sheets (CSV or rows), **read Sheets as rows**, upload/download files, share
  - **YouTube**: search videos, get video stats, list your channel's videos, upload videos (from Drive or base64)
- **GitHub integration** — a personal access token unlocks repos, issues, pull requests and file read/write:
  - Search repos across GitHub, list repos the token can see
  - List/get/create issues, comment on issues and PRs
  - List/get/create pull requests
  - Read files (text or base64) and commit new/updated files to a branch
- **Vercel integration** — an access token unlocks your projects and deployments:
  - List/get projects (framework, git source, env var keys, production alias)
  - List/get deployments, **redeploy** from the same source, cancel running deployments
  - List domains, inspect project env vars (secret values only when explicitly requested)
- **Supabase integration** — project ref + service_role key unlock the data plane:
  - Query/insert/update/delete table rows with full **PostgREST** syntax (filters, ordering, limits)
  - Run SQL and list tables (needs the optional management-API token)
  - Upload files to Storage buckets, create auth users via the admin API
- **Live run view** — chat with an agent while a real-time **activity rail** streams every LLM step, tool call, argument and result (SSE).
- **Run history** — every run persisted (messages, steps, output) and inspectable.
- **Guardrails** — max steps per run, tool-result truncation, 3-strikes tool-failure abort, cancellation, and confirm-before-destructive-action instructions baked into every system prompt.
- **Persistent agent memory** — `memory_set` / `memory_get` tools survive across runs.

## Quickstart

```bash
# 1. install
pnpm install

# 2. configure (see below)
cp .env.example .env   # then edit

# 3. run (server on :8787, web UI on :5173)
pnpm dev
```

Open **http://localhost:5173**.

### Production-style single process

```bash
pnpm build      # builds web/dist (esbuild) + server/dist (tsc)
pnpm start      # server on :8787 also serves the built UI → http://localhost:8787
```

(`pnpm build:vite` in web/ is an optional Vite-based alternative bundler.)

## Configuration (`.env`)

| Variable | Meaning |
| --- | --- |
| `PORT` / `PUBLIC_URL` | Server port and its public origin (used for the OAuth redirect). |
| `LLM_BASE_URL` | OpenAI-compatible base. Default: `https://api.deepseek.com/v1`. Also works with `https://api.openai.com/v1`, `https://generativelanguage.googleapis.com/v1beta/openai` (Gemini), `https://openrouter.ai/api/v1`, local vLLM… |
| `LLM_API_KEY` | API key for the endpoint (get one at [platform.deepseek.com](https://platform.deepseek.com)). |
| `LLM_MODEL` | Default model (agents can override per agent). Default: `deepseek-v4-pro`; `deepseek-v4-flash` is the cheaper/faster tier. |
| `LLM_THINKING_MODE` | DeepSeek V4 only: `enabled` / `disabled` / empty (API default). Thinking mode adds a reasoning trace and improves tool-use reliability. |
| `LLM_REASONING_EFFORT` | With thinking enabled: `high` (default) or `max`. |
| `LLM_PROVIDER=mock` | Optional offline mock brain (no key needed) — useful for smoke tests/demos. |
| `AGENT_MAX_STEPS` | Max tool-calling iterations per run (default 12). |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth client credentials (see below). |
| `GOOGLE_SCOPES_WORKSPACE` | Scopes for Gmail + Calendar + Drive (default: `calendar.events`, `gmail.modify`, `drive.file`, `documents`, `spreadsheets`). |
| `GOOGLE_SCOPES_YOUTUBE` | Scopes for YouTube (default: `youtube.readonly`, `youtube.upload`). Granted in a **separate** consent step — see below. |
| `GITHUB_TOKEN` | GitHub personal access token (classic `repo` scope, or fine-grained Contents/Issues/Pull-requests read-write). |
| `VERCEL_TOKEN` | Vercel access token (`Full Account` scope) — `VERCEL_TEAM_ID` optional for team-scoped tokens. |
| `SUPABASE_PROJECT_REF` / `SUPABASE_SERVICE_ROLE_KEY` | Project ref (the `xxx` in `https://xxx.supabase.co`) + service_role key from Project Settings → API. |
| `SUPABASE_ACCESS_TOKEN` | Optional management-API token — needed only for `supabase_run_sql` / `supabase_list_tables`. |
| `DATA_DIR` | Where the JSON database lives (default `server/data`). |

### Google setup (10 minutes)

1. Go to [Google Cloud Console](https://console.cloud.google.com) → **APIs & Services → Library** and enable: **Gmail API, Google Calendar API, Google Drive API, Google Docs API, Google Sheets API, YouTube Data API v3**.
2. **APIs & Services → OAuth consent screen**: app name, your email, and add **yourself as a test user**. Keep the status in **Testing** — that's enough for personal use (note: refresh tokens expire after ~7 days in Testing mode; just re-connect).
3. **APIs & Services → Credentials → Create credentials → OAuth client ID → Web application**, then add the redirect URI:
   ```
   http://localhost:8787/api/google/callback
   ```
4. Paste the client id/secret into `.env`, restart, open **Integrations**.
5. Click **Connect** next to *Gmail · Calendar · Drive*, then **Connect** next to *YouTube* (two consent screens — see the note below).
6. Hit **Test all services** — each of Gmail/Calendar/Drive/YouTube is pinged live.

> **Why two consent steps?** Google rejects an authorization request that combines YouTube
> scopes with Drive scopes (`Error 400: invalid_request — This request contains scopes that
> cannot be requested together`), and with incremental authorization it validates the
> *merged* set, so previously granted Drive scopes would drag the YouTube request down with
> them. Agents OS therefore performs two **independent authorizations**, each stored as its
> own token; agents pick the right credentials per service. You can connect either group
> alone — skip YouTube if your agents don't need it (they'll simply have no YouTube tools).
>
> **Scope notes:** `gmail.modify` and `youtube.upload` are *restricted* scopes. In Testing
> mode they work for test users with an unverified-app warning. For public/multi-user use,
> Google requires app verification. If you don't need sending email, drop `gmail.modify`
> from `GOOGLE_SCOPES_WORKSPACE`; if you don't upload videos, drop `youtube.upload` from
> `GOOGLE_SCOPES_YOUTUBE`.
>
> **About `documents` and `spreadsheets`:** those two scopes power the Markdown-formatted
> Docs (create/append) and reading Sheet values. If you connected Google before they were
> added to the defaults, **reconnect the Gmail/Calendar/Drive group once** on the
> Integrations page. Until you do, `drive_create_doc` still works (plain text, with a
> note) and `drive_read_sheet` falls back to CSV export — only `drive_append_doc` and
> range-based sheet reads need the new grant.

### GitHub, Vercel and Supabase setup (5 minutes each)

These three use plain API tokens in `.env` — no OAuth consent, no redirect URIs:

1. **GitHub** — [github.com/settings/tokens](https://github.com/settings/tokens) → generate a token: a
   classic token with `repo` scope, or a fine-grained token with **Contents**, **Issues** and **Pull
   requests** read/write on the repos your agents should work on. Put it in `GITHUB_TOKEN`, restart, open
   **Integrations** and hit **Test connection**.
2. **Vercel** — [vercel.com/account/tokens](https://vercel.com/account/tokens) → create a token with the
   **Full Account** scope (teams: also set `VERCEL_TEAM_ID` to the team id). Put it in `VERCEL_TOKEN`.
3. **Supabase** — Dashboard → **Project Settings → API**: copy the **Project URL** ref (the `xxx` part) into
   `SUPABASE_PROJECT_REF` and the **service_role** key into `SUPABASE_SERVICE_ROLE_KEY`. The service role key
   bypasses row-level security — keep it on this machine. Optionally create a personal access token at
   [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens) for
   `SUPABASE_ACCESS_TOKEN` to unlock `supabase_run_sql` and `supabase_list_tables`.

Each panel on the Integrations page has a **Test connection** button that pings the service live and shows
which checks passed (identity, key validity, reachability).

## Creating your first team

1. **Agents → New agent.** Example members:
   - *Executive Assistant* — tools: Gmail + Calendar + memory. Instructions: triage inbox, protect calendar.
   - *Researcher* — tools: YouTube search, Drive, memory.
   - *Scribe* — tools: Drive (create docs/sheets).
   - *Release engineer* — tools: GitHub + Vercel + Supabase. Instructions: triage issues, open PRs for small fixes, redeploy when asked.
2. Edit *Executive Assistant*, open **Team** and check *Researcher* and *Scribe* — it now owns a `delegate` tool.
3. **Run** the lead agent: *"Research the 3 most-watched videos about AI agents this week, write a one-page brief as a Google Doc, then email me the link."*
   The lead delegates research → Researcher, document creation → Scribe, then emails you the link via Gmail.
   Or run the *Release engineer* alone: *"Check the open issues on my repo, fix the typo in README.md in a branch and open a PR, then redeploy the staging Vercel project."*

## Architecture

See **[docs/architecture.md](docs/architecture.md)** for the module map, data model, agent loop, delegation protocol and API reference, and **[docs/research/](docs/research/)** for the web analysis that informed the design:

- `docs/research/agent-os-landscape.md` — what AgentKit, Google ADK, LangGraph, CrewAI, AutoGen, Letta and others do well, and what we copied/avoided.
- `docs/research/google-integration.md` — 2026-state Google OAuth + API specifics with copy-paste TS snippets and quota notes.

## API overview

```
GET  /api/config                     public config, tool catalog, connection status
GET/POST /api/agents                 list / create agents
GET/PUT/DELETE /api/agents/:id
POST /api/agents/:id/run             run agent, SSE stream of live events
GET  /api/runs?limit=50              run history (summaries)
GET  /api/runs/:id                   full run (messages + steps)
GET  /api/google/auth-url            start OAuth consent
GET  /api/google/callback            OAuth callback (handled by server)
GET  /api/google/status              connection status
POST /api/google/disconnect          revoke + clear tokens
POST /api/google/test                live per-service self-test
GET  /api/github/status              token configured?
POST /api/github/test                live identity + repos check
GET  /api/vercel/status              token configured?
POST /api/vercel/test                live identity + projects check
GET  /api/supabase/status            project/key configured?
POST /api/supabase/test              live project + key checks
POST /api/llm/test                   ping the configured LLM
```

## Security notes

- Single-user by design. All data lives in a local JSON file (`server/data/db.json`), including the Google refresh token — protect the machine and file.
- Tokens refresh silently and are persisted on the `tokens` event; a revoked grant surfaces as a friendly "reconnect Google" error.
- GitHub, Vercel and Supabase credentials live only in `.env` and are never persisted to the database or sent to the LLM provider.
- The agent system prompt instructs agents to **confirm before** sending or deleting email, deleting events/files, sharing files, publishing YouTube videos, opening issues/PRs, writing to GitHub, redeploying/cancelling Vercel deployments, or changing Supabase data.
- No telemetry. Nothing leaves your machine except LLM API calls and the APIs you connected.

## Project layout

```
agent-os/
├── server/          # Node/Express + TypeScript — agent runtime, tools, integrations
│   └── src/
│       ├── agents/       # system prompts, tool-calling loop, delegation
│       ├── api/          # REST + SSE routes
│       ├── google/       # OAuth2 + gmail/calendar/drive/youtube modules
│       ├── github/       # REST client (repos, issues, pulls, contents)
│       ├── vercel/       # REST client (projects, deployments, domains, env)
│       ├── supabase/     # PostgREST + management + storage + auth admin
│       ├── llm/          # provider-agnostic chat-completions client
│       ├── tools/        # tool registry: builtin + 4 integration tool sets
│       └── store.ts      # JSON-file store (agents, runs, tokens, memory)
├── web/             # React + Vite UI — dashboard, editor, live run view, integrations
└── docs/            # architecture + web research
```

## Roadmap ideas

- Scheduler (cron-style recurring agent runs)
- Approval workflow (human confirms destructive tool calls in-UI)
- Web search / web-fetch tools for agents
- GitHub OAuth app flow as an alternative to `GITHUB_TOKEN`
- Vercel create-deployment (artifact upload) for non-git projects
- Multi-user accounts & per-user credentials
- Structured outputs + agent-visible artifacts panel
