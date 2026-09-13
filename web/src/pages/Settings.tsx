import { useEffect, useState } from 'react';
import {
  createUser, deleteUser, getSettings, listUsers, updateProfile, updateSettings, updateUser,
} from '../api';
import { useAuth } from '@/lib/auth';
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
import type { AdminStats, AppSettings, PublicUser } from '../types';

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

      <div className="grid max-w-[1000px] gap-5">
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
