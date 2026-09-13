import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  createSchedule, deleteSchedule, listAgents, listSchedules, previewSchedule, runScheduleNow,
  updateSchedule,
} from '../api';
import { useConfig } from '../App';
import { Icon } from '../components/Icon';
import { Mark } from '../components/Mark';
import { EmptyState } from '../components/app/empty-state';
import { Field } from '../components/app/field';
import { Page, PageActions, PageDescription, PageHeadMain, PageHeader, PageTitle } from '../components/app/page';
import { Panel, PanelContent, PanelHeader, PanelNote, PanelTitle } from '../components/app/panel';
import { SignalChip } from '../components/app/chips';
import { StateRail } from '../components/app/state';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Button } from '../components/ui/button';
import { Checkbox } from '../components/ui/checkbox';
import { Input } from '../components/ui/input';
import { Skeleton } from '../components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Textarea } from '../components/ui/textarea';
import { formatDateTime, formatWeekdayDateTime, plural, statusLabel, timeAgo, timeUntil } from '../format';
import { cn } from '@/lib/utils';
import type { AgentDef, Schedule, ScheduleNotifyOn, SchedulePreview } from '../types';
import { NOTIFY_LABELS, NOTIFY_MODES, NOTIFY_NOTES } from '../types';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** The console re-reads the list on this beat so "next run" and "running" stay live. */
const POLL_MS = 15_000;

/* ── Cadence: presets, their cron, and the way back ────────────────────── */

type PresetKey = 'minutes' | 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'custom';

const PRESETS: Array<{ key: PresetKey; label: string }> = [
  { key: 'minutes', label: 'Every N minutes' },
  { key: 'hourly', label: 'Hourly' },
  { key: 'daily', label: 'Daily' },
  { key: 'weekdays', label: 'Weekdays' },
  { key: 'weekly', label: 'Weekly' },
  { key: 'monthly', label: 'Monthly' },
  { key: 'custom', label: 'Custom cron' },
];

/** The editor's cadence controls. Always compiles down to one cron string. */
interface Cadence {
  preset: PresetKey;
  everyMinutes: number;
  /** 'HH:MM', used by hourly (minutes only), daily, weekdays, weekly, monthly. */
  time: string;
  weekday: number;
  dayOfMonth: number;
  custom: string;
}

const DEFAULT_CADENCE: Cadence = {
  preset: 'weekdays',
  everyMinutes: 15,
  time: '09:00',
  weekday: 1,
  dayOfMonth: 1,
  custom: '0 9 * * 1-5',
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(value), min), max);
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** 'HH:MM' → usable hour/minute numbers, with a sane fallback. */
function splitTime(time: string): { hour: number; minute: number } {
  const [rawHour, rawMinute] = time.split(':');
  const hour = Number(rawHour);
  const minute = Number(rawMinute);
  return {
    hour: Number.isFinite(hour) ? clamp(hour, 0, 23) : 9,
    minute: Number.isFinite(minute) ? clamp(minute, 0, 59) : 0,
  };
}

function cronFor(cadence: Cadence): string {
  const { hour, minute } = splitTime(cadence.time);
  switch (cadence.preset) {
    case 'minutes':
      return cadence.everyMinutes <= 1 ? '* * * * *' : `*/${clamp(cadence.everyMinutes, 1, 59)} * * * *`;
    case 'hourly':
      return `${minute} * * * *`;
    case 'daily':
      return `${minute} ${hour} * * *`;
    case 'weekdays':
      return `${minute} ${hour} * * 1-5`;
    case 'weekly':
      return `${minute} ${hour} * * ${cadence.weekday}`;
    case 'monthly':
      return `${minute} ${hour} ${clamp(cadence.dayOfMonth, 1, 31)} * *`;
    case 'custom':
      return cadence.custom.trim();
  }
}

/**
 * Reverse-map a stored expression onto the controls, so re-opening a schedule
 * shows the cadence it was written with. Anything not shaped like a preset
 * opens in Custom cron with the expression intact — never approximated.
 */
function cadenceFromCron(cron: string, fallback: Cadence): Cadence {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return { ...fallback, preset: 'custom', custom: cron };
  const [minute = '', hour = '', dom = '', month = '', dow = ''] = parts;
  const fixedTime = /^\d+$/.test(minute) && /^\d+$/.test(hour)
    ? `${pad2(Number(hour))}:${pad2(Number(minute))}`
    : fallback.time;
  const plainDays = month === '*' && dom === '*' && dow === '*';

  if (minute === '*' && hour === '*' && plainDays) return { ...fallback, preset: 'minutes', everyMinutes: 1 };
  const step = /^\*\/(\d+)$/.exec(minute);
  if (step && hour === '*' && plainDays) {
    return { ...fallback, preset: 'minutes', everyMinutes: Number(step[1]) };
  }
  if (/^\d+$/.test(minute) && hour === '*' && plainDays) {
    return { ...fallback, preset: 'hourly', time: `${fallback.time.split(':')[0]}:${pad2(Number(minute))}` };
  }
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour)) {
    if (month === '*' && dom === '*' && dow === '*') return { ...fallback, preset: 'daily', time: fixedTime };
    if (month === '*' && dom === '*' && dow === '1-5') return { ...fallback, preset: 'weekdays', time: fixedTime };
    if (month === '*' && dom === '*' && /^\d$/.test(dow)) {
      return { ...fallback, preset: 'weekly', time: fixedTime, weekday: Number(dow) % 7 };
    }
    if (month === '*' && /^\d+$/.test(dom) && dow === '*') {
      return { ...fallback, preset: 'monthly', time: fixedTime, dayOfMonth: Number(dom) };
    }
  }
  return { ...fallback, preset: 'custom', custom: cron };
}

/* ── Editor ────────────────────────────────────────────────────────────── */

/**
 * The schedule editor — one panel, used for both "new" and "edit".
 *
 * It always writes a cron expression; the presets are a friendlier way to
 * build one. The server validates what comes out and returns the next few
 * firing times, which are shown live under the cadence controls.
 */
function ScheduleEditor({
  agents,
  editing,
  mailConfigured,
  onClose,
  onSaved,
}: {
  agents: AgentDef[];
  editing: Schedule | null;
  /** Whether an SMTP relay is available, so the notify picker can explain itself. */
  mailConfigured: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const knownAgent = editing ? agents.some((a) => a.id === editing.agentId) : false;
  const [agentId, setAgentId] = useState(editing?.agentId ?? agents[0]?.id ?? '');
  const [name, setName] = useState(editing?.name ?? '');
  const [input, setInput] = useState(editing?.input ?? '');
  const [cadence, setCadence] = useState<Cadence>(
    editing ? cadenceFromCron(editing.cron, DEFAULT_CADENCE) : DEFAULT_CADENCE,
  );
  const [enabled, setEnabled] = useState(editing?.enabled ?? true);
  const [notifyOn, setNotifyOn] = useState<ScheduleNotifyOn>(editing?.notifyOn ?? 'never');
  const [notifyEmails, setNotifyEmails] = useState((editing?.notifyEmails ?? []).join(', '));
  const [preview, setPreview] = useState<SchedulePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const cron = cronFor(cadence);

  // Ask the server what this cadence means, including when it next fires.
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      void previewSchedule(cron)
        .then((result) => {
          if (alive) setPreview(result);
        })
        .catch(() => {
          if (alive) setPreview(null);
        });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [cron]);

  const invalid = preview !== null && !preview.valid;
  const agent = agents.find((a) => a.id === agentId);

  const save = async () => {
    setError(null);
    if (!agentId) {
      setError('Pick the agent this schedule should run.');
      return;
    }
    if (!input.trim()) {
      setError('Describe the task the agent should work on.');
      return;
    }
    if (preview && !preview.valid) {
      setError(preview.error ?? 'That cadence is not valid.');
      return;
    }
    setSaving(true);
    try {
      const recipients = notifyEmails
        .split(',')
        .map((email) => email.trim())
        .filter(Boolean);
      const payload = { agentId, name, input, cron, enabled, notifyOn, notifyEmails: recipients };
      if (editing) await updateSchedule(editing.id, payload);
      else await createSchedule(payload);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  return (
    <Panel>
      <PanelHeader>
        <div className="flex items-baseline gap-2.5">
          <PanelTitle>{editing ? 'Edit schedule' : 'New schedule'}</PanelTitle>
          <PanelNote>{editing ? editing.label : 'an agent, a task, a cadence'}</PanelNote>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close the editor">
          <Icon name="close" size={15} />
        </Button>
      </PanelHeader>
      <PanelContent>
        <div className="grid gap-x-8 gap-y-0 lg:grid-cols-2">
          <div>
            <Field label="Agent" hint="who runs it">
              <div
                role="radiogroup"
                aria-label="Agent"
                className="max-h-52 overflow-y-auto rounded-md border border-input bg-inset p-1"
              >
                {agents.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={agentId === option.id}
                    onClick={() => setAgentId(option.id)}
                    className={cn(
                      'flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors duration-150',
                      agentId === option.id ? 'bg-signal-soft' : 'hover:bg-surface-2',
                    )}
                  >
                    <Mark name={option.name} color={option.color} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] font-medium text-foreground">{option.name}</span>
                      {option.description && (
                        <span className="block truncate text-[11.5px] text-mute">{option.description}</span>
                      )}
                    </span>
                    {agentId === option.id && <Icon name="check" size={13} className="text-primary" />}
                  </button>
                ))}
                {agents.length === 0 && (
                  <p className="m-0 px-2 py-3 text-[12.5px] text-mute">No agents yet.</p>
                )}
              </div>
            </Field>

            <Field
              label="Task"
              hint="the message the agent receives on every run"
              htmlFor="schedule-input"
            >
              <Textarea
                id="schedule-input"
                className="min-h-28"
                rows={4}
                name="input"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={'What should it do each time?\nFor example: Triage my inbox — summarise anything unread, flag what needs a reply, and note anything with a deadline.'}
              />
            </Field>

            <Field
              label={
                <>
                  Name <span className="text-xs font-normal text-mute">optional, defaults to {agent?.name ?? 'the agent'}</span>
                </>
              }
              htmlFor="schedule-name"
            >
              <Input
                id="schedule-name"
                name="name"
                autoComplete="off"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Morning inbox triage"
              />
            </Field>
          </div>

          <div>
            <Field label="Cadence" hint="server local time">
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Cadence">
                {PRESETS.map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    aria-pressed={cadence.preset === option.key}
                    onClick={() => setCadence((prev) => ({ ...prev, preset: option.key }))}
                    className={cn(
                      'h-8 cursor-pointer rounded-full border border-border bg-card px-3 text-[12.5px] font-medium text-muted-foreground transition-colors duration-150',
                      'hover:bg-surface-2 hover:text-foreground',
                      'aria-pressed:border-primary aria-pressed:bg-primary aria-pressed:font-semibold aria-pressed:text-primary-foreground',
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>

              <div className="mt-3 flex flex-wrap items-end gap-3">
                {cadence.preset === 'minutes' && (
                  <label className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
                    <span>Every</span>
                    <Input
                      type="number"
                      min={1}
                      max={59}
                      className="w-20"
                      value={cadence.everyMinutes}
                      onChange={(e) => setCadence((prev) => ({ ...prev, everyMinutes: Number(e.target.value) }))}
                      aria-label="Minutes between runs"
                    />
                    <span>minutes</span>
                  </label>
                )}

                {cadence.preset === 'hourly' && (
                  <label className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
                    <span>At</span>
                    <Input
                      type="number"
                      min={0}
                      max={59}
                      className="w-20"
                      value={splitTime(cadence.time).minute}
                      onChange={(e) =>
                        setCadence((prev) => ({
                          ...prev,
                          time: `${prev.time.split(':')[0] ?? '00'}:${pad2(Number(e.target.value))}`,
                        }))
                      }
                      aria-label="Minutes past the hour"
                    />
                    <span>minutes past every hour</span>
                  </label>
                )}

                {(cadence.preset === 'daily' ||
                  cadence.preset === 'weekdays' ||
                  cadence.preset === 'weekly' ||
                  cadence.preset === 'monthly') && (
                  <label className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
                    <span>At</span>
                    <Input
                      type="time"
                      className="w-28"
                      value={cadence.time}
                      onChange={(e) => setCadence((prev) => ({ ...prev, time: e.target.value || prev.time }))}
                      aria-label="Time of day"
                    />
                  </label>
                )}

                {cadence.preset === 'weekly' && (
                  <div className="flex flex-wrap gap-1" role="group" aria-label="Day of the week">
                    {WEEKDAYS.map((day, index) => (
                      <button
                        key={day}
                        type="button"
                        aria-pressed={cadence.weekday === index}
                        onClick={() => setCadence((prev) => ({ ...prev, weekday: index }))}
                        className={cn(
                          'size-8 cursor-pointer rounded-full border border-border bg-card text-[11.5px] font-medium text-muted-foreground transition-colors duration-150',
                          'hover:bg-surface-2 hover:text-foreground',
                          'aria-pressed:border-primary aria-pressed:bg-primary aria-pressed:font-semibold aria-pressed:text-primary-foreground',
                        )}
                        title={day}
                      >
                        {day.slice(0, 2)}
                      </button>
                    ))}
                  </div>
                )}

                {cadence.preset === 'monthly' && (
                  <label className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
                    <span>on day</span>
                    <Input
                      type="number"
                      min={1}
                      max={31}
                      className="w-20"
                      value={cadence.dayOfMonth}
                      onChange={(e) => setCadence((prev) => ({ ...prev, dayOfMonth: Number(e.target.value) }))}
                      aria-label="Day of the month"
                    />
                  </label>
                )}

                {cadence.preset === 'custom' && (
                  <Input
                    className="w-full font-mono"
                    value={cadence.custom}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(e) => setCadence((prev) => ({ ...prev, custom: e.target.value }))}
                    aria-label="Cron expression"
                    aria-invalid={invalid}
                    placeholder="minute hour day-of-month month day-of-week"
                  />
                )}
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
                {preview?.valid ? (
                  <>
                    <StateRail tone="ok">{preview.description}</StateRail>
                    <span className="text-mute">
                      next {preview.next.map((stamp) => formatWeekdayDateTime(stamp)).join(' · ')}
                    </span>
                  </>
                ) : preview ? (
                  <span className="flex items-center gap-1.5 text-danger" role="alert">
                    <Icon name="alert" size={12} /> {preview.error}
                  </span>
                ) : (
                  <span className="text-mute">Checking the cadence…</span>
                )}
              </div>
            </Field>

            <Field label="State">
              <label className="flex cursor-pointer items-start gap-2.5 rounded-md px-1 py-1.5">
                <Checkbox
                  id="schedule-enabled"
                  checked={enabled}
                  onCheckedChange={(checked) => setEnabled(checked === true)}
                />
                <span>
                  <span className="block text-[12.5px] font-medium text-foreground">Run on this cadence</span>
                  <span className="mt-0.5 block text-[11.5px] text-mute">
                    Unchecked saves it paused — Run now still works.
                  </span>
                </span>
              </label>
            </Field>

            <Field label="Notify by email" hint="after a run finishes">
              <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Email notifications">
                {NOTIFY_MODES.map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={notifyOn === mode}
                    onClick={() => setNotifyOn(mode)}
                    className={cn(
                      'h-8 cursor-pointer rounded-full border border-border bg-card px-3 text-[12.5px] font-medium text-muted-foreground transition-colors duration-150',
                      'hover:bg-surface-2 hover:text-foreground',
                      'aria-checked:border-primary aria-checked:bg-primary aria-checked:font-semibold aria-checked:text-primary-foreground',
                    )}
                  >
                    {NOTIFY_LABELS[mode]}
                  </button>
                ))}
              </div>
              <p className="mt-2 mb-0 text-[11.5px] text-mute">{NOTIFY_NOTES[notifyOn]}</p>
            </Field>

            {notifyOn !== 'never' && (
              <Field
                label="Also send to"
                hint="optional, comma separated"
                htmlFor="schedule-notify-emails"
              >
                <Input
                  id="schedule-notify-emails"
                  value={notifyEmails}
                  onChange={(e) => setNotifyEmails(e.target.value)}
                  placeholder="team@example.com, oncall@example.com"
                  spellCheck={false}
                  autoComplete="off"
                />
                <span className="mt-1.5 block text-[11.5px] text-mute">
                  {editing
                    ? editing.createdByEmail
                      ? `${editing.createdByEmail} is always notified. `
                      : editing.notifyRecipients.length > 0
                        ? 'This schedule has no creator account, so only the addresses above are notified. '
                        : 'No creator account and no addresses — nobody would be notified. '
                    : 'You are always notified. '}
                  Runs started by hand (<em>Run now</em>) are reported too.
                </span>
              </Field>
            )}

            {notifyOn !== 'never' && !mailConfigured && (
              <Alert variant="warning" className="mb-[18px]">
                <Icon name="alert" size={14} />
                <AlertTitle>No email relay is set up yet</AlertTitle>
                <AlertDescription>
                  An administrator can add SMTP credentials under <strong>Settings → Email notifications</strong>.
                  Until then this schedule will not be able to report anything.
                </AlertDescription>
              </Alert>
            )}

            {editing?.lastNotifyError && notifyOn !== 'never' && (
              <Alert variant="warning" className="mb-[18px]">
                <Icon name="alert" size={14} />
                <AlertTitle>The last notification did not go out</AlertTitle>
                <AlertDescription>{editing.lastNotifyError}</AlertDescription>
              </Alert>
            )}

            {editing && !knownAgent && (
              <Alert variant="warning" className="mb-[18px]">
                <Icon name="alert" size={14} />
                <AlertTitle>The agent for this schedule is gone</AlertTitle>
                <AlertDescription>Pick another agent above and save to revive it.</AlertDescription>
              </Alert>
            )}
            {error && (
              <Alert variant="destructive" className="mb-[18px]">
                <Icon name="alert" size={14} />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="flex flex-wrap items-center gap-2.5">
              <Button onClick={() => void save()} disabled={saving || invalid} aria-busy={saving}>
                {saving ? 'Saving…' : editing ? 'Save changes' : 'Create schedule'}
              </Button>
              <Button variant="secondary" onClick={onClose}>
                Cancel
              </Button>
              <span className="ml-auto font-mono text-[11.5px] text-mute" title="The cron expression that will be stored">
                {cron || '—'}
              </span>
            </div>
          </div>
        </div>
      </PanelContent>
    </Panel>
  );
}

/* ── Page ──────────────────────────────────────────────────────────────── */

export default function Schedules() {
  const cfg = useConfig();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [agents, setAgents] = useState<AgentDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [started, setStarted] = useState<{ scheduleId: string; runId: string } | null>(null);

  const load = useCallback(async () => {
    const [list, roster] = await Promise.all([listSchedules(), listAgents().catch(() => [] as AgentDef[])]);
    setSchedules(list);
    setAgents(roster);
  }, []);

  useEffect(() => {
    let alive = true;
    void load()
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    // The list is re-read on a beat: "next run" counts down and a run that the
    // engine started on its own shows up without a manual refresh.
    const id = setInterval(() => {
      if (alive) void load().catch(() => {});
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [load]);

  const armed = useMemo(() => schedules.filter((schedule) => schedule.enabled && schedule.nextRunAt), [schedules]);
  const nextUp = useMemo(() => {
    const sorted = [...armed].sort((a, b) => String(a.nextRunAt).localeCompare(String(b.nextRunAt)));
    return sorted[0] ?? null;
  }, [armed]);

  /** Toggle one schedule without disturbing the rest of the list. */
  const toggle = async (schedule: Schedule, enabled: boolean) => {
    setActionError(null);
    setBusyId(schedule.id);
    setSchedules((prev) => prev.map((s) => (s.id === schedule.id ? { ...s, enabled } : s)));
    try {
      const updated = await updateSchedule(schedule.id, { enabled });
      setSchedules((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
      await load().catch(() => {});
    } finally {
      setBusyId(null);
    }
  };

  const runNow = async (schedule: Schedule) => {
    setActionError(null);
    setStarted(null);
    setBusyId(schedule.id);
    try {
      const { runId, schedule: updated } = await runScheduleNow(schedule.id);
      setSchedules((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      setStarted({ scheduleId: schedule.id, runId });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (schedule: Schedule) => {
    setActionError(null);
    setBusyId(schedule.id);
    try {
      await deleteSchedule(schedule.id);
      setSchedules((prev) => prev.filter((s) => s.id !== schedule.id));
      setConfirmId(null);
      if (editing?.id === schedule.id) {
        setEditing(null);
        setEditorOpen(false);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const openNew = () => {
    setEditing(null);
    setEditorOpen(true);
  };
  const openEdit = (schedule: Schedule) => {
    setEditing(schedule);
    setEditorOpen(true);
  };

  const schedulerOff = cfg !== null && !cfg.scheduler.enabled;
  /** Whether scheduled runs can be reported by email at all. */
  const mailConfigured = cfg?.mail.configured ?? false;
  /** How many schedules want an email that cannot currently be sent. */
  const notifyWithoutRelay =
    cfg !== null && !mailConfigured ? schedules.filter((s) => s.notifyOn !== 'never').length : 0;

  return (
    <Page>
      <PageHeader>
        <PageHeadMain>
          <PageTitle>Schedules</PageTitle>
          <PageDescription>
            Recurring runs: an agent, a task and a cadence. The engine fires them from this server — no
            browser needs to be open, and every firing lands in the run history.
          </PageDescription>
        </PageHeadMain>
        <PageActions>
          <Button
            onClick={openNew}
            disabled={agents.length === 0 || schedulerOff}
            title={agents.length === 0 ? 'Create an agent first' : undefined}
          >
            <Icon name="plus" size={14} /> New schedule
          </Button>
        </PageActions>
      </PageHeader>

      <div className="flex flex-col gap-5">
        {schedulerOff && (
          <Alert variant="warning">
            <Icon name="alert" size={14} />
            <AlertTitle>The schedule engine is switched off</AlertTitle>
            <AlertDescription>
              Schedules are saved but never fire while <code>SCHEDULER_ENABLED=false</code>. Remove it (or set
              it to <code>true</code>) and restart the server to arm them.
            </AlertDescription>
          </Alert>
        )}

        {agents.length === 0 && !loading && (          <Alert variant="info">
            <Icon name="info" size={14} />
            <AlertTitle>No agents to schedule yet</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center gap-2">
              A schedule runs one agent. Create one, then come back.
              <Link to="/agents/new" className="font-medium">
                New agent
              </Link>
            </AlertDescription>
          </Alert>
        )}

        {notifyWithoutRelay && (
          <Alert variant="warning">
            <Icon name="alert" size={14} />
            <AlertTitle>{plural(notifyWithoutRelay, 'schedule')} asked for email but no relay is set up</AlertTitle>
            <AlertDescription>
              Add SMTP credentials under <strong>Settings → Email notifications</strong> to start receiving them.
              The runs themselves are unaffected.
            </AlertDescription>
          </Alert>
        )}

        {editorOpen && (
          <ScheduleEditor
            agents={agents}
            editing={editing}
            mailConfigured={mailConfigured}
            onClose={() => {
              setEditorOpen(false);
              setEditing(null);
            }}
            onSaved={() => {
              setEditorOpen(false);
              setEditing(null);
              void load().catch(() => {});
            }}
          />
        )}

        {actionError && (
          <Alert variant="destructive">
            <Icon name="alert" size={14} />
            <AlertDescription>{actionError}</AlertDescription>
          </Alert>
        )}

        {started && (
          <Alert variant="success">
            <Icon name="play" size={14} />
            <AlertDescription className="flex flex-wrap items-center gap-2">
              Run started — it keeps going whether or not this page stays open.
              <Link to="/runs" search={{ run: started.runId }} className="font-medium">
                Watch it in the history
              </Link>
            </AlertDescription>
          </Alert>
        )}

        {loading ? (
          <Panel>
            <PanelContent className="flex flex-col gap-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </PanelContent>
          </Panel>
        ) : error && schedules.length === 0 ? (
          <Alert variant="destructive">
            <Icon name="alert" size={14} />
            <AlertTitle>Schedules could not be loaded</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : schedules.length === 0 ? (
          <Panel>
            <EmptyState
              icon="clock"
              title="No schedules yet"
              description="Hand an agent the same task on a cadence: triage the inbox every weekday at 08:00, check the release branch every Monday, post a weekly summary."
            >
              {agents.length > 0 && !schedulerOff && (
                <Button onClick={openNew}>
                  <Icon name="plus" size={14} /> New schedule
                </Button>
              )}
            </EmptyState>
          </Panel>
        ) : (
          <Panel>
            <PanelHeader>
              <div className="flex items-baseline gap-2.5">
                <PanelTitle>Scheduled runs</PanelTitle>
                <PanelNote>
                  {plural(schedules.length, 'schedule')} · {armed.length} armed
                </PanelNote>
              </div>
              {nextUp && (
                <span className="text-xs text-muted-foreground">
                  next fires {timeUntil(nextUp.nextRunAt)} · {formatDateTime(nextUp.nextRunAt)}
                </span>
              )}
            </PanelHeader>
            <PanelContent flush>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-0">
                      <span className="sr-only">Run on cadence</span>
                    </TableHead>
                    <TableHead>Schedule</TableHead>
                    <TableHead>Agent</TableHead>
                    <TableHead>Cadence</TableHead>
                    <TableHead>Next run</TableHead>
                    <TableHead>Last run</TableHead>
                    <TableHead className="w-0">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {schedules.map((schedule) => {
                    const busy = busyId === schedule.id;
                    const launched = started?.scheduleId === schedule.id;
                    return (
                      <TableRow key={schedule.id} className={cn(!schedule.enabled && 'opacity-70')}>
                        <TableCell>
                          <Checkbox
                            checked={schedule.enabled}
                            disabled={busy}
                            aria-label={`${schedule.enabled ? 'Pause' : 'Resume'} ${schedule.label}`}
                            onCheckedChange={(checked) => void toggle(schedule, checked === true)}
                          />
                        </TableCell>
                        <TableCell className="max-w-[340px] whitespace-normal">
                          <span className="block truncate font-medium text-foreground" title={schedule.label}>
                            {schedule.label}
                          </span>
                          <span className="mt-0.5 block truncate text-[11.5px] text-mute" title={schedule.input}>
                            {schedule.input}
                          </span>
                          {schedule.notifyOn !== 'never' && (
                            <span
                              className="mt-1.5 inline-flex"
                              title={
                                schedule.notifyRecipients.length > 0
                                  ? `Emails ${schedule.notifyRecipients.join(', ')} — ${NOTIFY_NOTES[schedule.notifyOn]}`
                                  : NOTIFY_NOTES[schedule.notifyOn]
                              }
                            >
                              <SignalChip className="gap-1">
                                <Icon name="mail" size={11} />
                                {NOTIFY_LABELS[schedule.notifyOn]}
                              </SignalChip>
                            </span>
                          )}
                          {schedule.notifyOn !== 'never' && schedule.lastNotifyError && (
                            <span
                              className="mt-1 block text-[11.5px] text-warning"
                              title={schedule.lastNotifyError}
                            >
                              Notification failed: {schedule.lastNotifyError}
                            </span>
                          )}
                          {schedule.pausedReason && (
                            <span className="mt-1 block text-[11.5px] text-warning" title={schedule.pausedReason}>
                              {schedule.pausedReason}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          <span className="inline-flex items-center gap-2">
                            <Mark name={schedule.agentName} color={schedule.agentColor} size="sm" />
                            <span className="max-w-[160px] truncate">{schedule.agentName}</span>
                          </span>
                        </TableCell>
                        <TableCell>
                          <span className="block text-muted-foreground">{schedule.description}</span>
                          <span className="mt-0.5 block font-mono text-[11px] text-mute">{schedule.cron}</span>
                        </TableCell>
                        <TableCell>
                          {schedule.running ? (
                            <StateRail tone="live">Running now</StateRail>
                          ) : schedule.enabled && schedule.nextRunAt ? (
                            <span className="inline-flex flex-col">
                              <span className="text-muted-foreground">{timeUntil(schedule.nextRunAt)}</span>
                              <span
                                className="text-[11px] text-mute tabular-nums"
                                title={formatDateTime(schedule.nextRunAt)}
                              >
                                {formatDateTime(schedule.nextRunAt)}
                              </span>
                            </span>
                          ) : (
                            <StateRail tone="idle">{schedule.enabled ? 'Not armed' : 'Paused'}</StateRail>
                          )}
                        </TableCell>
                        <TableCell>
                          {schedule.lastStatus ? (
                            <span className="inline-flex flex-col gap-0.5">
                              <StateRail
                                tone={
                                  schedule.lastStatus === 'completed'
                                    ? 'ok'
                                    : schedule.lastStatus === 'running'
                                      ? 'live'
                                      : schedule.lastStatus === 'failed'
                                        ? 'fail'
                                        : 'idle'
                                }
                              >
                                {schedule.lastStatus === 'running'
                                  ? 'Running'
                                  : statusLabel(schedule.lastStatus)}
                              </StateRail>
                              <span className="text-[11px] text-mute">
                                {timeAgo(schedule.lastRunAt)}
                                {schedule.lastRunId && (
                                  <>
                                    {' · '}
                                    <Link to="/runs" search={{ run: schedule.lastRunId }} className="font-medium">
                                      view
                                    </Link>
                                  </>
                                )}
                              </span>
                            </span>
                          ) : (
                            <span className="text-mute">never</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {confirmId === schedule.id ? (
                            <span className="inline-flex items-center gap-1.5">
                              <Button
                                variant="destructive"
                                size="sm"
                                onClick={() => void remove(schedule)}
                                disabled={busy}
                              >
                                {busy ? 'Removing…' : 'Remove'}
                              </Button>
                              <Button variant="secondary" size="sm" onClick={() => setConfirmId(null)}>
                                Cancel
                              </Button>
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1">
                              <Button
                                variant={launched ? 'default' : 'secondary'}
                                size="icon-sm"
                                onClick={() => void runNow(schedule)}
                                disabled={busy}
                                aria-label={`Run ${schedule.label} now`}
                                title="Run now — opens a run in the history"
                              >
                                <Icon name="play" size={15} />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                onClick={() => openEdit(schedule)}
                                aria-label={`Edit ${schedule.label}`}
                                title="Edit"
                              >
                                <Icon name="edit" size={15} />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                onClick={() => setConfirmId(schedule.id)}
                                aria-label={`Delete ${schedule.label}`}
                                title="Delete"
                              >
                                <Icon name="trash" size={15} />
                              </Button>
                            </span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </PanelContent>
            <div className="border-t border-border px-5 py-3 text-xs text-muted-foreground">
              Fired runs appear in <Link to="/runs" className="font-medium">Runs</Link> tagged with the schedule
              that started them. A schedule that fails {cfg?.scheduler.maxFailures ?? 5} times in a row pauses
              itself rather than retrying forever.
              {mailConfigured
                ? ' Schedules set to notify email their outcome once the run has been recorded.'
                : ' Set a schedule to notify and its outcome is emailed — once a relay is configured in Settings.'}
            </div>
          </Panel>
        )}
      </div>
    </Page>
  );
}
