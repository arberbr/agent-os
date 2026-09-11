import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { deleteRun, getRun, listAgents, listRuns } from '../api';
import { Icon } from '../components/Icon';
import { Markdown } from '../components/Markdown';
import { ActivityStep } from '../components/app/activity-step';
import { EmptyState } from '../components/app/empty-state';
import { Page, PageDescription, PageHeadMain, PageHeader, PageTitle } from '../components/app/page';
import { Panel, PanelContent, PanelHeader, PanelNote, PanelTitle } from '../components/app/panel';
import { StateRail } from '../components/app/state';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Skeleton } from '../components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { formatDateTime, formatDuration, plural, statusLabel, timeAgo } from '../format';
import { cn } from '@/lib/utils';
import type { AgentDef, RunDetail, RunStatus, RunSummary } from '../types';

const MAX_ROWS = 50;

type RunsSearch = { status?: 'completed' | 'failed' | 'running'; run?: string };

/** Statuses that are addressable in the URL ('cancelled' is not a filter). */
type StatusFilter = 'all' | 'completed' | 'failed' | 'running';

function statusTone(status: RunStatus): 'ok' | 'live' | 'fail' | 'idle' {
  if (status === 'completed') return 'ok';
  if (status === 'running') return 'live';
  if (status === 'failed') return 'fail';
  return 'idle';
}

const FILTERS: Array<{ key: StatusFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'completed', label: 'Completed' },
  { key: 'failed', label: 'Failed' },
  { key: 'running', label: 'Running' },
];

const backLink =
  'mb-2 inline-block text-[12.5px] font-medium text-muted-foreground transition-colors hover:text-primary';

/* ── One run, on its own screen ────────────────────────────────────────── */

function RunScreen({
  run,
  agent,
  loading,
  error,
  statusFilter,
  onDelete,
  deleting,
}: {
  run: RunDetail | null;
  agent: AgentDef | null;
  loading: boolean;
  error: string | null;
  statusFilter: StatusFilter;
  onDelete: (id: string) => void;
  deleting: boolean;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const duration = run ? formatDuration(run.startedAt, run.finishedAt) : null;

  if (loading) {
    return (
      <Page>
        <PageHeader>
          <PageHeadMain>
            <PageTitle>Loading run…</PageTitle>
          </PageHeadMain>
        </PageHeader>
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,1fr)]">
          <Panel>
            <PanelContent>
              <Skeleton className="h-32 w-full" />
            </PanelContent>
          </Panel>
          <Panel>
            <PanelContent>
              <Skeleton className="h-32 w-full" />
            </PanelContent>
          </Panel>
        </div>
      </Page>
    );
  }

  if (!run) {
    return (
      <Page>
        <PageHeader>
          <PageHeadMain>
            <Link
              to="/runs"
              search={{ status: statusFilter === 'all' ? undefined : statusFilter }}
              className={backLink}
            >
              All runs
            </Link>
            <PageTitle>Run not found</PageTitle>
            <PageDescription>{error ?? 'This run is no longer in the history.'}</PageDescription>
          </PageHeadMain>
        </PageHeader>
        <Button asChild>
          <Link to="/runs" search={{ status: statusFilter === 'all' ? undefined : statusFilter }}>
            Back to run history
          </Link>
        </Button>
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader>
        <PageHeadMain>
          <Link
            to="/runs"
            search={{ status: statusFilter === 'all' ? undefined : statusFilter }}
            className={backLink}
          >
            All runs
          </Link>
          <PageTitle>{run.title}</PageTitle>
          <div className="mt-2 flex flex-wrap items-center gap-x-0 gap-y-2 text-xs text-mute">
            <span className="pr-2.5">
              <StateRail tone={statusTone(run.status)}>{statusLabel(run.status)}</StateRail>
            </span>
            <span className="border-l border-rule-2 px-2.5">{agent ? agent.name : 'Deleted agent'}</span>
            {duration && <span className="border-l border-rule-2 px-2.5">{duration}</span>}
            <span title={run.id} className="border-l border-rule-2 px-2.5 font-mono">
              run {run.id.slice(0, 8)}
            </span>
            <span className="border-l border-rule-2 px-2.5">{formatDateTime(run.startedAt)}</span>
          </div>
        </PageHeadMain>
        <div className="flex flex-wrap items-center gap-2.5 pb-0.5">
          {agent ? (
            <Button asChild>
              <Link to="/agents/$id/run" params={{ id: agent.id }}>
                <Icon name="play" size={14} /> Run again
              </Link>
            </Button>
          ) : (
            <Badge variant="outline" title="The agent that produced this run no longer exists">
              agent deleted
            </Badge>
          )}
          {confirmDelete ? (
            <>
              <Button variant="destructive" onClick={() => onDelete(run.id)} disabled={deleting}>
                {deleting ? 'Removing…' : 'Remove run'}
              </Button>
              <Button variant="secondary" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button
              variant="secondary"
              size="icon"
              onClick={() => setConfirmDelete(true)}
              aria-label="Remove this run from the history"
              title="Remove this run from the history"
            >
              <Icon name="trash" size={16} />
            </Button>
          )}
        </div>
      </PageHeader>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-5">
          {run.error && (
            <Alert variant="destructive">
              <Icon name="alert" size={14} />
              <AlertDescription>{run.error}</AlertDescription>
            </Alert>
          )}

          <Panel>
            <PanelHeader>
              <div className="flex items-baseline gap-2.5">
                <PanelTitle>Output</PanelTitle>
                <PanelNote>{plural(run.steps.length, 'step')}</PanelNote>
              </div>
            </PanelHeader>
            <PanelContent>
              {run.output ? (
                <Markdown>{run.output}</Markdown>
              ) : (
                <EmptyState
                  icon="file"
                  title="No output recorded"
                  description="This run finished without a final answer. Its steps are on the right."
                />
              )}
            </PanelContent>
          </Panel>
        </div>

        <Panel aria-label="Run activity">
          <PanelHeader>
            <div className="flex items-baseline gap-2.5">
              <PanelTitle>Activity</PanelTitle>
              <PanelNote>{run.steps.length > 0 ? plural(run.steps.length, 'step') : 'none'}</PanelNote>
            </div>
          </PanelHeader>
          <PanelContent flush>
            <div
              className="max-h-[calc(100dvh-280px)] overflow-y-auto max-lg:max-h-none"
              role="log"
              aria-label="Run activity"
            >
              {run.steps.length === 0 ? (
                <EmptyState icon="runs" title="No steps recorded" />
              ) : (
                run.steps.map((step, i) => <ActivityStep key={i} step={step} resultLimit={200} />)
              )}
            </div>
          </PanelContent>
        </Panel>
      </div>
    </Page>
  );
}

/* ── History list ──────────────────────────────────────────────────────── */

export default function Runs() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [agents, setAgents] = useState<AgentDef[]>([]);
  const [selected, setSelected] = useState<RunDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const search = useSearch({ from: '/runs' }) as RunsSearch;
  const navigate = useNavigate();

  const filter: StatusFilter = search.status ?? 'all';
  const selectedId = search.run;

  /**
   * Remove a session. The row disappears from local state rather than
   * refetching, and when the deleted run is the one on screen we leave it.
   */
  const removeRun = async (id: string) => {
    setDeleteError(null);
    setDeletingId(id);
    try {
      await deleteRun(id);
      setRuns((prev) => prev.filter((r) => r.id !== id));
      setSelected((prev) => (prev?.id === id ? null : prev));
      setConfirmId(null);
      if (selectedId === id) {
        void navigate({ to: '/runs', search: { status: search.status }, replace: true });
      }
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingId(null);
    }
  };

  useEffect(() => {
    void listRuns(100)
      .then(setRuns)
      .catch(() => setRuns([]))
      .finally(() => setLoading(false));
    // Needed to tell a live agent from one that has since been deleted.
    void listAgents().then(setAgents).catch(() => setAgents([]));
  }, []);

  // The open run lives in the URL, so a run can be linked and reloaded.
  useEffect(() => {
    if (!selectedId) {
      setSelected(null);
      setDetailError(null);
      return;
    }
    if (selected?.id === selectedId) return;
    let alive = true;
    setLoadingDetail(true);
    setDetailError(null);
    void getRun(selectedId)
      .then((detail) => {
        if (alive) setSelected(detail);
      })
      .catch(() => {
        if (!alive) return;
        setSelected(null);
        setDetailError('This run could not be loaded. It may have been deleted.');
      })
      .finally(() => {
        if (alive) setLoadingDetail(false);
      });
    return () => {
      alive = false;
    };
  }, [selectedId, selected?.id]);

  const counts = useMemo(() => {
    const base: Record<string, number> = { all: runs.length };
    for (const run of runs) base[run.status] = (base[run.status] ?? 0) + 1;
    return base;
  }, [runs]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return runs.filter((run) => {
      if (filter !== 'all' && run.status !== filter) return false;
      if (!q) return true;
      return run.title.toLowerCase().includes(q) || run.agentName.toLowerCase().includes(q);
    });
  }, [runs, filter, query]);

  const shown = visible.slice(0, MAX_ROWS);

  const setFilter = (next: StatusFilter) => {
    void navigate({
      to: '/runs',
      search: { status: next === 'all' ? undefined : next },
      replace: true,
    });
  };

  if (selectedId) {
    const agent = agents.find((a) => a.id === selected?.agentId) ?? null;
    return (
      <RunScreen
        run={selected}
        agent={agent}
        loading={loadingDetail}
        error={detailError}
        statusFilter={filter}
        onDelete={(id) => void removeRun(id)}
        deleting={deletingId !== null}
      />
    );
  }

  return (
    <Page>
      <PageHeader>
        <PageHeadMain>
          <PageTitle>Runs</PageTitle>
          <PageDescription>Every agent execution with its tool activity, timing and final output.</PageDescription>
        </PageHeadMain>
      </PageHeader>

      {loading ? (
        <Panel>
          <PanelContent className="flex flex-col gap-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </PanelContent>
        </Panel>
      ) : runs.length === 0 ? (
        <Panel>
          <EmptyState
            icon="runs"
            title="No runs yet"
            description="Open an agent, give it a task, and its full trace lands here."
          >
            <Button asChild>
              <Link to="/agents">Go to agents</Link>
            </Button>
          </EmptyState>
        </Panel>
      ) : (
        <>
          {deleteError && (
            <Alert variant="destructive" className="mb-4">
              <Icon name="alert" size={14} />
              <AlertDescription>{deleteError}</AlertDescription>
            </Alert>
          )}

          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="inline-flex h-10 gap-0.5 rounded-full border border-border bg-card p-0.5">
              {FILTERS.map((entry) => (
                <button
                  key={entry.key}
                  className={cn(
                    'group flex h-full cursor-pointer items-center rounded-full border-none bg-transparent px-3.5 font-sans text-[12.5px] font-medium text-muted-foreground transition-colors duration-150',
                    'hover:bg-surface-2 hover:text-foreground',
                    'aria-pressed:bg-primary aria-pressed:font-semibold aria-pressed:text-primary-foreground',
                  )}
                  onClick={() => setFilter(entry.key)}
                  aria-pressed={filter === entry.key}
                >
                  {entry.label}
                  <span className="ml-1.5 tabular-nums text-mute group-aria-pressed:text-primary-foreground/70">
                    {counts[entry.key] ?? 0}
                  </span>
                </button>
              ))}
            </div>
            <label className="flex h-10 min-w-[230px] items-center gap-2 rounded-full border border-border bg-card px-2.5 text-mute transition-[border-color,box-shadow] duration-150 focus-within:border-primary focus-within:shadow-[0_0_0_3px_var(--signal-soft)]">
              <Icon name="search" size={13} />
              <input
                type="search"
                name="q"
                autoComplete="off"
                spellCheck={false}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search task or agent…"
                aria-label="Search runs"
                className="w-full border-none bg-transparent p-0 font-sans text-[12.5px] text-foreground outline-none placeholder:text-mute"
              />
            </label>
          </div>

          <Panel>
            <PanelContent flush>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Status</TableHead>
                    <TableHead>Task</TableHead>
                    <TableHead>Agent</TableHead>
                    <TableHead>Steps</TableHead>
                    <TableHead>Started</TableHead>
                    <TableHead className="w-0">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shown.map((run) => (
                    <TableRow key={run.id}>
                      <TableCell>
                        <StateRail tone={statusTone(run.status)}>{statusLabel(run.status)}</StateRail>
                      </TableCell>
                      <TableCell className="font-medium">
                        <Link
                          to="/runs"
                          search={{ status: search.status, run: run.id }}
                          className="block max-w-[340px] truncate text-foreground hover:text-primary"
                        >
                          {run.title}
                        </Link>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        <span className="inline-flex items-center gap-2">
                          {run.agentName}
                          {!agents.some((a) => a.id === run.agentId) && (
                            <Badge variant="outline" title="This agent no longer exists">
                              deleted
                            </Badge>
                          )}
                        </span>
                      </TableCell>
                      <TableCell className="tabular-nums">{run.steps}</TableCell>
                      <TableCell className="tabular-nums text-mute" title={formatDateTime(run.startedAt)}>
                        {timeAgo(run.startedAt)}
                      </TableCell>
                      <TableCell className="text-right">
                        {confirmId === run.id ? (
                          <span className="inline-flex items-center gap-1.5">
                            <Button
                              variant="destructive"
                              size="sm"
                              onClick={() => void removeRun(run.id)}
                              disabled={deletingId === run.id}
                            >
                              {deletingId === run.id ? 'Removing…' : 'Remove'}
                            </Button>
                            <Button variant="secondary" size="sm" onClick={() => setConfirmId(null)}>
                              Cancel
                            </Button>
                          </span>
                        ) : (
                          <Button
                            variant="secondary"
                            size="icon-sm"
                            onClick={() => setConfirmId(run.id)}
                            aria-label={`Remove "${run.title}" from the history`}
                            title="Remove from the history"
                          >
                            <Icon name="trash" size={16} />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {visible.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                        No runs match this filter.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </PanelContent>
            {visible.length > shown.length && (
              <div className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
                Showing {shown.length} of {visible.length} runs. Filter by status or search to narrow the list.
              </div>
            )}
          </Panel>
        </>
      )}
    </Page>
  );
}
