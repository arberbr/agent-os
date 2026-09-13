# Agents OS — Architecture

This document describes how Agents OS is built. Design decisions were informed by the
web research in [`docs/research/agent-os-landscape.md`](research/agent-os-landscape.md)
and [`docs/research/google-integration.md`](research/google-integration.md).

## 1. Module map

```
┌────────────────────────── web (React + Vite, :5173) ──────────────────────────┐
│ Login / signup · Dashboard · Agents (list/editor) · Run view (chat + live      │
│ activity rail) · Runs history · Schedules · Integrations · Settings            │
└──────────────────────────────────┬─────────────────────────────────────────────┘
                                   │ REST + SSE (vite proxy /api → :8787) + session cookie
┌──────────────────────────────────▼─────────────────────────────────────────────┐
│ server (Node + Express, :8787)                                                 │
│                                                                                │
│  api/app.ts          REST routes, SSE run stream, OAuth callback, self-tests   │
│  api/auth.ts         signup/login/logout/state, own-profile routes             │
│  api/admin.ts        instance settings, SMTP relay, user management (admin)    │
│  api/schedules.ts    recurring runs: CRUD, cadence preview, run-now            │
│  auth.ts             scrypt hashes, session cookies, gate middleware, throttle │
│  agents/executeRun.ts one turn end-to-end: context, loop, persistence          │
│  agents/runAgent.ts  tool-calling loop, delegation, guardrails                 │
│  agents/prompts.ts   system-prompt builder (persona + team roster + rules)     │
│  agents/history.ts   session transcript → history prefix (budget + pairing)    │
│  schedules/cron.ts   5-field cron: parse, validate, next firing, describe      │
│  schedules/scheduler.ts  the tick loop: arm, fire, settle, pause, notify       │
│  mail/settings.ts    SMTP credentials: coercion, redaction, transport key      │
│  mail/sender.ts      the only SMTP client: cached transport, verify, send      │
│  mail/message.ts     who gets told, when, and what the email says              │
│  mail/notify.ts      the hook: a settled firing → a delivered report           │
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
│  store.ts            JSON-file store: accounts, sessions, settings, SMTP relay,│
│                      agents, runs, schedules, google tokens, agent memory      │
└──────────────────────────────────┬─────────────────────────────────────────────┘
                                   │
                    ┌──────────────┴───────────────────────────────────────────────┐
                    │ OpenAI-compatible LLM API (any provider / mock mode)         │
                    │ Google APIs (googleapis) — OAuth2 user tokens                │
                    │ GitHub · Vercel · Supabase — REST / PostgREST (fetch)        │
                    │ SMTP relay (nodemailer) — notification email for runs (§8.4) │
                    └──────────────────────────────────────────────────────────────┘
```

## 2. Data model

Everything persists to `server/data/db.json` (atomic writes: tmp file + rename, debounced 120 ms).
The workspace is shared — every account sees the same agents, runs and integrations —
while access to it is account-gated (§3):

```ts
User {
  id, email,                                // email is the login id, lowercase + unique
  name, role,                               // 'admin' | 'member'
  passwordHash,                             // scrypt$<salt>$<key>, never leaves the server
  createdAt, lastLoginAt
}

Session {                                   // one signed-in browser
  id, userId, tokenHash,                    // sha-256 of the cookie token, never the token
  createdAt, expiresAt, lastUsedAt
}

AppSettings {                               // instance knobs, edited on the Settings page
  signupsEnabled,                           // false → only an admin adds accounts
  allowedSignupDomains: string[],           // [] = any domain
  sessionDays,                              // login lifetime
  runHistoryLimit                           // sessions kept before the oldest are pruned
}

MailSettings {                              // the SMTP relay, edited on the Settings page
  enabled,                                  // master switch: false → nothing is ever sent
  host, port, security,                     // security: 'starttls' | 'tls' | 'none'
  username, password,                       // password is write-only: never sent to the browser
  fromName, fromEmail, replyTo,             // fromEmail is also the envelope sender
  verifyCertificate,                        // false accepts a self-signed internal relay
  updatedAt                                 // set once saved; after that .env no longer seeds it
}

AgentDef {
  id, name, description, instructions,      // instructions = system prompt body
  model,                                    // '' → default LLM_MODEL
  enabledTools: string[],                   // tool names the agent may call
  teamAgentIds: string[],                   // agents this one can delegate to
  color, createdAt, updatedAt
}

Run {
  id, agentId, title, status,               // running | completed | failed | cancelled
  createdBy,                                // account that opened the session (null = legacy)
  messages: ChatMessage[],                  // full transcript incl. tool messages
  steps: RunStep[],                         // append-only activity log (replay/UI)
  output, error, startedAt, finishedAt,
  scheduleId                                // set when a schedule fired this run
}

RunStep {
  index, kind,                              // llm | tool_call | tool_result | delegate | note
  toolName?, args?, result?, error?, note?, durationMs?, at
}

Schedule {                                  // a recurring run: agent + task + cadence
  id, agentId, name, input,                 // input = the task handed over every firing
  cron,                                     // 5-field cron, server local time
  enabled, createdBy, createdAt, updatedAt,
  nextRunAt,                                // precomputed by the engine for the console
  lastRunAt, lastRunId, lastStatus, lastError,
  runCount, failures,                       // failures = consecutive, drives the self-pause
  pausedReason,                             // why the engine paused it (agent gone, failures)
  notifyOn,                                 // never | failure | success | always (§8.4)
  notifyEmails: string[],                   // extra recipients; the creator is always included
  lastNotifyAt, lastNotifyError             // what the last notification did, and why not
}

GoogleToken { userId, email, name, picture, scopes, accessToken, refreshToken, expiryDate, connectedAt }
agentMemory: Record<agentId, Record<key, value>>   // long-term memory (memory_set/get)
```

A `Run` **is a session**: it is opened by the first message of a conversation and every
later message is answered into the same record (see §6), so the transcript and the step
log span the whole conversation while the title stays the opening prompt. The run screen
replays that stored transcript with the same chat components the live view uses
(`web/src/components/chat/run-transcript.ts` re-pairs stored assistant/tool messages into
tool parts), so an open session and the same session read back from history look alike —
while the Activity rail stays the place where tool arguments and results are inspected.

## 3. Accounts, sessions and the gate

The console used to be open to anyone who could reach the port; it now starts at a login
screen (email + password) and every API route but `/api/health` and `/api/auth/*` answers
`401` without a session.

- **First run.** `store.countUsers() === 0` is reported as `needsSetup`; `POST /api/auth/signup`
  gives that first account `role: 'admin'`. Signups being *closed* never blocks it — an
  instance with no accounts must be able to create its admin.
- **Passwords** are scrypt (per-account salt, 64-byte key) and compared with
  `timingSafeEqual`. A login for an unknown email still verifies against a decoy hash, so
  response time does not reveal whether an account exists. Failed logins are throttled
  (8 per 10 minutes per email + IP).
- **Sessions** are opaque 32-byte tokens in an `HttpOnly; SameSite=Lax` cookie (`Secure`
  when `PUBLIC_URL` is https). The database stores only `sha256(token)`, so `db.json` cannot
  be replayed as a login. `attachUser` resolves the cookie on every request; expired
  sessions are dropped on load and on lookup. Changing a password (own, or an admin reset)
  revokes that account's other sessions.
- **The gate** is one line of Express in `api/app.ts`: public routes first, then
  `app.use('/api', sameOriginOnly, requireAuth)` for everything else, then the admin router
  (`requireAdmin`, so a member gets `403`). `sameOriginOnly` rejects state-changing requests
  whose `Origin` is not `PUBLIC_URL`/`WEB_ORIGIN`, and CORS only reflects those origins with
  credentials — the cookie cannot be ridden by another page.
- **Admin surface** (`/api/admin/*`): the Settings page reads/writes `AppSettings` and
  manages people — create an account directly (the path that works with signups off),
  change a role, set a new password, remove an account. Guards make lockout impossible: you
  cannot demote or delete yourself, and the last administrator cannot be demoted or removed.
- **Navigation.** `web/src/lib/auth.tsx` holds the session in React context; the root route
  renders the console when `/api/auth/state` reports a user and the login card when it does
  not. Any `401` from any API call fires `agentos:unauthorized`, which re-asks that endpoint
  and drops the UI back to the login screen — a deep link survives the round-trip, since
  signing in simply renders the route the browser was already on.

## 4. Agent runtime — the tool-calling loop

```text
messages = [system(persona + team roster + operating rules)] + history + [user input]
# history = the session's transcript so far, minus the system prompt: complete
# tool call/result groups only, oldest turns dropped past CONVERSATION_HISTORY_MAX_CHARS

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

`agents/executeRun.ts` wraps that loop into **one turn, end to end**: it splits the
stored transcript into the replayed history prefix and this turn's starting point,
streams every step/message into the `Run` record as it happens, and settles the record
(`completed` / `failed` / `cancelled`) at the end. It exists because a turn now has two
entry points — `POST /api/agents/:id/run` (SSE, someone watching) and the scheduler
(§8, nobody watching) — and both must persist history identically.

Guardrails (per landscape research):

| Guardrail | Implementation |
| --- | --- |
| Step budget | `AGENT_MAX_STEPS` (default 12) |
| Context budget | tool results truncated to `TOOL_RESULT_MAX_CHARS` (8 000) |
| Conversation budget | prior turns replayed oldest-first up to `CONVERSATION_HISTORY_MAX_CHARS` (80 000 chars) |
| Failure circuit-breaker | 3 consecutive tool failures abort the run |
| Bad arguments | JSON parse errors surface as tool results instead of crashing |
| Cancellation | `AbortSignal` from the SSE client disconnect → `cancelled` status |
| Destructive actions | system-prompt rule: confirm before send/delete/share/publish |
| Unknown tool calls | answered with the available-tool list as a tool result |

## 5. Multi-agent orchestration — delegation as a tool

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

## 6. Live streaming (SSE)

`POST /api/agents/:id/run` takes `{ input, sessionId? }` and responds with
`text/event-stream`:

```
data: {"type":"start","runId":"…"}
data: {"type":"step","runId":"…","step":{"kind":"llm","note":"thinking (step 1/12)","at":"…"}}
data: {"type":"step", …, "step":{"kind":"tool_call","toolName":"gmail_search","args":{…}}}
data: {"type":"step", …, "step":{"kind":"tool_result","toolName":"gmail_search","result":"[…]"}}
data: {"type":"message", …, "message":{"role":"assistant","content":"…"}}
data: {"type":"done","runId":"…","output":"…"}
```

- **One session per conversation.** `start.runId` identifies the session. The web client
  keeps it and sends it back as `sessionId` on the next message, so the server answers in
  the same `Run` — history, steps and the Runs-history row all continue instead of a new
  session appearing per message. Concurrency is guarded (409 while the session is
  answering) and an unknown id falls back to a fresh session; the agent page's
  **New session** button forgets the id and starts over.
- Events are also persisted into the `Run` record as they stream, so a crash mid-run
  still leaves a consistent history (final state is overwritten idempotently at the end).
- The web client parses SSE frames manually from a `fetch` reader (no extra dependency),
  and aborts the request on "Stop".

## 7. Integrations

### 7.1 Google (OAuth2)

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

### 7.2 GitHub, Vercel, Supabase (API tokens)

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

## 8. Scheduled runs

An agent can be given a **recurring job**: a cadence, a task, and the agent that should
do it. The engine lives in this process (`schedules/scheduler.ts`), started in
`index.ts` and stopped on shutdown — no browser needs to be open, and no external cron
daemon has to know about the JSON store.

```
Schedules page ──▶ POST /api/schedules ──▶ store.schedules[]
                                              │
                        every SCHEDULER_TICK_SECONDS:
                        due = enabled ∧ nextRunAt ≤ now ∧ not already running
                                              │
                              run = createRun(agent, task, createdBy, scheduleId)
                                              │
                              executeTurn(§4) ─┴─▶ the same Run history as a chat
```

**A schedule is not a session.** Every firing opens a *fresh* `Run` (titled after the
task, tagged `scheduleId`, attributed to the account that created the schedule) with an
opening `note` step — `scheduled run · Every weekday at 09:00` — so the history reads as
a series of executions and shows why each one happened. Continuity between firings is
what agent memory (`memory_set` / `memory_get`) is for.

### 8.1 The cron engine (`schedules/cron.ts`)

Dependency-free, five fields (`minute hour day-of-month month day-of-week`): `*`, values,
ranges, steps (`*/15`, `8-18/2`, `5/20`), comma lists, month/weekday names and the
`@hourly…@yearly` macros. Cron's day rule is honored — when both day fields are
restricted, **either** may match. Times are evaluated in the **server's local time zone**:
a self-hosted instance schedules against the clock of the machine it runs on.

`nextRun` is a field-level search (month → day → hour → minute) with an eight-year
horizon rather than a minute-by-minute scan, so `0 0 29 2 *` resolves instantly and
`0 0 31 2 *` returns "never" instead of hanging. `describeCron` turns an expression into
the label the console shows ("Every weekday at 09:00"), and falls back to
`Custom · <expr>` rather than describe something it cannot simplify. The engine is the
one part of the feature that could be silently wrong, so it is covered directly:
`pnpm test` runs `cron.test.ts` through `node --test`.

### 8.2 The tick loop

| Rule | Why |
| --- | --- |
| One run per schedule at a time | A schedule whose previous run is still going is skipped, never stacked; the cadence is recomputed from the moment the run *finishes*, so a slow run cannot pile up a backlog. |
| Missed occurrences are skipped, never replayed | `nextRunAt` is recomputed from *now* on boot: a machine that was off overnight does not wake up and fire a night of work, and a restart loop cannot multiply runs. |
| Bounded concurrency (`SCHEDULE_MAX_CONCURRENCY`) | Work beyond the cap stays *due* and is picked up on a later tick — that is the backpressure keeping an unattended box (and the LLM bill) sane. |
| Self-pause after N failures (`SCHEDULE_MAX_FAILURES`) | `failures` counts consecutive failures; at the cap the schedule disables itself and stores `pausedReason`. Editing it clears the counter and re-arms it. |
| Interrupted runs are closed at boot | Nothing survives a restart, so any run still marked `running` is marked failed (`failInterruptedRuns`), and a schedule that was mid-run has its last status settled the same way — neither is left claiming to be running forever. |
| Missing agent ⇒ paused | A schedule whose agent was deleted is parked with a reason (deleting an agent also deletes its schedules). |
| Shutdown aborts in-flight runs | `scheduler.stop()` clears the interval and aborts the controllers before the store is flushed, so nothing writes after the final save. |

Schedules are stored with a precomputed `nextRunAt`, which is what the console renders —
it never has to re-derive a cadence, and the engine's notion of "next" and the UI's are
the same value. `POST /api/schedules/preview` validates an expression *before* it is
saved and returns its description plus the next few firing times.

### 8.3 API and console

```
GET    /api/schedules          list (armed first, soonest to fire at the top)
POST   /api/schedules          create { agentId, input, cron, name?, enabled?,
                                        notifyOn?, notifyEmails? }
GET    /api/schedules/:id      one schedule
PUT    /api/schedules/:id      partial patch — the list flips `enabled` on its own
DELETE /api/schedules/:id      remove
POST   /api/schedules/:id/run  fire now → 202 { runId } (executes in the background)
POST   /api/schedules/preview  { cron } → { valid, description, next[] }

GET    /api/admin/mail         relay status — never the password (admin only)
PUT    /api/admin/mail         patch credentials; `password` absent = keep the stored one
DELETE /api/admin/mail         forget the relay entirely
POST   /api/admin/mail/test    { to? } → connect + authenticate; delivers when `to` is set
```

Each schedule view is joined with `notifyRecipients` (everyone a notification would reach,
creator included) and `mailConfigured`, so the editor can state what will happen instead of
leaving the operator to guess.

Every route sits behind the same session gate as the rest of the API; the workspace is
shared, so any signed-in account manages the schedules it can see and the creator is
recorded (`createdBy`, shown as an email). **Run now** works on a paused schedule too —
pressing it is an explicit decision and deliberately does *not* re-arm the cadence.

The Schedules page (`web/src/pages/Schedules.tsx`) is a table of what is armed, with a
live poll so "next run" counts down and engine-started runs appear without a refresh.
The editor offers presets (*every N minutes, hourly, daily, weekdays, weekly, monthly*)
that compile to a cron expression, plus a raw expression field; re-opening a schedule
reverse-maps its stored expression back onto the controls, and anything not shaped like
a preset opens in **Custom cron** intact rather than approximated. The dashboard lists
what is about to fire, the run history tags every run a schedule started, and the agent
run page links to that agent's schedules.

| Variable | Meaning |
| --- | --- |
| `SCHEDULER_ENABLED` | `false` parks the engine: schedules stay stored and can still be run by hand, but never fire on their own. |
| `SCHEDULER_TICK_SECONDS` | How often the engine looks for due work (default 20). |
| `SCHEDULE_MAX_CONCURRENCY` | Scheduled runs in flight at once (default 2). |
| `SCHEDULE_MAX_FAILURES` | Consecutive failures before the self-pause (default 5, `0` = never). |

### 8.4 Email notifications

An unattended schedule is only useful if you find out what it did. A schedule can therefore
ask to be **emailed its outcome**: `never` (the default, so upgrading sends nobody anything),
`failure` (failed *or* cancelled — a run cut short by a restart is exactly the silent outcome
worth an email), `success`, or `always`.

```
fire → executeTurn(§4) → settle(schedule)   ── the record is written first
                              │
                              ├─ in-flight slot released
                              │
                              └─ notifyScheduleOutcome()   ← after the schedule is free
                                     ├─ notifyOn says nobody cares   → 'off' / 'not-due'
                                     ├─ no relay configured          → recorded on the schedule
                                     ├─ no recipients                 → recorded on the schedule
                                     └─ mailSender.send()            → lastNotifyAt, or lastNotifyError
```

**Ordering is the design.** The notification runs *after* `settle()` and *after* the
in-flight slot is released, so a slow or unreachable relay can never make a firing look busy,
delay the next one, or change what happened. `notifyScheduleOutcome` returns a value for
every outcome — sent, skipped, refused — and never throws: the two states an operator would
want to fix (no relay, nobody to write to) are written to `lastNotifyError` and shown in the
console, and a mail failure can never fail a run or contribute to the self-pause.

**Who gets it.** The account that created the schedule, plus any addresses on
`notifyEmails` — additions, not replacements. Addresses are validated and de-duplicated on
the way in and again on the way out; a schedule with no creator and no addresses is a
recorded skip rather than a bounce. Notifications cover **Run now** as well as cadence
firings, and the email says which it was.

**The content** (`mail/message.ts`, pure and unit-tested) is a report, not a ping: schedule,
agent, cadence, trigger, start, duration, steps, the task, then the output — or the error,
with any partial output labelled as such — and a link back to the run. Output is capped at
4000 characters so a chatty agent cannot mail a novel. It ships as `multipart/alternative`,
and it is deliberately **light-themed**: the console is a dark instrument, but a run report
lands in mail clients that force-invert dark backgrounds, so the email keeps the family
resemblance through structure and the same accent/state colours on a warm stone page.
Everything interpolated is HTML-escaped, which is what stops an agent-written task from
injecting markup into your inbox.

**The relay** (`mail/sender.ts`) is the only place the server speaks SMTP — nodemailer, which
has no dependencies of its own. It caches one transport and rebuilds it only when the
connection-relevant settings change (compared by fingerprint), so saving the Settings page
takes effect on the next message rather than at the next restart. Connect, greeting and
socket timeouts are set explicitly (10 s / 10 s / 60 s) because waiting on a dead relay must
not wedge a scheduled run. `security: 'starttls'` sets `requireTLS`, so credentials are never
offered over a plaintext connection; failures are mapped from `EAUTH`/`ECONNECTION`/TLS codes
into sentences that say what to change.

Credentials are entered by an **administrator** on the Settings page. They live in `db.json`
next to the Google refresh token — `SMTP_HOST` and friends in `.env` seed an unsaved record
for headless setups, but once the pane has been saved the database is authoritative. The
password is write-only: the API returns only `hasPassword`, and the console posts it only
when the field has actually been touched, which is what makes "leave it blank to keep it"
true rather than a polite lie that wipes a working credential on every unrelated save.

`pnpm test` covers the pure parts directly (the due/not-due matrix, recipient resolution,
escaping, truncation, coercion and redaction) and drives the sender against a **real SMTP
conversation** — a listener on `127.0.0.1` that authenticates, takes an envelope and accepts
DATA — including PLAIN and LOGIN, bad credentials, a refused recipient and a dead port. A
running instance can be checked end to end with `node .smoke/verify-notifications.mjs
<base-url>`, which enters credentials through the admin API and asserts the resulting email
decodes the way a mail client would.

## 9. LLM provider layer

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

## 10. Design principles (from the research)

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
