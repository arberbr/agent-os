# Agents OS — Landscape Research (2024–2025, reviewed early 2026)

Research for our self-hosted "Agents OS" (TypeScript/Node + React, OpenAI-compatible chat-completions, JSON-file persistence, self-built agent runtime). Findings from vendor docs and practitioner write-ups; all sources cited inline.

## (a) Landscape: what each system calls things, what to copy / avoid

**Terminology crosswalk** (their names → our names):

| Concept | OpenAI Agents SDK | Google ADK | LangGraph | CrewAI | Mastra | Claude Agent SDK | Ours |
|---|---|---|---|---|---|---|---|
| Conversation | Session | Session (Events) | Thread | Crew chat / short-term memory | Memory w/ threadId | Session | Conversation |
| One execution | Run (Runner) | Run/invocation | Graph invocation | Crew kickoff | `.generate()/.stream()` | Agent loop turn | Run |
| Capability | Tool / handoff | Tool | Node / edge | Tool | Tool | Tool / MCP | Tool |
| Sub-agent | Agent (handoff / as tool) | LlmAgent in workflow | Subgraph | Agent in crew | Subagent (agent-as-tool) | Subagent | Team member |

**The table of systems:**

| System | Core concepts | Copy for us | Avoid |
|---|---|---|---|
| **OpenAI Agents SDK + AgentKit** ([intro](https://openai.github.io/openai-agents-python/), [handoffs](https://openai.github.io/openai-agents-python/handoffs/)) | Agent = instructions + tools + guardrails + handoffs; **handoff is just a tool** (`transfer_to_refund_agent`); guardrails run in parallel and fail fast; Sessions as memory layer; tracing built in. AgentKit adds builder UI, tool picker, session view, eval/guardrail panes ([announcement](https://openai.com/index/introducing-agentkit/), [explainer](https://www.thesys.dev/blogs/agentkit)) | Minimal primitive set (3 concepts); handoff-as-tool; **structured handoff payload** (`input_type` schema: `{reason, priority}`); **input filters** that strip tool chatter from history before a handoff; optional history summarization on nested handoffs; streaming event taxonomy | Responses-API defaults (we're chat-completions); Python-first; sprawling extras (sandbox/realtime agents); handoffs without filters bloat the next agent's context |
| **Google ADK** ([agents](https://adk.dev/agents/index.md), [sessions](https://adk.dev/sessions/index.md)) | LlmAgent = model + instructions + tools; clean 3-layer context: **Session** (events of one thread) vs **State** (per-session dict) vs **Memory** (searchable cross-session store); SessionService/MemoryService; grow single-agent → workflow when instruction-following degrades or context limits hit; skills pattern | The 3-layer context model maps perfectly to JSON files; append-only Session event log; explicit triggers for "split your agent" (long instructions, context limits, mix of deterministic + LLM steps) | Deep Gemini/Google defaults; MemoryService w/ vector search is scope creep for v1; framework sprawl |
| **LangGraph / LangChain** ([checkpointers](https://docs.langchain.com/oss/javascript/langgraph/checkpointers), [supervisor pkg](https://www.npmjs.com/package/@langchain/langgraph-supervisor), [supervisor write-up](https://www.kinde.com/learn/ai-for-software-engineering/ai-agents/hierarchical-agent-teams-with-langgraphsupervisor/)) | Graph of nodes/edges with explicit state; **Threads + Checkpoints** = durable execution, resume, time-travel, replay; supervisor package = router node + per-worker subgraphs | Threads/checkpoints as the resume-and-observability backbone; explicit edges for deterministic control where the plan is known; supervisor = one router node + scoped worker graphs | Node/edge boilerplate & steep API churn; low-level loop hand-rolling; lock-in (we deliberately self-build) |
| **CrewAI** ([crews](https://docs.crewai.com/en/concepts/crews), [flows](https://docs.crewai.com/en/concepts/flows), [AMP](https://docs-platform.crewai.com/platform/en/introduction)) | Crew = agents + tasks + process (**sequential** or **hierarchical** w/ manager LLM); each task takes structured input and emits a structured output; Flows add deterministic control; memory/knowledge/planning/collaboration flags; event listeners; AMP = hosted run/observe UX | `role + goal + backstory` as the prompt scaffold users fill in; **task output as a typed artifact** passed to the next agent; event-listener surface for UI streaming; AMP's build→observe loop | Heavy OO scaffolding; "magic" auto-delegation & collaboration flags; hierarchical manager LLM = extra cost per message |
| **Microsoft AutoGen → Agent Framework** ([overview](https://learn.microsoft.com/en-us/agent-framework/overview/agent-framework-overview), [analysis](https://www.infoworld.com/article/4069808/unpacking-the-microsoft-agent-framework.html)) | Merge of AutoGen + Semantic Kernel: Agents (model + tools + MCP), **Workflows** (functional + graph), **Harness Agent** (planning/todo, context compaction, file access, don't-ask-again tool approvals), middleware pipeline, session state. AG2 fork carries AutoGen Studio (low-code UI) | The **"if you can write a function, don't use an agent"** rule; agent-vs-workflow decision matrix; middleware/hook pipeline for interception; Harness features = good long-task checklist | Framework churn (AutoGen 0.2 → 0.4 → AF, AG2 split); Azure/enterprise coupling; C# first-class |
| **Letta (MemGPT)** ([concepts](https://docs.letta.com/concepts/memgpt/), [SDK](https://docs.letta.com/v1-sdk)) | OS-inspired memory hierarchy: **core memory blocks** (persona/human, self-edited) + in-context window + archival recall + external tools; context **compaction**; blocks attach/detach per agent; conversation fork; scheduling; steps/trace observability | **Named, editable memory blocks the user can see and edit in UI**; compaction as a first-class operation; fork/version a conversation; shared memory across agents; run→steps→trace event model | Full "agent OS" framing; Python server; embeddings/archival infra too early for us |
| **Vercel AI SDK + Mastra** ([Mastra agents](https://mastra.ai/docs/agents/overview), [Vercel guide](https://vercel.com/guides/ai-agents)) | Vercel: provider-agnostic `generateText/streamText`, schema-validated `tool()`, `stopWhen`/`maxSteps` guardrails, `useChat` UI streaming. Mastra: `Agent{id,name,instructions,model}`, agents-as-tools, **supervisor/subagent patterns**, memory, guardrails, processors, workflows, Studio + browser Agent Builder | TS-native DX closest to ours; agent-vs-workflow guidance ("workflow when steps are known"); subagent/supervisor docs; Studio playground = chat + tool-call inspector; browser builder for agents | Framework coupling (Mastra's registry/storage/version churn); Vercel platform gravity |
| **Claude Agent SDK** ([overview](https://code.claude.com/docs/en/agent-sdk/overview), [agent loop](https://code.claude.com/docs/en/agent-sdk/agent-loop)) | The Claude Code engine as a library: agent loop, **hooks** (PreToolUse/PostToolUse/UserPromptSubmit/Stop) as interception points, subagents, **sessions with external persistence**, permissions (`canUseTool` w/ approval UX), structured outputs, checkpointing, todo tracking, OpenTelemetry | Hook-based control plane = clean place for guardrails, logging, UI events; session resumability across restarts; approval/deny + "don't ask again" UX; todo tracking for long runs; OTel tracing | Coding-agent-centric defaults; Anthropic API coupling in tooling |
| **OpenOS** ([GitHub](https://github.com/deepelementlab/openos)) | "Agent-native OS": closed loop definition → runtime → operations for long-running agent workloads; lifecycle management across dev/delivery/ops | Product framing: an **agent lifecycle console** (define, deploy, observe, operate) is the missing consumer product; long-running job emphasis | Early-stage/moving target; OS metaphor scope creep; thin docs |
| **n8n AI agents** ([AI docs](https://docs.n8n.io/advanced-ai/intro-tutorial/)) | AI Agent node = LLM + tools + memory on a visual canvas, wired to triggers & integrations (Gmail, Calendar, Drive); template marketplace; per-node execution view w/ retries; approval nodes | Visual tool/integration wiring; **per-step execution inspector** (see every input/output); template gallery for onboarding; manual approval as an explicit node | Node-graph complexity for non-devs; workflow-first rather than team-first; multi-agent support bolted on |
| **ChatGPT custom GPTs / Agent Builder** ([GPT Builder help](https://help.openai.com/en/articles/8770868-gpt-builder), [AgentKit](https://openai.com/index/introducing-agentkit/)) | GPT Builder: **conversational wizard that fills the form** (name/avatar/instructions/starters), capability toggles (browse, code interpreter), **Actions = OpenAPI schema + auth**, files as knowledge, live side-by-side preview pane | Chat-to-build wizard; capability/tool toggles with icons; starters; schema-first tool definitions; instant playground preview next to the builder | Single-agent-per-GPT model (no teams); closed platform; shallow instructions surface |

## (b) Recommended architecture for our Agents OS

**Modules (monorepo, TS):**

```
core/llm        OpenAI-compatible chat-completions client: baseUrl+key per provider,
                streaming, JSON-schema output, token counters, retries/backoff
core/runtime    the agent runner (tool loop below); tool registry + executor;
                guardrail chain; budget manager; cancellation
core/events     typed event bus (run.started / token / tool.started / tool.done /
                agent.message / handoff / run.completed / error) → SSE adapter
core/memory     conversation store (append-only messages); per-agent memory files;
                compaction/summarizer; team shared workspace (files on disk)
core/teams      orchestrator engine: delegation tool, sub-run spawner, task lifecycle
integrations/   gmail, calendar, drive, youtube: OAuth2 token store + typed tool impls
web/api         REST (entities) + SSE (streams); background job runner for scheduled runs
web/ui          React: builder, teams, run/chat view
data/           JSON files per entity; atomic writes (tmp+rename); run transcripts
```

**Data model sketch (one JSON file per entity; ids are kebab-case):**

```jsonc
agents/{id}.json   { id, name, avatar, role, goal, instructions,
                     model: "provider/model", modelConfig: { temperature, maxTokens },
                     tools: ["gmail.send", "calendar.find_slots", ...],
                     memory: { notes, prefs }, teamId, createdAt }
teams/{id}.json    { id, name, agents: [{ agentId, title, canDelegate, visibleToTeam }],
                     routing: "orchestrator" | "sequential", sharedWorkspace: true }
tools/registry.json{ builtin: [{ name, description, jsonSchema, kind: "google"|"http"|"code",
                     requiresOAuth, isDestructive }] }        // + user-defined tools
conversations/{id}.json
                   { id, scope: "agent"|"team", agentId, teamId, title,
                     messages: [{ id, role, content, toolCalls, toolCallId, name, ts }],
                     summary, status: "idle"|"running", usage: { in, out } }
runs/{id}.json     { id, conversationId, agentId, status, startedAt, endedAt,
                     steps: [{ kind, agentId, input, output, toolCalls, usageMs }],
                     budget: { steps, tokens }, error }
credentials/{user}.json   // OAuth2 tokens, encrypted at rest; referenced by tools
```

Why this shape: every run is fully reconstructable (append-only messages + steps) → replay, resume after crash, and the run-view UI can render history without a database. Letta's blocks, ADK's Session, and LangGraph's checkpoints all confirm this "persist events, not state" instinct.

## (c) Multi-agent orchestration recommendation (teams)

**Recommendation: orchestrator + delegation-as-tool, depth ≤ 2. No free-form group chat.**

- One **lead/orchestrator agent** per team holds the conversation. Team members are exposed to it as *delegation tools* (OpenAI Agents SDK "handoff as tool" pattern), each with a tool description stating when to use it.
- A delegation call carries a **structured payload**: `{ task, context, deliverable, budgetHint }`. The engine spawns a **sub-run** for the member agent with fresh context seeded from that payload plus a *filtered* history (strip tool chatter, keep user goal + prior artifacts) — OpenAI's `input_filter` / `remove_all_tools` pattern. The member returns `{ summary, artifacts[] }` (files land in the team workspace), and only the summary is appended as the tool result. This is the anti-context-bloat mechanism.
- **Team workspace files as the message bus for bulky data**: agents write notes/CSV/docs to a shared folder and hand each other *file refs*, not full content (CrewAI structured task outputs; Claude Code's file-based workflow). The CACM "[Hidden Token Trap](https://cacm.acm.org/blogcacm/the-hidden-token-trap-of-agent-orchestration/)" shows raw agent-to-agent transcript passing is the biggest hidden cost.
- `routing: "sequential"` is the escape hatch for predictable pipelines (e.g. triage → draft → review): a deterministic engine passes typed outputs between agents, no router LLM needed (Microsoft/Mastra "workflow when steps are known").

**Message-flow: delegation (default)**

```
User ──msg──▶ Orchestrator agent (conversation C, run A)
               │ 1. LLM: plan → tool_call delegate_to_researcher {
               │      task, context: "<compacted goal+findings>", deliverable: "notes.md" }
               │ 2. Engine: create sub-run B (agent=researcher, seed=payload+filtered history)
               │      └─ Researcher loop: gmail.search → drive.read → notes.write
               │         → return { summary: "…", artifacts: ["notes.md"] }
               │ 3. Engine: append tool_result {summary, artifactRefs} to run A
               │ 4. Orchestrator LLM: compose final answer
               └─▶ User  (every event above streamed to UI as run A/B steps)
```

**Message-flow: sequential pipeline**

```
Engine: planner(agent) ──plan JSON──▶ loop:
        executor(agent_i) ──typed output──▶ verifier(agent) ──▶ done | replan (≤2)
```

Rules that keep it sane: agents never message each other directly — **all traffic goes through the engine** (audit trail, budgets, cancellation); delegation depth capped at 2; per-sub-run budgets inherited; a delegation loop detector (same member + same task twice → fail the run). Rationale: the strongest empirical theme in the sources is that LLM-to-LLM negotiation is fragile; a deterministic controller with structured envelopes is what production systems converge on ([HF failure analysis](https://huggingface.co/blog/Musamolla/multi-agent-llm-systems-failure), [OpenAI orchestration guide](https://openai.github.io/openai-agents-python/multi_agent/), [Mastra multi-agent docs](https://mastra.ai/docs/agents/overview)).

## (d) Tool-calling loop pseudocode (with guardrails)

```ts
async function runAgent(agent, conversation, budget, signal): Promise<string> {
  emit({ type: "run.started", agentId: agent.id })
  for (let step = 0; step < budget.maxSteps /* default 10 */; step++) {
    if (signal.aborted) throw new CancelledError()
    const messages = buildMessages(agent, conversation)   // system + memory notes + (compacted) history
    const resp = await llm.chatCompletions({
      model, messages, tools: agent.tools.map(schema),
      stream: true, temperature, max_tokens,
      response_format: agent.outputSchema ?? undefined,   // structured output when needed
    })                                                     // retry 429/5xx: exp backoff x3
    for await (const chunk of resp) emit({ type: "token", chunk })
    const msg = resp.choices[0].message
    conversation.messages.push({ role: "assistant", ...msg })   // persist BEFORE executing tools
    if (!msg.tool_calls?.length) {
      const verdict = await guardrails.output({ content: msg.content, agent, conversation })
      if (!verdict.ok) return await selfCorrect(verdict.feedback, /* once */)
      emit({ type: "run.completed", usage: resp.usage })
      return msg.content
    }
    for (const tc of msg.tool_calls) {
      emit({ type: "tool.started", tool: tc.function.name, args })
      if (loopDetector.seen(agent.id, tc)) throw new LoopDetectedError(tc)   // identical call repeating
      const ok = await guardrails.preTool({ tool: tc.function.name, args })  // scope, budget, PII
      if (!ok) { pushToolResult(tc, { error: "Blocked by policy" }); continue }
      let result
      try {
        result = await toolExecutor.run(tc, { timeoutMs: 30_000, retries: 2 })
      } catch (e) { result = { error: e.message }; emit({ type: "tool.failed", error: e.message }) }
      const trimmed = truncate(JSON.stringify(result), budget.maxToolResultChars /* ~8k */)
      conversation.messages.push({ role: "tool", tool_call_id: tc.id, content: trimmed })
      emit({ type: "tool.done", output: trimmed, ms })
    }
    budget.spend(resp.usage)                                // token budget too
  }
  throw new BudgetExceededError()                           // → run.status = "stopped:max-steps"
}
```

Guardrail checklist: hard caps on **steps, tokens, wall-time** ([this real bug: subagents looping unbounded with no budget](https://github.com/bytedance/deer-flow/issues/3875)); tool **timeout + retries** and always returning `{error}` not throwing raw; **tool-result truncation**; loop detector on identical tool calls; **approval gate for destructive tools** (gmail.send, drive.delete) surfaced to the UI; output guardrails (PII, required citations); structured output via `json_schema` when a consumer needs typed data; cancellation via `AbortController` wired to the SSE stream; error taxonomy (retryable / model / tool / budget) mapped to friendly UI messages. OpenAI's parallel guardrails + Claude SDK's PreToolUse hooks are the two prior arts ([guardrails](https://openai.github.io/openai-agents-python/guardrails/), [hooks](https://code.claude.com/docs/en/agent-sdk/overview)).

## (e) UX recommendations

**Agent builder** (synthesizing GPT Builder, AgentKit, n8n, Mastra Agent Builder):
- Two entry modes: a **form** (name/avatar, role, goal, instructions with template chips like "Email triager", model + temperature picker, tool picker grouped by Google service with OAuth status badges) and a **"describe it" wizard** that drafts the form fields from a paragraph — GPT Builder's conversational fill-in is the retention trick ([GPT Builder](https://help.openai.com/en/articles/8770868-gpt-builder)).
- Tool picker rows show: name, one-line description, scope requested (e.g. "Gmail: read + send"), **destructive badge** on send/delete tools, and an inline "Connect Google" button when unauthenticated.
- **Live playground docked to the builder**: edit instructions → chat in the same screen; right inspector shows steps, tool calls with args/results, token usage (AgentKit/Mastra Studio pattern). Never make users leave the builder to test.
- Starter templates + "duplicate agent" to bootstrap.

**Team builder**: agent-card list or simple canvas; assign roles (lead vs member), toggle `canDelegate` and `visibleToTeam`; routing mode toggle (orchestrator/sequential) with a one-line explainer; a "test delegation" button that runs a sample task through the whole team and renders the flow.

**Run / chat view** (OpenHands-style event stream, [repo](https://github.com/All-Hands-AI/OpenHands), plus n8n's step inspector):
- Streaming tokens with **agent badges** in team chats ("Now: Researcher…").
- **Activity rail**: collapsible timeline of every step/tool call (args, truncated result, ms, tokens) — the observability users need to trust agents ([n8n execution view](https://docs.n8n.io/advanced-ai/intro-tutorial/)).
- **Inline approvals**: "Gmail: send 3 emails to X" → Approve / Edit / Deny, with "always allow in this run" — Claude SDK's permission UX.
- Progress/status for long runs: plan + todo panel (Claude todo tracking), budget bar, **Stop** button, resume-after-crash.
- Artifacts panel listing files the team produced; run history with **replay**.

## (f) Top 10 lessons / pitfalls

1. **More agents ≠ more intelligence** — more agents = more noise, overhead, and failure points ([HF](https://huggingface.co/blog/Musamolla/multi-agent-llm-systems-failure)).
2. **A deterministic controller beats emergent negotiation** — free agent-to-agent chat drifts; route all traffic through an engine with structured envelopes (same source; [LangGraph supervisor](https://www.npmjs.com/package/@langchain/langgraph-supervisor)).
3. **Wrap every tool in deterministic logic** — schema validation, timeout, retries, truncation; unguarded tool use is the #1 failure mode (HF #6).
4. **Handoffs are tools with schemas** — `transfer_to_X{task, context}` + filtered history beats free-text delegation ([OpenAI handoffs](https://openai.github.io/openai-agents-python/handoffs/)).
5. **Compress at every boundary** — input filters, summaries, artifact refs instead of full text; context bloat is the hidden tax of orchestration ([CACM](https://cacm.acm.org/blogcacm/the-hidden-token-trap-of-agent-orchestration/)).
6. **Persist everything append-only** — messages, steps, events → replay, resume, debugging, and a free run-history UI ([LangGraph checkpoints](https://docs.langchain.com/oss/javascript/langgraph/checkpointers), [Claude sessions](https://code.claude.com/docs/en/agent-sdk/overview)).
7. **Budgets everywhere** — steps, tokens, time, tool-result size; unbounded sub-agent loops are a real production bug ([deer-flow #3875](https://github.com/bytedance/deer-flow/issues/3875)).
8. **Memory = files, with two tiers** — short-term = the conversation; long-term = editable notes/memory blocks the user can see ([Letta](https://docs.letta.com/v1-sdk), [ADK Session/State/Memory](https://adk.dev/sessions/index.md)).
9. **Agent vs workflow is the first design question** — known steps → deterministic workflow/function; unknown steps → agent ([Microsoft](https://learn.microsoft.com/en-us/agent-framework/overview/agent-framework-overview), [Mastra](https://mastra.ai/docs/agents/overview)).
10. **The run view is the product** — streaming + live step inspector + approvals build the trust that makes self-hosted agents usable ([AgentKit](https://openai.com/index/introducing-agentkit/), [n8n](https://docs.n8n.io/advanced-ai/intro-tutorial/), [OpenHands](https://github.com/All-Hands-AI/OpenHands)).
