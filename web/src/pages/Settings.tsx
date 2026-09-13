import { useEffect, useState } from 'react';
import {
  clearMail, createUser, deleteUser, getMail, getSettings, listUsers, testMail, updateMail, updateProfile,
  updateSettings, updateUser,
} from '../api';
import { useAuth } from '@/lib/auth';
import { useReloadConfig } from '../App';
import { Icon } from '../components/Icon';
import { Field } from '../components/app/field';
import { Page, PageActions, PageDescription, PageHeadMain, PageHeader, PageTitle } from '../components/app/page';
import { Panel, PanelContent, PanelHeader, PanelNote, PanelTitle } from '../components/app/panel';
import { SignalChip } from '../components/app/chips';
import { StateRail } from '../components/app/state';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Checkbox } from '../components/ui/checkbox';
import { Input } from '../components/ui/input';
import { Skeleton } from '../components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { formatDateTime, plural, timeAgo } from '../format';
import { cn } from '@/lib/utils';
import type { AdminStats, AppSettings, MailSecurity, MailStatus, PublicUser } from '../types';

const lastSignIn = (user: PublicUser) =>
  user.lastLoginAt ? <span title={formatDateTime(user.lastLoginAt)}>{timeAgo(user.lastLoginAt)}</span> : 'never';

function Notice({ tone, children }: { tone: 'ok' | 'danger'; children: React.ReactNode }) {
  return (
    <Alert variant={tone === 'ok' ? 'success' : 'destructive'} className="mb-4">
      <Icon name={tone === 'ok' ? 'checkCircle' : 'alert'} size={14} />
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

/* ── Instance access (admins) ──────────────────────────────────────────── */

function AccessPanel({
  settings,
  stats,
  onSaved,
}: {
  settings: AppSettings;
  stats: AdminStats | null;
  onSaved: (settings: AppSettings) => void;
}) {
  const [signupsEnabled, setSignupsEnabled] = useState(settings.signupsEnabled);
  const [domains, setDomains] = useState(settings.allowedSignupDomains.join(', '));
  const [sessionDays, setSessionDays] = useState(String(settings.sessionDays));
  const [historyLimit, setHistoryLimit] = useState(String(settings.runHistoryLimit));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await updateSettings({
        signupsEnabled,
        allowedSignupDomains: domains.split(',').map((d) => d.trim()).filter(Boolean),
        sessionDays: Number(sessionDays),
        runHistoryLimit: Number(historyLimit),
      });
      onSaved(res.settings);
      setDomains(res.settings.allowedSignupDomains.join(', '));
      setSessionDays(String(res.settings.sessionDays));
      setHistoryLimit(String(res.settings.runHistoryLimit));
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel>
      <PanelHeader>
        <div className="flex flex-col gap-0.5">
          <PanelTitle>Access</PanelTitle>
          <PanelNote>Who may join this instance, and how long a sign-in lasts.</PanelNote>
        </div>
        <StateRail tone={signupsEnabled ? 'ok' : 'warn'}>
          {signupsEnabled ? 'Signups open' : 'Signups closed'}
        </StateRail>
      </PanelHeader>
      <PanelContent>
        {error && <Notice tone="danger">{error}</Notice>}
        {saved && <Notice tone="ok">Settings saved.</Notice>}

        <label className="mb-5 flex cursor-pointer items-start gap-2.5 rounded-[9px] px-2 py-2 transition-colors hover:bg-surface-2">
          <Checkbox checked={signupsEnabled} onCheckedChange={(value) => setSignupsEnabled(value === true)} />
          <span className="min-w-0">
            <span className="block text-[13.5px] font-medium">Allow new signups</span>
            <span className="mt-0.5 block text-xs text-mute">
              Anyone who can reach this instance may create an account. Turn it off and only administrators can add
              people below.
            </span>
          </span>
        </label>

        <div className="grid gap-x-4 sm:grid-cols-3">
          <Field
            label="Allowed email domains"
            hint="optional"
            htmlFor="settings-domains"
          >
            <Input
              id="settings-domains"
              value={domains}
              onChange={(e) => setDomains(e.target.value)}
              placeholder="acme.com, example.org"
              spellCheck={false}
              disabled={busy}
            />
          </Field>
          <Field label="Session length" hint="days" htmlFor="settings-session">
            <Input
              id="settings-session"
              type="number"
              min={1}
              max={365}
              value={sessionDays}
              onChange={(e) => setSessionDays(e.target.value)}
              disabled={busy}
            />
          </Field>
          <Field label="History kept" hint="sessions" htmlFor="settings-history">
            <Input
              id="settings-history"
              type="number"
              min={10}
              max={5000}
              value={historyLimit}
              onChange={(e) => setHistoryLimit(e.target.value)}
              disabled={busy}
            />
          </Field>
        </div>

        <p className="mt-0 mb-4 text-xs text-mute">
          Empty domain list = any address. Sessions are signed in browsers; {stats ? stats.sessions : 0} are open right
          now.
        </p>

        <Button onClick={() => void save()} disabled={busy}>
          {busy ? 'Saving…' : 'Save changes'}
        </Button>
      </PanelContent>
    </Panel>
  );
}

/* ── Email notifications (admins) ──────────────────────────────────────── */

const SECURITIES: Array<{ key: MailSecurity; label: string; port: number; note: string }> = [
  { key: 'starttls', label: 'STARTTLS', port: 587, note: 'Plaintext connect, upgraded to TLS. The usual choice — port 587.' },
  { key: 'tls', label: 'TLS', port: 465, note: 'Encrypted from the first byte (implicit TLS) — port 465.' },
  { key: 'none', label: 'None', port: 25, note: 'No encryption at all. Only sane on a network you control.' },
];

/** Short human-readable summary of a successful mail check. */
function describeMailSample(sample: unknown): string {
  if (sample && typeof sample === 'object') {
    const s = sample as Record<string, unknown>;
    if (typeof s.messageId === 'string' && typeof s.ms === 'number') {
      return `Delivered in ${s.ms} ms${s.messageId ? ` · ${s.messageId}` : ''}`;
    }
    if (typeof s.host === 'string' && typeof s.ms === 'number') {
      return `Connected and authenticated to ${s.host}:${String(s.port)} in ${s.ms} ms`;
    }
  }
  return 'Reachable';
}

/**
 * Email notifications — the SMTP relay scheduled runs report through.
 *
 * The password is write-only from here: the server never sends the stored one
 * back, so the field starts empty and is only posted when it has actually been
 * touched. That is what makes "leave it blank to keep it" true rather than a
 * polite lie that wipes a working credential on every unrelated save.
 */
function MailPanel({ adminEmail }: { adminEmail: string }) {
  const reloadConfig = useReloadConfig();
  const [mail, setMail] = useState<MailStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [enabled, setEnabled] = useState(false);
  const [host, setHost] = useState('');
  const [port, setPort] = useState('587');
  const [security, setSecurity] = useState<MailSecurity>('starttls');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [passwordTouched, setPasswordTouched] = useState(false);
  const [fromName, setFromName] = useState('Agents OS');
  const [fromEmail, setFromEmail] = useState('');
  const [replyTo, setReplyTo] = useState('');
  const [verifyCertificate, setVerifyCertificate] = useState(true);

  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [testTo, setTestTo] = useState(adminEmail);
  const [testing, setTesting] = useState(false);
  const [checks, setChecks] = useState<Record<string, { ok: boolean; sample?: unknown; error?: string }> | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  /** Load the relay into the form. Called on mount and after every save. */
  const adopt = (next: MailStatus) => {
    setMail(next);
    setEnabled(next.enabled);
    setHost(next.host);
    setPort(String(next.port));
    setSecurity(next.security);
    setUsername(next.username);
    setPassword('');
    setPasswordTouched(false);
    setFromName(next.fromName);
    setFromEmail(next.fromEmail);
    setReplyTo(next.replyTo);
    setVerifyCertificate(next.verifyCertificate);
  };

  useEffect(() => {
    let alive = true;
    void getMail()
      .then((res) => {
        if (alive) adopt(res.mail);
      })
      .catch((err) => {
        if (alive) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, []);

  const mode = SECURITIES.find((option) => option.key === security) ?? SECURITIES[0]!;

  /** Moving between modes carries the conventional port with it. */
  const chooseSecurity = (next: MailSecurity) => {
    const previous = SECURITIES.find((option) => option.key === security);
    if (previous && String(previous.port) === port.trim()) {
      setPort(String(SECURITIES.find((option) => option.key === next)!.port));
    }
    setSecurity(next);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    setChecks(null);
    try {
      const res = await updateMail({
        enabled,
        host: host.trim(),
        port: Number(port),
        security,
        username: username.trim(),
        // Only sent once the field has been touched: absent means "keep it".
        ...(passwordTouched ? { password } : {}),
        fromName: fromName.trim(),
        fromEmail: fromEmail.trim(),
        replyTo: replyTo.trim(),
        verifyCertificate,
      });
      adopt(res.mail);
      setSaved(true);
      // The Schedules page reads `mail.configured` from the instance config, so
      // refresh it now rather than waiting for the next poll.
      reloadConfig();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    setChecks(null);
    try {
      adopt((await clearMail()).mail);
      setConfirmRemove(false);
      reloadConfig();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setChecks(null);
    setTestError(null);
    try {
      const res = await testMail(testTo.trim() || undefined);
      setChecks(res.checks);
    } catch (err) {
      // The server answers 502 with the per-check detail for a refused relay;
      // show those rows rather than swallowing them into one line.
      setTestError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  };

  if (loadError) {
    return (
      <Panel>
        <PanelHeader>
          <div className="flex flex-col gap-0.5">
            <PanelTitle>Email notifications</PanelTitle>
            <PanelNote>Scheduled runs can email you their outcome.</PanelNote>
          </div>
          <StateRail tone="fail">Unavailable</StateRail>
        </PanelHeader>
        <PanelContent>
          <Notice tone="danger">{loadError}</Notice>
        </PanelContent>
      </Panel>
    );
  }

  if (!mail) {
    return (
      <Panel>
        <PanelHeader>
          <div className="flex flex-col gap-0.5">
            <PanelTitle>Email notifications</PanelTitle>
            <PanelNote>Scheduled runs can email you their outcome.</PanelNote>
          </div>
        </PanelHeader>
        <PanelContent className="flex flex-col gap-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-2/3" />
        </PanelContent>
      </Panel>
    );
  }

  return (
    <Panel>
      <PanelHeader>
        <div className="flex flex-col gap-0.5">
          <PanelTitle>Email notifications</PanelTitle>
          <PanelNote>
            {mail.configured
              ? `Sending through ${mail.host}:${mail.port} as ${mail.fromEmail}`
              : 'A relay for scheduled runs to report through.'}
          </PanelNote>
        </div>
        <StateRail tone={mail.configured ? 'ok' : mail.enabled ? 'warn' : 'idle'}>
          {mail.configured ? 'Ready' : mail.enabled ? 'Incomplete' : 'Off'}
        </StateRail>
      </PanelHeader>

      <PanelContent>
        {error && <Notice tone="danger">{error}</Notice>}
        {saved && <Notice tone="ok">Notification settings saved.</Notice>}

        <label className="mb-5 flex cursor-pointer items-start gap-2.5 rounded-[9px] px-2 py-2 transition-colors hover:bg-surface-2">
          <Checkbox checked={enabled} onCheckedChange={(value) => setEnabled(value === true)} disabled={busy} />
          <span className="min-w-0">
            <span className="block text-[13.5px] font-medium">Send email notifications</span>
            <span className="mt-0.5 block text-xs text-mute">
              The master switch. With it off nothing is sent, whatever an individual schedule asks for.
            </span>
          </span>
        </label>

        <div className="grid gap-x-4 sm:grid-cols-3">
          <div className="sm:col-span-2">
            <Field label="SMTP host" hint="required" htmlFor="mail-host">
              <Input
                id="mail-host"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="smtp.example.com"
                spellCheck={false}
                autoComplete="off"
                disabled={busy}
              />
            </Field>
          </div>
          <Field label="Port" htmlFor="mail-port">
            <Input
              id="mail-port"
              type="number"
              min={1}
              max={65535}
              value={port}
              onChange={(e) => setPort(e.target.value)}
              disabled={busy}
            />
          </Field>
        </div>

        <Field label="Encryption" hint="how the connection is protected" error={null}>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Encryption">
            {SECURITIES.map((option) => (
              <button
                key={option.key}
                type="button"
                role="radio"
                aria-checked={security === option.key}
                onClick={() => chooseSecurity(option.key)}
                disabled={busy}
                className={cn(
                  'h-8 cursor-pointer rounded-full border border-border bg-card px-3 text-[12.5px] font-medium text-muted-foreground transition-colors duration-150',
                  'hover:bg-surface-2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60',
                  'aria-checked:border-primary aria-checked:bg-primary aria-checked:font-semibold aria-checked:text-primary-foreground',
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
          <p className="mt-2 mb-0 text-xs text-mute">{mode.note}</p>
        </Field>

        <div className="grid gap-x-4 sm:grid-cols-2">
          <Field label="Username" hint="optional" htmlFor="mail-user">
            <Input
              id="mail-user"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="apikey or you@example.com"
              spellCheck={false}
              autoComplete="off"
              disabled={busy}
            />
          </Field>
          <Field
            label="Password"
            hint={mail.hasPassword ? 'saved' : 'optional'}
            htmlFor="mail-password"
          >
            <Input
              id="mail-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setPasswordTouched(true);
              }}
              placeholder={mail.hasPassword && !passwordTouched ? '••••••••' : ''}
              disabled={busy}
            />
            <span className="mt-1.5 block text-xs text-mute">
              {!mail.hasPassword
                ? 'Most providers need an app-specific password here, not your account password.'
                : passwordTouched
                  ? password
                    ? 'Replaces the saved password when you save.'
                    : 'The saved password will be removed when you save.'
                  : 'A password is saved. Leave this blank to keep it, or type to replace it.'}
            </span>
          </Field>
        </div>

        <div className="grid gap-x-4 sm:grid-cols-3">
          <Field label="From name" htmlFor="mail-from-name">
            <Input
              id="mail-from-name"
              value={fromName}
              onChange={(e) => setFromName(e.target.value)}
              placeholder="Agents OS"
              disabled={busy}
            />
          </Field>
          <Field label="From address" hint="required" htmlFor="mail-from">
            <Input
              id="mail-from"
              type="email"
              value={fromEmail}
              onChange={(e) => setFromEmail(e.target.value)}
              placeholder="agents@example.com"
              spellCheck={false}
              autoComplete="off"
              disabled={busy}
            />
          </Field>
          <Field label="Reply-to" hint="optional" htmlFor="mail-reply-to">
            <Input
              id="mail-reply-to"
              type="email"
              value={replyTo}
              onChange={(e) => setReplyTo(e.target.value)}
              placeholder="you@example.com"
              spellCheck={false}
              autoComplete="off"
              disabled={busy}
            />
          </Field>
        </div>

        <label className="mb-5 flex cursor-pointer items-start gap-2.5 rounded-[9px] px-2 py-2 transition-colors hover:bg-surface-2">
          <Checkbox
            checked={verifyCertificate}
            onCheckedChange={(value) => setVerifyCertificate(value === true)}
            disabled={busy || security === 'none'}
          />
          <span className="min-w-0">
            <span className="block text-[13.5px] font-medium">Require a trusted TLS certificate</span>
            <span className="mt-0.5 block text-xs text-mute">
              Leave this on. Turn it off only for an internal relay with a self-signed certificate
              {security === 'none' ? ' — not used while encryption is off.' : '.'}
            </span>
          </span>
        </label>

        <div className="flex flex-wrap items-center gap-2.5">
          <Button onClick={() => void save()} disabled={busy}>
            {busy ? 'Saving…' : 'Save changes'}
          </Button>
          {confirmRemove ? (
            <span className="inline-flex items-center gap-2">
              <Button variant="destructive" onClick={() => void remove()} disabled={busy}>
                {busy ? 'Removing…' : 'Remove credentials'}
              </Button>
              <Button variant="secondary" onClick={() => setConfirmRemove(false)}>Cancel</Button>
            </span>
          ) : (
            <Button variant="secondary" onClick={() => setConfirmRemove(true)} disabled={busy || !mail.configured}>
              <Icon name="trash" size={14} /> Remove
            </Button>
          )}
          {mail.updatedAt && <span className="text-xs text-mute">saved {timeAgo(mail.updatedAt)}</span>}
        </div>
      </PanelContent>

      <div className="border-t border-rule px-5 py-4">
        <div className="mb-3 flex items-center gap-2 text-[12.5px] text-muted-foreground">
          <Icon name="send" size={14} /> Test the relay
          <span className="text-mute">— connects, authenticates and delivers a real message.</span>
        </div>

        {testError && <Notice tone="danger">{testError}</Notice>}

        {checks && (
          <div className="mb-4 overflow-hidden rounded-[9px] border border-rule">
            {Object.entries(checks).map(([name, check]) => (
              <div key={name} className="flex items-center gap-3.5 border-t border-rule px-3.5 py-2.5 first:border-t-0">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-[7px] bg-surface-2 text-muted-foreground">
                  <Icon name={check.ok ? 'check' : 'close'} size={14} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-[12.5px] font-medium">{name}</div>
                  <div className="text-[12px] text-mute">
                    {check.ok ? describeMailSample(check.sample) : check.error?.slice(0, 220)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-end gap-2.5">
          <div className="min-w-[240px] flex-1">
            <Field label="Send a test to" htmlFor="mail-test-to">
              <Input
                id="mail-test-to"
                type="email"
                value={testTo}
                onChange={(e) => setTestTo(e.target.value)}
                placeholder="you@example.com"
                spellCheck={false}
                autoComplete="off"
                disabled={testing}
              />
            </Field>
          </div>
          <div className="mb-[18px]">
            <Button
              variant="secondary"
              onClick={() => void runTest()}
              disabled={testing || !mail.configured}
              title={mail.configured ? undefined : 'Save a host and sender address first'}
            >
              {testing ? 'Testing…' : 'Test connection'}
            </Button>
          </div>
        </div>
        <p className="mt-0 text-xs text-mute">
          Leave the address empty to only open and authenticate the connection. Passwords are stored in the
          instance database (<code>db.json</code>) and are never sent to the model provider.
        </p>
      </div>
    </Panel>
  );
}

/* ── People (admins) ───────────────────────────────────────────────────── */
function PeoplePanel({ me, onCounts }: { me: PublicUser; onCounts: (counts: { users: number; admins: number }) => void }) {
  const [users, setUsers] = useState<PublicUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [resetId, setResetId] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState('');

  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [makeAdmin, setMakeAdmin] = useState(false);
  const [adding, setAdding] = useState(false);

  const reload = async () => {
    try {
      const list = await listUsers();
      setUsers(list);
      onCounts({ users: list.length, admins: list.filter((u) => u.role === 'admin').length });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const guard = async (id: string, fn: () => Promise<unknown>) => {
    setBusyId(id);
    setError(null);
    try {
      await fn();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const add = async () => {
    setAdding(true);
    setError(null);
    try {
      await createUser({ email: email.trim(), name: name.trim(), password, role: makeAdmin ? 'admin' : 'member' });
      setEmail('');
      setName('');
      setPassword('');
      setMakeAdmin(false);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  };

  const admins = (users ?? []).filter((u) => u.role === 'admin').length;

  return (
    <Panel>
      <PanelHeader>
        <div className="flex items-baseline gap-2.5">
          <PanelTitle>People</PanelTitle>
          <PanelNote>{users ? plural(users.length, 'account') : 'loading…'}</PanelNote>
        </div>
        <span className="text-xs text-mute">
          {users ? `${admins} admin${admins === 1 ? '' : 's'}` : ''}
        </span>
      </PanelHeader>

      <PanelContent flush>
        {error && (
          <div className="px-5 pt-4">
            <Notice tone="danger">{error}</Notice>
          </div>
        )}
        {!users ? (
          <div className="flex flex-col gap-2 px-5 py-5">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Last sign-in</TableHead>
                <TableHead className="w-0">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((user) => {
                const isMe = user.id === me.id;
                const isLastAdmin = user.role === 'admin' && admins <= 1;
                return (
                  <TableRow key={user.id}>
                    <TableCell className="font-medium">
                      <span className="inline-flex items-center gap-2">
                        {user.email}
                        {isMe && <SignalChip>you</SignalChip>}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{user.name}</TableCell>
                    <TableCell>
                      {user.role === 'admin' ? (
                        <Badge variant="secondary">
                          <Icon name="shield" size={12} /> admin
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">member</span>
                      )}
                    </TableCell>
                    <TableCell className="text-mute">{lastSignIn(user)}</TableCell>
                    <TableCell className="text-right">
                      {resetId === user.id ? (
                        <span className="inline-flex items-center gap-1.5">
                          <Input
                            type="text"
                            autoFocus
                            value={resetPassword}
                            onChange={(e) => setResetPassword(e.target.value)}
                            placeholder="New password"
                            aria-label={`New password for ${user.email}`}
                            className="h-9 w-[180px]"
                          />
                          <Button
                            size="sm"
                            disabled={busyId === user.id}
                            onClick={() =>
                              void guard(user.id, async () => {
                                await updateUser(user.id, { password: resetPassword });
                                setResetId(null);
                                setResetPassword('');
                              })
                            }
                          >
                            Set
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => {
                              setResetId(null);
                              setResetPassword('');
                            }}
                          >
                            Cancel
                          </Button>
                        </span>
                      ) : confirmId === user.id ? (
                        <span className="inline-flex items-center gap-1.5">
                          <Button
                            size="sm"
                            variant="destructive"
                            disabled={busyId === user.id}
                            onClick={() => void guard(user.id, () => deleteUser(user.id))}
                          >
                            Remove
                          </Button>
                          <Button size="sm" variant="secondary" onClick={() => setConfirmId(null)}>
                            Cancel
                          </Button>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5">
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={isMe || busyId === user.id || isLastAdmin}
                            title={
                              isMe
                                ? 'You cannot change your own role'
                                : isLastAdmin
                                  ? 'At least one administrator must remain'
                                  : undefined
                            }
                            onClick={() =>
                              void guard(user.id, () =>
                                updateUser(user.id, { role: user.role === 'admin' ? 'member' : 'admin' }),
                              )
                            }
                          >
                            {user.role === 'admin' ? 'Make member' : 'Make admin'}
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={busyId === user.id}
                            aria-label={`Set a new password for ${user.email}`}
                            title="Set a new password"
                            onClick={() => {
                              setConfirmId(null);
                              setResetId(user.id);
                              setResetPassword('');
                            }}
                          >
                            <Icon name="key" size={14} />
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={isMe || busyId === user.id || isLastAdmin}
                            aria-label={`Remove ${user.email}`}
                            title={isMe ? 'You cannot remove your own account' : 'Remove this account'}
                            onClick={() => {
                              setResetId(null);
                              setConfirmId(user.id);
                            }}
                          >
                            <Icon name="trash" size={14} />
                          </Button>
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </PanelContent>

      <div className="border-t border-rule px-5 py-4">
        <div className="mb-3 flex items-center gap-2 text-[12.5px] text-muted-foreground">
          <Icon name="userPlus" size={14} /> Add someone directly
          <span className="text-mute">— works even when signups are closed.</span>
        </div>
        <div className="grid gap-x-4 sm:grid-cols-4">
          <Field label="Email" htmlFor="new-user-email">
            <Input
              id="new-user-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="teammate@example.com"
              spellCheck={false}
              disabled={adding}
            />
          </Field>
          <Field label="Name" hint="optional" htmlFor="new-user-name">
            <Input
              id="new-user-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Grace Hopper"
              disabled={adding}
            />
          </Field>
          <Field label="Password" hint="min 8" htmlFor="new-user-password">
            <Input
              id="new-user-password"
              type="text"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={adding}
            />
          </Field>
          <div className="mb-[18px] flex items-end">
            <label className="flex h-10 cursor-pointer items-center gap-2.5 text-[12.5px]">
              <Checkbox checked={makeAdmin} onCheckedChange={(value) => setMakeAdmin(value === true)} />
              Administrator
            </label>
          </div>
        </div>
        <Button onClick={() => void add()} disabled={adding || !email.trim() || password.length < 8}>
          {adding ? 'Adding…' : 'Add account'}
        </Button>
      </div>
    </Panel>
  );
}

/* ── Own account (everyone) ────────────────────────────────────────────── */

function AccountPanel() {
  const { user, setUser, logout } = useAuth();
  const [name, setName] = useState(user?.name ?? '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!user) return null;

  const save = async () => {
    setError(null);
    setSaved(false);
    if (newPassword || confirmPassword || currentPassword) {
      if (!currentPassword) return setError('Enter your current password to change it.');
      if (newPassword.length < 8) return setError('The new password must be at least 8 characters.');
      if (newPassword !== confirmPassword) return setError('The new passwords do not match.');
    }

    setBusy(true);
    try {
      const res = await updateProfile({
        name: name.trim(),
        ...(newPassword ? { currentPassword, newPassword } : {}),
      });
      setUser(res.user);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel>
      <PanelHeader>
        <div className="flex min-w-0 flex-col gap-0.5">
          <PanelTitle>Account</PanelTitle>
          <PanelNote>{user.email}</PanelNote>
        </div>
        <div className="flex items-center gap-2.5">
          {user.role === 'admin' && (
            <Badge variant="secondary">
              <Icon name="shield" size={12} /> admin
            </Badge>
          )}
          <Button variant="secondary" size="sm" onClick={() => void logout()}>
            <Icon name="signOut" size={14} /> Sign out
          </Button>
        </div>
      </PanelHeader>
      <PanelContent>
        {error && <Notice tone="danger">{error}</Notice>}
        {saved && <Notice tone="ok">Account updated.</Notice>}

        <div className="grid gap-x-4 sm:grid-cols-2">
          <Field label="Display name" htmlFor="account-name">
            <Input
              id="account-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
            />
          </Field>
          <Field label="Email" hint="ask an admin to change" htmlFor="account-email">
            <Input id="account-email" value={user.email} readOnly disabled />
          </Field>
        </div>

        <div className="mb-4 mt-1 border-t border-rule pt-4 text-[12.5px] text-muted-foreground">
          <Icon name="lock" size={13} /> Change password
          <span className="text-mute"> — every other browser is signed out.</span>
        </div>
        <div className="grid gap-x-4 sm:grid-cols-3">
          <Field label="Current password" htmlFor="account-current">
            <Input
              id="account-current"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              disabled={busy}
            />
          </Field>
          <Field label="New password" hint="min 8" htmlFor="account-new">
            <Input
              id="account-new"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              disabled={busy}
            />
          </Field>
          <Field label="Confirm new" htmlFor="account-confirm">
            <Input
              id="account-confirm"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              disabled={busy}
            />
          </Field>
        </div>

        <Button className="mt-1" onClick={() => void save()} disabled={busy}>
          {busy ? 'Saving…' : 'Save account'}
        </Button>
      </PanelContent>
    </Panel>
  );
}

/* ── The page ──────────────────────────────────────────────────────────── */

export default function Settings() {
  const { user, isAdmin } = useAuth();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdmin) return;
    void getSettings()
      .then((res) => {
        setSettings(res.settings);
        setStats(res.stats);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [isAdmin]);

  return (
    <Page>
      <PageHeader>
        <PageHeadMain>
          <PageTitle>Settings</PageTitle>
          <PageDescription>
            {isAdmin
              ? 'Instance access, the people who can sign in, and your own account.'
              : 'Your account. Instance access and people are managed by an administrator.'}
          </PageDescription>
        </PageHeadMain>
        <PageActions>
          <StateRail tone={isAdmin ? 'ok' : 'idle'}>{isAdmin ? 'Administrator' : 'Member'}</StateRail>
        </PageActions>
      </PageHeader>

      <div className="flex flex-col gap-5">
        {isAdmin && error && (
          <Alert variant="destructive">
            <Icon name="alert" size={14} />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {isAdmin && !settings && !error && (
          <Panel>
            <PanelContent className="flex flex-col gap-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-2/3" />
            </PanelContent>
          </Panel>
        )}

        {isAdmin && settings && (
          <AccessPanel
            settings={settings}
            stats={stats}
            onSaved={(next) => setSettings(next)}
          />
        )}

        {isAdmin && user && <MailPanel adminEmail={user.email} />}

        {isAdmin && user && (
          <PeoplePanel
            me={user}
            onCounts={(counts) => setStats((prev) => ({ sessions: prev?.sessions ?? 0, ...counts }))}
          />
        )}

        <AccountPanel />
      </div>
    </Page>
  );
}
