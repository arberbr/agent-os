import { useEffect, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { deleteAgent, listAgents } from '../api';
import { Icon } from '../components/Icon';
import { AgentRow } from '../components/app/agent-row';
import { EmptyState } from '../components/app/empty-state';
import { Page, PageActions, PageDescription, PageHeadMain, PageHeader, PageTitle } from '../components/app/page';
import { Panel, PanelContent, PanelHeader, PanelNote, PanelTitle } from '../components/app/panel';
import { SignalChip } from '../components/app/chips';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Skeleton } from '../components/ui/skeleton';
import { plural } from '../format';
import type { AgentDef } from '../types';

export default function Agents() {
  const navigate = useNavigate();
  const [agents, setAgents] = useState<AgentDef[]>([]);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = () => {
    void listAgents()
      .then(setAgents)
      .catch(() => setAgents([]))
      .finally(() => setLoading(false));
  };

  useEffect(reload, []);

  const onDelete = async (id: string) => {
    await deleteAgent(id);
    setConfirmId(null);
    reload();
  };

  const teamMembers = new Set(agents.flatMap((a) => a.teamAgentIds));

  return (
    <Page>
      <PageHeader>
        <PageHeadMain>
          <PageTitle>Agents</PageTitle>
          <PageDescription>
            Specialists with their own instructions and tools. Any agent can delegate work to the others on its team.
          </PageDescription>
        </PageHeadMain>
        <PageActions>
          <Button onClick={() => navigate({ to: '/agents/new' })}>
            <Icon name="plus" size={14} /> New agent
          </Button>
        </PageActions>
      </PageHeader>

      {loading ? (
        <Panel>
          <PanelContent className="flex flex-col gap-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </PanelContent>
        </Panel>
      ) : agents.length === 0 ? (
        <Panel>
          <EmptyState
            icon="agents"
            title="No agents yet"
            description="An agent is a persona with instructions, a set of tools and optionally a team it can delegate to."
          >
            <Button onClick={() => navigate({ to: '/agents/new' })}>
              <Icon name="plus" size={14} /> Create your first agent
            </Button>
          </EmptyState>
        </Panel>
      ) : (
        <Panel>
          <PanelHeader>
            <div className="flex items-baseline gap-2.5">
              <PanelTitle>Roster</PanelTitle>
              <PanelNote>{plural(agents.length, 'agent')}</PanelNote>
            </div>
          </PanelHeader>
          <PanelContent flush>
            <div>
              {agents.map((agent) => (
                <div
                  key={agent.id}
                  className="row flex flex-wrap items-center gap-3.5 border-t border-rule px-5 py-3 transition-colors first:border-t-0 hover:bg-surface-2"
                >
                  <AgentRow
                    agent={agent}
                    side={
                      <>
                        <Badge variant="secondary">{plural(agent.enabledTools.length, 'tool')}</Badge>
                        {agent.model && (
                          <span className="hidden font-mono text-[11.5px] whitespace-nowrap text-mute xl:inline">
                            {agent.model}
                          </span>
                        )}
                        {agent.teamAgentIds.length > 0 && (
                          <SignalChip>Team of {agent.teamAgentIds.length + 1}</SignalChip>
                        )}
                        {teamMembers.has(agent.id) && <Badge variant="outline">Team member</Badge>}
                        <span className="ml-2 flex items-center gap-1.5">
                          <Button asChild>
                            <Link to="/agents/$id/run" params={{ id: agent.id }}>
                              <Icon name="play" size={14} /> Run
                            </Link>
                          </Button>
                          <Button variant="secondary" asChild>
                            <Link to="/agents/$id" params={{ id: agent.id }}>
                              Edit
                            </Link>
                          </Button>
                          {confirmId === agent.id ? (
                            <>
                              <Button variant="destructive" onClick={() => void onDelete(agent.id)}>
                                Delete
                              </Button>
                              <Button variant="secondary" onClick={() => setConfirmId(null)}>
                                Cancel
                              </Button>
                            </>
                          ) : (
                            <Button
                              variant="secondary"
                              size="icon"
                              onClick={() => setConfirmId(agent.id)}
                              title={`Delete ${agent.name}`}
                              aria-label={`Delete ${agent.name}`}
                            >
                              <Icon name="trash" size={14} />
                            </Button>
                          )}
                        </span>
                      </>
                    }
                  />
                </div>
              ))}
            </div>
          </PanelContent>
        </Panel>
      )}
    </Page>
  );
}
