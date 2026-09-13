import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '@/lib/auth';
import { Icon } from '../components/Icon';
import { Field } from '../components/app/field';
import { Panel, PanelContent, PanelHeader, PanelNote, PanelTitle } from '../components/app/panel';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Spinner } from '../components/ui/spinner';

type Mode = 'signin' | 'signup';

/**
 * The front door. One card, centred on the page canvas: sign in for an account
 * that exists, create one when the instance still allows it. On a fresh
 * install the first account becomes the administrator, and the screen says so
 * instead of hiding it in the docs.
 */
export default function Login() {
  const { state, login, signup } = useAuth();
  const needsSetup = state?.needsSetup ?? false;
  const canSignup = state?.canSignup ?? false;

  const [mode, setMode] = useState<Mode>(needsSetup ? 'signup' : 'signin');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The public state arrives right after the first paint; a fresh instance must
  // open on "create the administrator" rather than "sign in".
  useEffect(() => {
    if (needsSetup && canSignup) setMode('signup');
  }, [needsSetup, canSignup]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!email.trim()) return setError('Enter your email address.');
    if (!password) return setError('Enter your password.');
    if (mode === 'signup' && password.length < 8) {
      return setError('Password must be at least 8 characters.');
    }

    setBusy(true);
    try {
      if (mode === 'signup') await signup({ email: email.trim(), password, name: name.trim() });
      else await login(email.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const domains = state?.allowedSignupDomains ?? [];
  const heading = mode === 'signin' ? 'Sign in' : needsSetup ? 'Create the administrator account' : 'Create your account';
  const blurb = mode === 'signin'
    ? 'Use the email and password of your Agents OS account.'
    : needsSetup
      ? 'This instance has no accounts yet. The first one becomes the administrator and can open or close signups afterwards.'
      : 'Anyone with an account can run agents here.';

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-[430px]">
        <div className="mb-4 flex items-center gap-2.5 px-1">
          <span
            className="flex size-9 shrink-0 items-center justify-center rounded-[11px] bg-primary text-[16px] font-bold text-primary-foreground"
            aria-hidden="true"
          >
            A
          </span>
          <div className="min-w-0">
            <div className="text-sm leading-4 font-semibold tracking-tight" translate="no">
              Agents OS
            </div>
            <div className="mt-0.5 text-[11.5px] text-mute">your autonomous team</div>
          </div>
        </div>

        <Panel className="shadow-float">
          <PanelHeader>
            <div className="min-w-0">
              <PanelTitle>{heading}</PanelTitle>
              <PanelNote className="mt-1 block">{blurb}</PanelNote>
            </div>
          </PanelHeader>

          <PanelContent>
            {needsSetup && canSignup && (
              <Alert variant="info" className="mb-4">
                <Icon name="shield" size={14} />
                <AlertDescription>
                  This is the first account on the instance — it is promoted to <strong>admin</strong> automatically.
                </AlertDescription>
              </Alert>
            )}
            {error && (
              <Alert variant="destructive" className="mb-4">
                <Icon name="alert" size={14} />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <form onSubmit={(event) => void submit(event)} noValidate>
              {mode === 'signup' && (
                <Field label="Name" hint="optional" htmlFor="login-name">
                  <Input
                    id="login-name"
                    name="name"
                    autoComplete="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Ada Lovelace"
                    disabled={busy}
                  />
                </Field>
              )}

              <Field label="Email" htmlFor="login-email">
                <Input
                  id="login-email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  autoFocus
                  spellCheck={false}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  disabled={busy}
                />
              </Field>

              <Field
                label="Password"
                hint={mode === 'signup' ? 'at least 8 characters' : undefined}
                htmlFor="login-password"
              >
                <Input
                  id="login-password"
                  name="password"
                  type="password"
                  autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={busy}
                />
              </Field>

              {mode === 'signup' && domains.length > 0 && (
                <p className="mt-0 mb-4 text-xs text-mute">
                  Signups are limited to {domains.map((d) => `@${d}`).join(', ')} addresses.
                </p>
              )}

              <Button type="submit" size="lg" className="mt-1 w-full" disabled={busy}>
                {busy ? <Spinner /> : <Icon name={mode === 'signin' ? 'signIn' : 'plus'} size={16} />}
                {mode === 'signin' ? 'Sign in' : needsSetup ? 'Create administrator' : 'Create account'}
              </Button>
            </form>
          </PanelContent>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-rule px-5 py-3.5">
            {canSignup ? (
              <>
                <span className="text-[12.5px] text-muted-foreground">
                  {mode === 'signin' ? 'No account yet?' : 'Already have an account?'}
                </span>
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  onClick={() => {
                    setError(null);
                    setMode(mode === 'signin' ? 'signup' : 'signin');
                  }}
                  disabled={busy}
                >
                  {mode === 'signin' ? 'Create one' : 'Sign in instead'}
                </Button>
              </>
            ) : (
              <span className="text-[12.5px] text-muted-foreground">
                Signups are closed. Ask an administrator for an account.
              </span>
            )}
          </div>
        </Panel>

        <p className="mt-4 px-1 text-center text-[11.5px] text-mute">
          Sessions last {state?.sessionDays ?? 30} days on this device.
        </p>
      </div>
    </div>
  );
}
