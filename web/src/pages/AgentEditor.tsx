import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { createAgent, listAgents, updateAgent } from '../api';
import { useConfig } from '../App';
import { Icon, type IconName } from '../components/Icon';
import { Mark } from '../components/Mark';
import { Field } from '../components/app/field';
import { Page, PageActions, PageDescription, PageHeadMain, PageHeader, PageTitle } from '../components/app/page';
import { Panel, PanelContent, PanelHeader, PanelNote, PanelTitle } from '../components/app/panel';
import { WarnChip } from '../components/app/chips';
import { Button } from '../components/ui/button';
import { Checkbox } from '../components/ui/checkbox';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { plural } from '../format';
import { cn } from '@/lib/utils';
import type { AgentDef, ToolInfo } from '../types';

const COLORS = ['#2dd4bf', '#6bcb84', '#e3b457', '#e77c74', '#a78bfa', '#38bdf8', '#f472b6', '#a3e635'];

const TOOL_GROUPS: Array<{ title: string; prefix: string; icon: IconName }> = [
  { title: 'General', prefix: '', icon: 'wrench' },
  { title: 'Gmail', prefix: 'gmail', icon: 'mail' },
  { title: 'Calendar', prefix: 'calendar', icon: 'calendar' },
  { title: 'Drive', prefix: 'drive', icon: 'drive' },
  { title: 'YouTube', prefix: 'youtube', icon: 'youtube' },
  { title: 'GitHub', prefix: 'github', icon: 'github' },
  { title: 'Vercel', prefix: 'vercel', icon: 'vercel' },
  { title: 'Supabase', prefix: 'supabase', icon: 'supabase' },
];

function groupFor(tool: ToolInfo): string {
  if (tool.isTeam) return 'Team';
  if (tool.name.startsWith('memory') || tool.name === 'now') return 'General';
  for (const group of TOOL_GROUPS) {
    if (group.prefix && tool.name.startsWith(`${group.prefix}_`)) return group.title;
  }
  return 'General';
}

const GROUP_ICON: Record<string, IconName> = {
  General: 'wrench',
  Gmail: 'mail',
  Calendar: 'calendar',
  Drive: 'drive',
  YouTube: 'youtube',
  GitHub: 'github',
  Vercel: 'vercel',
  Supabase: 'supabase',
  Team: 'users',
};

function needsBadge(group: string, tools: ToolInfo[], cfg: NonNullable<ReturnType<typeof useConfig>>, which: 'google' | 'github' | 'vercel' | 'supabase'): boolean {
  if (group === 'General' || group === 'Team') return false;
  if (which === 'google') return tools.every((t) => t.requiresGoogle) && !cfg.google.connected;
  if (which === 'github') return tools.every((t) => t.requiresGithub) && !cfg.github.configured;
  if (which === 'vercel') return tools.every((t) => t.requiresVercel) && !cfg.vercel.configured;
  return tools.every((t) => t.requiresSupabase) && !cfg.supabase.configured;
}

export default function AgentEditor() {
  // This component is mounted on both /agents/new and /agents/$id.
  const { id } = useParams({ strict: false }) as { id?: string };
  const isEdit = Boolean(id);
  const navigate = useNavigate();
  const cfg = useConfig();
  const [agents, setAgents] = useState<AgentDef[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const nameRef = useRef<HTMLInputElement | null>(null);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [model, setModel] = useState('');
  const [color, setColor] = useState(COLORS[0]!);
  const [enabledTools, setEnabledTools] = useState<string[]>([]);
  const [teamAgentIds, setTeamAgentIds] = useState<string[]>([]);

  useEffect(() => {
    void listAgents().then((list) => {
      setAgents(list);
      if (!id) return;
      const existing = list.find((a) => a.id === id);
      if (!existing) return;
      setName(existing.name);
      setDescription(existing.description);
      setInstructions(existing.instructions);
      setModel(existing.model);
      setColor(existing.color);
      setEnabledTools(existing.enabledTools);
      setTeamAgentIds(existing.teamAgentIds);
      baseline.current = null;
    });
  }, [id]);

  // Warn before leaving with unsaved edits.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const snapshot = JSON.stringify({ name, description, instructions, model, color, enabledTools, teamAgentIds });
  const baseline = useRef<string | null>(null);

  // Capture the loaded state as the baseline so "dirty" means: edited by hand.
  useEffect(() => {
    if (baseline.current === null) baseline.current = snapshot;
    else setDirty(snapshot !== baseline.current);
  }, [snapshot]);

  const grouped = useMemo(() => {
    const map = new Map<string, ToolInfo[]>();
    for (const tool of cfg?.tools ?? []) {
      const group = groupFor(tool);
      map.set(group, [...(map.get(group) ?? []), tool]);
    }
    return [...map.entries()];
  }, [cfg]);

  const toggleTool = (toolName: string) => {
    setEnabledTools((prev) => (prev.includes(toolName) ? prev.filter((t) => t !== toolName) : [...prev, toolName]));
  };
  const toggleTeam = (agentId: string) => {
    setTeamAgentIds((prev) => (prev.includes(agentId) ? prev.filter((t) => t !== agentId) : [...prev, agentId]));
  };

  const save = async () => {
    setError(null);
    if (!name.trim()) {
      setError('Enter a name for the agent, then save again.');
      nameRef.current?.focus();
      return;
    }
    setSaving(true);
    try {
      const payload = { name, description, instructions, model, color, enabledTools, teamAgentIds };
      if (isEdit && id) await updateAgent(id, payload);
      else await createAgent(payload);
      setDirty(false);
      navigate({ to: '/agents' });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  const others = agents.filter((a) => a.id !== id);

  return (
    <Page>
      <PageHeader>
        <PageHeadMain>
          <div className="flex items-center gap-3">
            <Mark name={name || 'New Agent'} color={color} size="lg" />
            <div>
              <PageTitle>{name.trim() || (isEdit ? 'Untitled agent' : 'New agent')}</PageTitle>
              <PageDescription className="mt-0.5">
                {plural(enabledTools.length, 'tool')} enabled
                {teamAgentIds.length > 0 && `, delegates to ${plural(teamAgentIds.length, 'agent')}`}
              </PageDescription>
            </div>
          </div>
        </PageHeadMain>
        <PageActions>
          <Button variant="secondary" onClick={() => navigate({ to: '/agents' })}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving} aria-busy={saving}>
            {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create agent'}
          </Button>
        </PageActions>
      </PageHeader>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_440px]">
        <div className="flex flex-col gap-5">
          <Panel>
            <PanelHeader>
              <PanelTitle>Persona</PanelTitle>
            </PanelHeader>
            <PanelContent>
              <Field label="Name" htmlFor="agent-name" error={error}>
                <Input
                  ref={nameRef}
                  id="agent-name"
                  name="name"
                  autoComplete="off"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Executive Assistant"
                  aria-invalid={Boolean(error)}
                  aria-describedby={error ? 'agent-name-error' : undefined}
                />
              </Field>
              <Field
                label={
                  <>
                    Description <span className="text-xs font-normal text-mute">one line, shown in lists</span>
                  </>
                }
                htmlFor="agent-desc"
              >
                <Input
                  id="agent-desc"
                  name="description"
                  autoComplete="off"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="e.g. Manages my inbox and calendar"
                />
              </Field>
              <Field
                label={
                  <>
                    Instructions{' '}
                    <span className="text-xs font-normal text-mute">the system prompt this agent always follows</span>
                  </>
                }
                htmlFor="agent-instructions"
              >
                <Textarea
                  id="agent-instructions"
                  className="min-h-48"
                  rows={12}
                  name="instructions"
                  autoComplete="off"
                  spellCheck
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  placeholder={
                    'How should this agent behave? For example:\nYou manage my inbox: triage unread mail, draft replies to routine messages, flag anything urgent.\nKeep my calendar conflict free. Propose times before creating events.\nWrite in a warm, concise tone. When in doubt, ask.'
                  }
                />
              </Field>
            </PanelContent>
          </Panel>

          <Panel>
            <PanelHeader>
              <PanelTitle>Model and identity</PanelTitle>
            </PanelHeader>
            <PanelContent>
              <Field
                label={
                  <>
                    Model override{' '}
                    <span className="text-xs font-normal text-mute">
                      optional, defaults to {cfg?.llm.model ?? 'the configured model'}
                    </span>
                  </>
                }
                htmlFor="agent-model"
              >
                <Input
                  id="agent-model"
                  name="model"
                  autoComplete="off"
                  spellCheck={false}
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder={cfg?.llm.model}
                />
              </Field>
              <div>
                <span className="mb-1.5 block w-fit text-[12.5px] font-medium">Colour</span>
                <div className="flex flex-wrap gap-2">
                  {COLORS.map((option) => (
                    <button
                      key={option}
                      className={cn(
                        'size-10 cursor-pointer rounded-lg border border-rule-2 transition-transform duration-150',
                        'hover:scale-105',
                        'aria-pressed:shadow-[0_0_0_2px_var(--ink),0_0_0_3px_var(--foreground)]',
                      )}
                      style={{ background: option }}
                      onClick={() => setColor(option)}
                      aria-label={`Colour ${option}`}
                      aria-pressed={color === option}
                    />
                  ))}
                </div>
              </div>
            </PanelContent>
          </Panel>
        </div>

        <div className="flex flex-col gap-5">
          <Panel>
            <PanelHeader>
              <div className="flex items-baseline gap-2.5">
                <PanelTitle>Tools</PanelTitle>
                <PanelNote>
                  {enabledTools.length} of {cfg?.tools.length ?? 0}
                </PanelNote>
              </div>
            </PanelHeader>
            <PanelContent className="flex flex-col gap-5">
              {grouped.map(([group, tools]) => (
                <div key={group}>
                  <div className="mb-1.5 flex items-center gap-2 border-b border-rule pb-2 text-[12.5px] text-muted-foreground">
                    <Icon name={GROUP_ICON[group] ?? 'wrench'} size={13} />
                    {group}
                    {cfg && needsBadge(group, tools, cfg, 'google') && <WarnChip>needs Google</WarnChip>}
                    {cfg && needsBadge(group, tools, cfg, 'github') && <WarnChip>needs GitHub token</WarnChip>}
                    {cfg && needsBadge(group, tools, cfg, 'vercel') && <WarnChip>needs Vercel token</WarnChip>}
                    {cfg && needsBadge(group, tools, cfg, 'supabase') && <WarnChip>needs Supabase keys</WarnChip>}
                    <span className="ml-auto text-mute tabular-nums">
                      {tools.filter((t) => enabledTools.includes(t.name)).length}/{tools.length}
                    </span>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    {tools.map((tool) => (
                      <label
                        key={tool.name}
                        className="flex cursor-pointer items-start gap-2.5 rounded-[9px] px-2 py-2 transition-colors hover:bg-surface-2"
                        title={tool.description}
                      >
                        <Checkbox
                          checked={enabledTools.includes(tool.name)}
                          onCheckedChange={() => toggleTool(tool.name)}
                        />
                        <span className="min-w-0">
                          <span className="block font-mono text-[12.5px] text-foreground">{tool.name}</span>
                          <span className="mt-0.5 block text-[11.5px] text-mute">
                            {tool.description.split('.')[0]}.
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </PanelContent>
          </Panel>

          <Panel>
            <PanelHeader>
              <div className="flex items-baseline gap-2.5">
                <PanelTitle>Team</PanelTitle>
                <PanelNote>agents this one can delegate to</PanelNote>
              </div>
            </PanelHeader>
            <PanelContent>
              {others.length === 0 ? (
                <p className="m-0 text-xs text-mute">No other agents yet. Create another one, then build a team.</p>
              ) : (
                <div className="flex flex-col gap-0.5">
                  {others.map((agent) => (
                    <label
                      key={agent.id}
                      className="flex cursor-pointer items-start gap-2.5 rounded-[9px] px-2 py-2 transition-colors hover:bg-surface-2"
                    >
                      <Checkbox
                        checked={teamAgentIds.includes(agent.id)}
                        onCheckedChange={() => toggleTeam(agent.id)}
                      />
                      <span className="flex items-center gap-2.5">
                        <Mark name={agent.name} color={agent.color} size="sm" />
                        <span className="text-[12.5px] text-foreground">{agent.name}</span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </PanelContent>
          </Panel>
        </div>
      </div>
    </Page>
  );
}
