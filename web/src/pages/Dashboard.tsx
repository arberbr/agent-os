import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { listAgents, listRuns } from '../api';
import { useConfig } from '../App';
import { Icon } from '../components/Icon';
import { AgentRow } from '../components/app/agent-row';
import { Page, PageActions, PageDescription, PageHeadMain, PageHeader, PageTitle } from '../components/app/page';
import { Panel, PanelContent, PanelHeader, PanelNote, PanelTitle } from '../components/app/panel';
import { Button } from '../components/ui/button';
import { plural } from '../format';
import { cn } from '@/lib/utils';
import type { AgentDef, RunSummary } from '../types';

const HISTORY = 100;
const DAY_MS = 86_400_000;

/** Runs per day for the last `days` days, oldest first. Real counts. */
function weekBuckets(runs: RunSummary[], days = 7) {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const buckets = Array.from({ length: days }, (_, i) => {
    const start = midnight.getTime() - (days - 1 - i) * DAY_MS;
    return { start, count: 0 };
  });
  for (const run of runs) {
    const at = new Date(run.startedAt).getTime();
    if (Number.isNaN(at)) continue;
    const bucket = buckets.find((b) => at >= b.start && at < b.start + DAY_MS);
    if (bucket) bucket.count += 1;
  }
  return buckets.map((b) => ({
    count: b.count,
    label: new Date(b.start).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' }),
  }));
}

export default function Dashboard() {
  const cfg = useConfig();
  const navigate = useNavigate();
  const [agents, setAgents] = useState<AgentDef[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    void Promise.all([
      listAgents().catch(() => [] as AgentDef[]),
      listRuns(HISTORY).catch(() => [] as RunSummary[]),
    ]).then(([a, r]) => {
      if (!alive) return;
      setAgents(a);
      setRuns(r);
      setLoading(false);
    });
    return () => { alive = false; };
  }, []);

  const running = runs.filter((r) => r.status === 'running').length;
  const completed = runs.filter((r) => r.status === 'completed').length;
  const teams = agents.filter((a) => a.teamAgentIds.length > 0).length;
  const week = useMemo(() => weekBuckets(runs), [runs]);
  const weekTotal = week.reduce((sum, day) => sum + day.count, 0);
  const weekMax = Math.max(1, ...week.map((day) => day.count));
  const googleConnected = Boolean(cfg?.google.connected);

  const cell = cn(
    'border-rule px-5 py-4',
    'border-l first:border-l-0 [&:nth-child(3)]:border-l-0 lg:[&:nth-child(3)]:border-l',
    '[&:nth-child(n+3)]:border-t lg:[&:nth-child(n+3)]:border-t-0',
  );

  return (
    <Page>
      <PageHeader>
        <PageHeadMain>
          <PageTitle>Dashboard</PageTitle>
          <PageDescription>Who is on the team, what is running right now, and what finished recently.</PageDescription>
        </PageHeadMain>
        <PageActions>
          <Button onClick={() => navigate({ to: '/agents/new' })}>
            <Icon name="plus" size={14} /> New agent
          </Button>
        </PageActions>
      </PageHeader>

      <div className="flex flex-col gap-5">
        <div className="grid grid-cols-2 overflow-hidden rounded-2xl border border-border bg-card shadow-panel lg:grid-cols-4">
          <div className={cell}>
            <div className="text-[32px] leading-none font-semibold tracking-tight tabular-nums">
              {loading ? '–' : agents.length}
            </div>
            <div className="mt-1.5 text-[12.5px] text-muted-foreground">Agents</div>
            <div className="mt-2.5 text-[11.5px] text-mute">
              {agents.length === 0
                ? 'None yet'
                : teams > 0
                  ? `${teams} of ${agents.length} delegate to a team`
                  : 'No teams configured'}
            </div>
          </div>

          <div className={cn(cell, running > 0 && 'shadow-[inset_3px_0_0_var(--primary)]')}>
            <div className={cn('text-[32px] leading-none font-semibold tracking-tight tabular-nums', running > 0 && 'text-primary')}>
              {loading ? '–' : running}
            </div>
            <div className={cn('mt-1.5 text-[12.5px]', running > 0 ? 'text-primary' : 'text-muted-foreground')}>
              Running now
            </div>
            <div className="mt-2.5 text-[11.5px] text-mute">
              {running > 0 ? 'Streaming live activity' : 'Nothing in flight'}
            </div>
          </div>

          <div className={cell}>
            <div className="text-[32px] leading-none font-semibold tracking-tight tabular-nums">
              {loading ? '–' : completed}
            </div>
            <div className="mt-1.5 text-[12.5px] text-muted-foreground">Completed</div>
            <div className="mt-2.5 text-[11.5px] text-mute">
              {runs.length === 0 ? 'No runs yet' : `of ${plural(runs.length, 'recent run')}`}
            </div>
          </div>

          <div className={cell}>
            <div className="text-[32px] leading-none font-semibold tracking-tight tabular-nums">
              {loading ? '–' : weekTotal}
            </div>
            <div className="mt-1.5 text-[12.5px] text-muted-foreground">Runs this week</div>
            <div
              className="mt-3 flex h-[30px] items-end gap-1 border-b border-rule-2"
              role="img"
              aria-label={`Runs per day, last 7 days. ${week.map((day) => `${day.label}, ${plural(day.count, 'run')}`).join('. ')}`}
            >
              {week.map((day) => (
                <span
                  key={day.label}
                  className="flex h-full min-w-0 flex-1 items-end"
                  title={`${day.label}: ${plural(day.count, 'run')}`}
                >
                  <i
                    className={cn(
                      'block w-full rounded-t-[3px] bg-rule-2',
                      day.count > 0 && 'bg-primary',
                    )}
                    style={{
                      height: day.count === 0 ? 0 : `${Math.max(16, Math.round((day.count / weekMax) * 100))}%`,
                    }}
                  />
                </span>
              ))}
            </div>
          </div>
        </div>

        {!loading && agents.length === 0 && (
          <Panel>
            <PanelHeader>
              <div className="flex flex-col gap-0.5">
                <PanelTitle>Set up your first agent</PanelTitle>
                <PanelNote>Three steps.</PanelNote>
              </div>
            </PanelHeader>
            <PanelContent>
              <div className="grid gap-5 sm:grid-cols-3">
                <div className="flex gap-3">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-lg border border-signal-line bg-signal-soft text-[11.5px] font-semibold text-primary tabular-nums">
                    1
                  </span>
                  <div>
                    <div className="text-[13.5px] font-medium">Create the agent</div>
                    <div className="mt-0.5 text-[12.5px] text-mute">Give it a name, a role and instructions.</div>
                  </div>
                </div>
                <div className="flex gap-3">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-lg border border-signal-line bg-signal-soft text-[11.5px] font-semibold text-primary tabular-nums">
                    2
                  </span>
                  <div>
                    <div className="text-[13.5px] font-medium">Choose its tools</div>
                    <div className="mt-0.5 text-[12.5px] text-mute">Gmail, Calendar, Drive, YouTube or memory.</div>
                  </div>
                </div>
                <div className="flex gap-3">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-lg border border-signal-line bg-signal-soft text-[11.5px] font-semibold text-primary tabular-nums">
                    3
                  </span>
                  <div>
                    <div className="text-[13.5px] font-medium">Give it a task</div>
                    <div className="mt-0.5 text-[12.5px] text-mute">Every tool call shows up in the activity log.</div>
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap gap-2 pt-6">
                <Button onClick={() => navigate({ to: '/agents/new' })}>
                  <Icon name="plus" size={14} /> Create your first agent
                </Button>
                {!googleConnected && (
                  <Button variant="secondary" onClick={() => navigate({ to: '/integrations' })}>
                    Connect Google
                  </Button>
                )}
              </div>
            </PanelContent>
          </Panel>
        )}

        {agents.length > 0 && (
          <Panel>
            <PanelHeader>
              <div className="flex items-baseline gap-2.5">
                <PanelTitle>Agents</PanelTitle>
                <PanelNote>{plural(agents.length, 'agent')}</PanelNote>
              </div>
              <Link
                to="/agents"
                className="text-[12.5px] font-medium text-muted-foreground transition-colors hover:text-primary"
              >
                All agents
              </Link>
            </PanelHeader>
            <PanelContent flush>
              <div>
                {agents.slice(0, 6).map((agent) => (
                  <Link
                    key={agent.id}
                    to="/agents/$id/run"
                    params={{ id: agent.id }}
                    className="row flex items-center gap-3.5 border-t border-rule px-5 py-3 text-foreground transition-colors first:border-t-0 hover:bg-surface-2 hover:text-foreground"
                  >
                    <AgentRow agent={agent} />
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
