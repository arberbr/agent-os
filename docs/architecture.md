# Agents OS — Architecture

This document describes how Agents OS is built. Design decisions were informed by the
web research in [`docs/research/agent-os-landscape.md`](research/agent-os-landscape.md)
and [`docs/research/google-integration.md`](research/google-integration.md).

## 1. Module map

```
┌────────────────────────── web (React + Vite, :5173) ──────────────────────────┐
│ Dashboard · Agents (list/editor) · Run view (chat + live activity rail)       │
│ Runs history · Integrations (Google OAuth + GitHub/Vercel/Supabase + tests)    │
└──────────────────────────────────┬─────────────────────────────────────────────┘
                                   │ REST + SSE (vite proxy /api → :8787)
┌──────────────────────────────────▼─────────────────────────────────────────────┐
│ server (Node + Express, :8787)                                                 │
│                                                                                │
│  api/app.ts          REST routes, SSE run stream, OAuth callback, self-tests   │
│  agents/runAgent.ts  tool-calling loop, delegation, guardrails                 │
│  agents/prompts.ts   system-prompt builder (persona + team roster + rules)     │
│  tools/registry.ts   tool registry: {name, description, JSON schema, execute}  │
│  tools/builtin.ts    now, memory_set, memory_get                               │
│  tools/googleTools.ts  gmail_* calendar_* drive_* youtube_* (23 tools)         │
│  tools/githubTools.ts  github_* repos/issues/pulls/contents (12 tools)         │
│  tools/vercelTools.ts  vercel_* projects/deployments/domains/env (8 tools)     │
│  tools/supabaseTools.ts  supabase_* rows/sql/storage/auth (8 tools)            │
│  llm/openaiCompat.ts provider-agnostic chat-completions (OpenAI/Gemini/DeepSeek)│
│  google/auth.ts      OAuth2: consent URL, code→token, silent refresh           │
│  google/{gmail,calendar,drive,youtube}.ts  thin wrappers over googleapis        │
│  github/client.ts    GitHub REST client (GITHUB_TOKEN from .env)               │
│  vercel/client.ts    Vercel REST client (VERCEL_TOKEN, optional team)          │
│  supabase/client.ts  PostgREST + management + storage + auth admin             │
│  store.ts            JSON-file store: agents, runs, google token, agent memory │
└──────────────────────────────────┬─────────────────────────────────────────────┘
                                   │
                    ┌──────────────┴───────────────┐
                    │ OpenAI-compatible LLM API    │  Google APIs (googleapis,
                    │ (any provider / mock mode)   │  OAuth2 user tokens)
│ GitHub · Vercel · Supabase   │  REST/PostgREST (fetch)
                    └──────────────────────────────┘
```

## 2. Data model

Everything persists to `server/data/db.json` (atomic writes: tmp file + rename, debounced 120 ms).
The database is single-user by design:

```ts
AgentDef {
  id, name, description, instructions,      // instructions = system prompt body
  model,                                    // '' → default LLM_MODEL
  enabledTools: string[],                   // tool names the agent may call
  teamAgentIds: string[],                   // agents this one can delegate to
  color, createdAt, updatedAt
}

Run {
  id, agentId, title, status,               // running | completed | failed | cancelled
  messages: ChatMessage[],                  // full transcript incl. tool messages
  steps: RunStep[],                         // append-only activity log (replay/UI)
  output, error, startedAt, finishedAt
}

RunStep {
  index, kind,                              // llm | tool_call | tool_result | delegate | note
  toolName?, args?, result?, error?, note?, durationMs?, at
}

GoogleToken { userId, email, name, picture, scopes, accessToken, refreshToken, expiryDate, connectedAt }
agentMemory: Record<agentId, Record<key, value>>   // long-term memory (memory_set/get)
```

## 3. Agent runtime — the tool-calling loop

```text
messages = [system(persona + team roster + operating rules)] + history + [user input]

for step in 1..AGENT_MAX_STEPS:
  emit(llm: "thinking")
  response = chatCompletion(messages, tools=agent's tools)
  append assistant message
  if no tool_calls: return content            # final answer
  for each tool_call:
    emit(tool_call with args)
    result = tool.execute(args, ctx)          # errors → "Tool error: …" as result
    emit(tool_result truncated)
    append tool message
    3 consecutive failures → abort with error

# step limit reached → one final no-tools call that summarizes state
```

Guardrails (per landscape research):

| Guardrail | Implementation |
| --- | --- |
| Step budget | `AGENT_MAX_STEPS` (default 12) |
| Context budget | tool results truncated to `TOOL_RESULT_MAX_CHARS` (8 000) |
| Failure circuit-breaker | 3 consecutive tool failures abort the run |
| Bad arguments | JSON parse errors surface as tool results instead of crashing |
| Cancellation | `AbortSignal` from the SSE client disconnect → `cancelled` status |
| Destructive actions | system-prompt rule: confirm before send/delete/share/publish |
| Unknown tool calls | answered with the available-tool list as a tool result |

## 4. Multi-agent orchestration — delegation as a tool

Teams follow the **handoff-as-tool** pattern (OpenAI Agents SDK style):

```
lead agent ──delegate(agentId, task)──▶ child agent runs its own loop
     ▲                                        │
     └────────── returns: "Sub-agent X finished. Its report: …" (≤6 000 chars)
```

- The `delegate` tool is registered on the runtime and is **auto-added** to any agent
  with `teamAgentIds`, so the lead can always reach its team.
- Child runs get a **fresh context** (own system prompt + the task brief) — no parent
  transcript bloat; the parent only receives the child's final report (compression at
  every boundary).
- **Cycle protection**: a `teamStack` of agent ids is threaded through runs; delegating
  to an agent already on the stack is refused with an explanatory message.
- Child steps bubble into the same SSE stream (visible in the activity rail as 👥
  `delegate` entries), so the user watches the whole team work live.

Depth is naturally bounded (delegation requires a team relationship), but a deep chain
is still capped by the shared per-run step count.

## 5. Live streaming (SSE)

`POST /api/agents/:id/run` responds with `text/event-stream`:

```
data: {"type":"start","runId":"…"}
data: {"type":"step","runId":"…","step":{"kind":"llm","note":"thinking (step 1/12)","at":"…"}}
data: {"type":"step", …, "step":{"kind":"tool_call","toolName":"gmail_search","args":{…}}}
data: {"type":"step", …, "step":{"kind":"tool_result","toolName":"gmail_search","result":"[…]"}}
data: {"type":"message", …, "message":{"role":"assistant","content":"…"}}
data: {"type":"done","runId":"…","output":"…"}
```

- Events are also persisted into the `Run` record as they stream, so a crash mid-run
  still leaves a consistent history (final state is overwritten idempotently at the end).
- The web client parses SSE frames manually from a `fetch` reader (no extra dependency),
  and aborts the request on "Stop".

## 6. Integrations

### 6.1 Google (OAuth2)

- **OAuth2 web-server flow**: `GET /api/google/auth-url?group=workspace|youtube` → consent →
  `GET /api/google/callback` (redirect URI `http://localhost:8787/api/google/callback`)
  → `getToken(code)` → tokens stored in the JSON DB.
- **Scope groups / independent grants**: Google refuses to combine YouTube scopes with Drive
  scopes in one request (`invalid_request: scopes that cannot be requested together`) — and
  because it validates the *merged* scope set, `include_granted_scopes` must stay **off** or
  the already-granted Drive scope gets folded into the YouTube request and fails again.
  Consent is therefore requested per group and stored as **two separate tokens**
  (`googleTokens.workspace`, `googleTokens.youtube`); identity + `calendar.events` +
  `gmail.modify` + `drive.file` + `documents` + `spreadsheets` for workspace,
  `youtube.readonly` + `youtube.upload` for youtube. Each tool asks for the client of
  the API family it calls (`requireAuth(ctx, group)`), and the Integrations page shows
  per-group status with a Connect button. A legacy single token is migrated into the
  workspace group on load.
- `access_type: 'offline'` + `prompt: 'consent'` guarantees a refresh token per group.
- **Silent refresh**: `OAuth2Client.on('tokens')` persists refreshed tokens; every
  agent run calls `getAccessToken()` once and shares one authenticated client with all
  its tools.
- **Failure UX**: 401/403/`invalid_grant` are translated into "reconnect Google on the
  Integrations page" tool errors; the Integrations page has a per-service **self-test**
  (Gmail/Calendar/Drive/YouTube live pings).
- **Scopes** (configurable via `GOOGLE_SCOPES`): identity + `calendar.events` +
  `gmail.modify` + `drive.file` + `documents` + `spreadsheets` + `youtube` +
  `youtube.upload`. `gmail.modify` and `youtube.upload` are restricted scopes — fine in
  Google Cloud *Testing* mode (refresh tokens expire after ~7 days there; reconnect to renew).
- **Markdown Docs** (`drive.ts`): `buildMarkdownRequests()` compiles a Markdown subset
  (headings, bold/italic/inline code, links, bullet + numbered lists, blockquotes, fenced
  code, `---` rules) into Docs API `batchUpdate` requests — one `insertText` per styled
  inline segment plus `updateTextStyle`/`updateParagraphStyle` with an incrementally
  tracked cursor. `driveCreateDoc` and `driveAppendDoc` share the same engine (append
  resolves the doc's end index via `documents.get`). Scope-aware fallbacks keep the old
  plain-text creation and CSV sheet reads working for grants connected before the
  `documents`/`spreadsheets` scopes were added, with a reconnect hint in the result.

See `docs/research/google-integration.md` for the 2026-state quota model
(Gmail 6 000 units/min/user, YouTube 100 `search.list`/day, etc.) and why tools
instruct agents to search narrowly before fetching bodies.

### 6.2 GitHub, Vercel, Supabase (API tokens)

The three newer integrations are **token-based**: no OAuth dance, no redirect URIs,
no credentials in the JSON DB. Each service has:

- a **client module** (`github/client.ts`, `vercel/client.ts`, `supabase/client.ts`) that
  wraps plain `fetch` calls against the service REST API and maps HTTP failures into
  friendly tool errors (401 → "check the token in .env", 403 → "token lacks scope",
  404 → "not found", rate-limit hints where the API exposes them);
- a **status function** derived purely from config (never a network call — `/api/config`
  stays fast) plus a **live self-test endpoint** (`POST /api/github|vercel|supabase/test`)
  that pings identity/keys and reports per-check results to the Integrations page;
- a **tool set** registered under the `github_` / `vercel_` / `supabase_` prefixes.

| Service | Credential | Client | API surface |
| --- | --- | --- | --- |
| GitHub | `GITHUB_TOKEN` (PAT) | `api.github.com` | search/list repos, issues CRUD + comments, PR list/get/create, file read/write via contents API |
| Vercel | `VERCEL_TOKEN` (+ optional `VERCEL_TEAM_ID`) | `api.vercel.com` | projects list/get, deployments list/get/redeploy/cancel, domains, project env vars |
| Supabase | `SUPABASE_PROJECT_REF` + `SUPABASE_SERVICE_ROLE_KEY` (+ optional `SUPABASE_ACCESS_TOKEN`) | `<ref>.supabase.co` + `api.supabase.com` | PostgREST select/insert/update/delete with raw filter strings, SQL + table listing (management API), Storage uploads, auth admin user creation |

Notes:

- **Supabase splits into two credentials on purpose**: the service_role key drives the data
  plane (PostgREST/Storage/Auth-admin) and bypasses RLS, while the optional management PAT
  only unlocks `supabase_run_sql` / `supabase_list_tables`. Tools report a specific
  "set SUPABASE_ACCESS_TOKEN" error when that half is missing.
- **GitHub file writes** fetch the current blob sha when none is given, so the same tool
  creates or updates files; contents are base64 (UTF-8 text decoded for the agent, binary
  returned as base64 with a flag).
- **Vercel redeploy** uses the `POST /v13/deployments?deploymentId&forceNew=1` endpoint and
  inherits the original target (production/preview); uploading brand-new builds is out of
  scope (git-linked projects cover the common case).
- Every tool set is marked `requiresGithub/requiresVercel/requiresSupabase` in the registry;
  the `/api/config` payload exposes those flags so the agent editor can show
  "needs X" chips per tool group when the credential is missing.
- The system prompt's destructive-action rule now covers GitHub writes, Vercel redeploys/
  cancels and Supabase data changes/SQL, keeping the confirm-before-acting guarantee
  uniform across all four integrations.

## 7. LLM provider layer

`llm/openaiCompat.ts` speaks the OpenAI chat-completions wire format, so one client
covers DeepSeek V4 (`deepseek-v4-pro` default), OpenAI, Gemini (`…/v1beta/openai/`),
OpenRouter and local vLLM:

- Tool specs map 1:1 from the tool registry's JSON Schemas.
- `tool_choice` defaults to `auto`; a final `none` call is used after the step budget.
- **DeepSeek V4 specifics**: `reasoning_content` is captured from assistant messages
  and passed back on subsequent turns (required after tool calls, else HTTP 400);
  optional `thinking`/`reasoning_effort` params via `LLM_THINKING_MODE`;
  transient errors (429/5xx and `finish_reason: insufficient_system_resource`)
  retry once with a 1 s backoff.
- Errors are normalized into friendly messages (missing key, HTTP status, bad payload).
- `LLM_PROVIDER=mock` provides an offline brain for demos and smoke tests.

## 8. Design principles (from the research)

1. **More agents ≠ better** — teams are small and intentional; delegation is explicit,
   not free-form agent chat.
2. **Deterministic engine, creative agents** — the loop, budgets, validation and error
   handling are code; only reasoning and action-selection are the LLM's.
3. **Append-only persistence** — every message/step/event is stored; that buys run
   history, replay and trust for free.
4. **Two-tier memory** — conversation is short-term; `memory_set/get` is the
   user-visible long-term tier.
5. **The run view is the product** — streaming chat + a live step/tool inspector makes
   the agent's work auditable.
