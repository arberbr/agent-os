import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useChat } from '@ai-sdk/react';
import { listAgents } from '../api';
import { AgentChatTransport } from '../lib/agent-chat-transport';
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from '../components/ai-elements/conversation';
import { Loader } from '../components/ai-elements/loader';
import { Message, MessageContent } from '../components/ai-elements/message';
import {
  PromptInput,
  PromptInputFooter,
  PromptInputProvider,
  PromptInputTextarea,
  PromptInputSubmit,
  usePromptInputController,
} from '../components/ai-elements/prompt-input';
import type { ChatStatus } from 'ai';
import { Icon } from '../components/Icon';
import { Mark } from '../components/Mark';
import { Page, PageActions, PageDescription, PageHeadMain, PageHeader, PageTitle } from '../components/app/page';
import { Panel, PanelContent, PanelHeader, PanelNote, PanelTitle } from '../components/app/panel';
import { AgentRow } from '../components/app/agent-row';
import { ActivityRail } from '../components/chat/activity-rail';
import { hasText } from '../components/chat/chat-parts';
import { MessageAuthor, AssistantMessageView, UserMessageView } from '../components/chat/message-views';
import { StarterSuggestions } from '../components/chat/starter-suggestions';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Button } from '../components/ui/button';
import { plural, tint } from '../format';
import type { AgentDef } from '../types';

/**
 * Composer footer: keyboard hints plus the send control.
 *
 * The control carries two faces so the composer always says what it can do: a
 * quiet key while the box is empty, and the aqua action (send, or stop while a
 * run is in flight) the moment there is something to do. Hints dim until the
 * composer takes focus, and fold away on narrow screens where there is no
 * physical keyboard to describe.
 */
function ComposerFooter({
  status,
  onStop,
}: {
  status: ChatStatus;
  onStop: () => void;
}) {
  const { textInput } = usePromptInputController();
  const running = status === 'streaming' || status === 'submitted';
  const idle = textInput.value.trim().length === 0 && !running;

  return (
    <PromptInputFooter>
      <span className="hidden items-center gap-3 text-[11px] text-mute/70 transition-colors duration-150 group-focus-within:text-mute sm:flex">
        <span className="flex items-center gap-1.5">
          <kbd>Enter</kbd> send
        </span>
        <span className="flex items-center gap-1.5">
          <kbd>Shift</kbd>
          <span className="text-mute/50">+</span>
          <kbd>Enter</kbd> new line
        </span>
      </span>
      <PromptInputSubmit
        status={status}
        onStop={onStop}
        disabled={idle}
        className={
          idle
            ? 'bg-surface-2 text-mute ring-1 ring-rule-2 ring-inset hover:bg-surface-2 disabled:opacity-100'
            : undefined
        }
      />
    </PromptInputFooter>
  );
}

export default function AgentRun() {
  const { id } = useParams({ from: '/agents/$id/run' });
  const [agents, setAgents] = useState<AgentDef[]>([]);
  const [agent, setAgent] = useState<AgentDef | null>(null);
  const [load, setLoad] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');

  const transport = useMemo(() => new AgentChatTransport(id), [id]);
  const { messages, sendMessage, setMessages, status, error, stop } = useChat({
    id: `agent-run-${id}`,
    transport,
  });

  // A fresh agent (or route change) starts a fresh conversation.
  useEffect(() => {
    setMessages([]);
  }, [id, setMessages]);

  useEffect(() => {
    let alive = true;
    setLoad('loading');
    setAgent(null);
    void listAgents()
      .then((list) => {
        if (!alive) return;
        setAgents(list);
        const found = list.find((a) => a.id === id) ?? null;
        setAgent(found);
        setLoad(found ? 'ready' : 'missing');
      })
      .catch(() => {
        if (!alive) return;
        setLoad('error');
      });
    return () => {
      alive = false;
    };
  }, [id]);

  const running = status === 'streaming' || status === 'submitted';
  const assistantMessage = [...messages].reverse().find((m) => m.role === 'assistant') ?? null;
  const assistantHasText = hasText(assistantMessage);

  const handleSubmit = (message: { text: string }) => {
    const text = message.text.trim();
    if (!text || running) return;
    sendMessage({ text });
  };

  if (load === 'loading') {
    return (
      <Page>
        <PageHeader>
          <PageHeadMain>
            <PageTitle>Loading agent…</PageTitle>
          </PageHeadMain>
        </PageHeader>
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_372px]">
          <Panel>
            <PanelContent>
              <div className="h-96 animate-pulse rounded-xl bg-muted" />
            </PanelContent>
          </Panel>
          <Panel>
            <PanelContent>
              <div className="h-96 animate-pulse rounded-xl bg-muted" />
            </PanelContent>
          </Panel>
        </div>
      </Page>
    );
  }

  if (load === 'error' || !agent) {
    const missing = load === 'missing';
    return (
      <Page>
        <PageHeader>
          <PageHeadMain>
            <PageTitle>{missing ? 'Agent not found' : 'Could not load agents'}</PageTitle>
            <PageDescription>
              {missing
                ? 'No agent matches this link. It may have been deleted, or the id may be incomplete.'
                : 'The server did not answer. Check that it is running, then try again.'}
            </PageDescription>
          </PageHeadMain>
        </PageHeader>

        <div className="flex flex-col gap-5">
          <Panel>
            <PanelContent>
              <p className="mt-0 mb-0 font-mono text-xs break-all text-mute">{id}</p>
              <div className="flex flex-wrap gap-2 pt-4">
                <Button asChild>
                  <Link to="/agents">Go to agents</Link>
                </Button>
                {!missing && (
                  <Button variant="secondary" onClick={() => window.location.reload()}>
                    Reload
                  </Button>
                )}
              </div>
            </PanelContent>
          </Panel>

          {missing && agents.length > 0 && (
            <Panel>
              <PanelHeader>
                <div className="flex items-baseline gap-2.5">
                  <PanelTitle>Agents you can run</PanelTitle>
                  <PanelNote>{plural(agents.length, 'agent')}</PanelNote>
                </div>
              </PanelHeader>
              <PanelContent flush>
                <div>
                  {agents.map((entry) => (
                    <Link
                      key={entry.id}
                      to="/agents/$id/run"
                      params={{ id: entry.id }}
                      className="row flex items-center gap-3.5 border-t border-rule px-5 py-3 text-foreground transition-colors first:border-t-0 hover:bg-surface-2 hover:text-foreground"
                    >
                      <AgentRow agent={entry} />
                    </Link>
                  ))}
                </div>
              </PanelContent>
            </Panel>
          )}
        </div>
      </Page>
    );
  }

  const usesGoogle = agent.enabledTools.some(
    (tool) => tool.startsWith('gmail') || tool.startsWith('calendar') || tool.startsWith('drive') || tool.startsWith('youtube'),
  );

  return (
    <Page className="lg:flex lg:h-dvh lg:min-h-0 lg:flex-col">
      <PageHeader className="lg:shrink-0">
        <PageHeadMain>
          <div className="flex items-center gap-3">
            <Mark name={agent.name} color={agent.color} size="lg" />
            <div>
              <PageTitle>{agent.name}</PageTitle>
              <PageDescription className="mt-0.5">
                {plural(agent.enabledTools.length, 'tool')}
                {agent.teamAgentIds.length > 0 && `, team of ${agent.teamAgentIds.length + 1}`}
              </PageDescription>
            </div>
          </div>
        </PageHeadMain>
        <PageActions>
          <Button variant="secondary" asChild>
            <Link to="/agents/$id" params={{ id: agent.id }}>
              <Icon name="edit" size={14} /> Edit
            </Link>
          </Button>
          <Button variant="secondary" onClick={() => setMessages([])}>
            <Icon name="refresh" size={14} /> Clear
          </Button>
        </PageActions>
      </PageHeader>

      <PromptInputProvider initialInput="">
        <div className="grid items-start gap-5 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_372px] lg:items-stretch">
          <Panel className="lg:min-h-0">
            <PanelContent flush className="flex min-h-[440px] lg:min-h-0 lg:flex-1">
              <Conversation>
                <ConversationContent className={messages.length === 0 ? 'lg:h-full' : undefined}>
                  {messages.length === 0 && (
                    <ConversationEmptyState>
                      <div className="flex flex-col items-center gap-3 text-center">
                        <div
                          className="flex size-[52px] items-center justify-center rounded-[14px] border text-lg font-semibold"
                          style={{ background: tint(agent.color, 0.16), borderColor: tint(agent.color, 0.45), color: agent.color }}
                        >
                          {agent.name.slice(0, 2).toUpperCase()}
                        </div>
                        <h3 className="font-medium">{`Give ${agent.name} a task`}</h3>
                        <p className="max-w-md text-sm text-muted-foreground">
                          {usesGoogle
                            ? 'It can work across Gmail, Calendar, Drive and YouTube.'
                            : 'It will work through the tools you enabled for it.'}
                        </p>
                        <div className="w-full max-w-xl pt-2 text-left">
                          <StarterSuggestions />
                        </div>
                      </div>
                    </ConversationEmptyState>
                  )}

                  {messages.map((message) =>
                    message.role === 'user' ? (
                      <UserMessageView key={message.id} message={message} />
                    ) : (
                      <AssistantMessageView key={message.id} message={message} agent={agent} />
                    ),
                  )}

                  {running && !assistantHasText && (
                    <Message from="assistant">
                      <MessageAuthor agent={agent} />
                      <MessageContent>
                        <Loader label={`${agent.name} is working`} />
                      </MessageContent>
                    </Message>
                  )}

                  {error && (
                    <Alert variant="destructive" className="w-full">
                      <Icon name="alert" size={14} />
                      <AlertDescription>{error.message}</AlertDescription>
                    </Alert>
                  )}
                </ConversationContent>
                <ConversationScrollButton />
              </Conversation>
            </PanelContent>
            <PanelContent className="shrink-0 p-3" flush>
              <PromptInput onSubmit={handleSubmit} className="group gap-2">
                <PromptInputTextarea
                  placeholder={`Give ${agent.name} a task…`}
                  aria-label={`Task for ${agent.name}`}
                />
                <ComposerFooter status={status} onStop={stop} />
              </PromptInput>
            </PanelContent>
          </Panel>

          <ActivityRail message={assistantMessage} running={running} />
        </div>
      </PromptInputProvider>
    </Page>
  );
}
