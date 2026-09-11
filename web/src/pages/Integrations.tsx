import { useEffect, useState } from 'react';
import { useSearch } from '@tanstack/react-router';
import { githubTest, googleDisconnect, googleTest, llmTest, supabaseTest, vercelTest } from '../api';
import { useConfig, useReloadConfig } from '../App';
import { Icon } from '../components/Icon';
import { Page, PageDescription, PageHeadMain, PageHeader, PageTitle } from '../components/app/page';
import { Panel, PanelContent, PanelHeader, PanelNote, PanelTitle } from '../components/app/panel';
import { StateRail } from '../components/app/state';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Button } from '../components/ui/button';

type CheckResult = { ok: boolean; sample?: unknown; error?: string };
type Banner = { text: string; tone: 'info' | 'danger' | 'ok' };

/** Short human-readable summary of a successful live check. */
function describeSample(sample: unknown): string {
  if (sample && typeof sample === 'object') {
    const s = sample as Record<string, unknown>;
    if (typeof s.login === 'string') return `Signed in as ${s.login}`;
    if (typeof s.username === 'string') return `Signed in as ${s.username}`;
    if (typeof s.name === 'string' && typeof s.version === 'string') return `${s.name} ${s.version}`;
    if (typeof s.users === 'number') return 'Service role key valid';
    if (typeof s.region === 'string') return `Project ${String(s.name)} (${String(s.region)}, ${String(s.status)})`;
    if (Array.isArray(s)) return `${s.length} item(s)`;
  }
  return 'Reachable';
}

function CheckRows({ checks }: { checks: Record<string, CheckResult> | null }) {
  if (!checks) return null;
  return (
    <>
      {Object.entries(checks).map(([name, check]) => (
        <div key={name} className="flex items-center gap-3.5 border-t border-rule px-5 py-3 first:border-t-0">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-surface-2 text-muted-foreground">
            <Icon name={check.ok ? 'check' : 'close'} size={15} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[13.5px] font-medium">{name}</div>
            <div className="text-[12.5px] text-mute">
              {check.ok ? describeSample(check.sample) : check.error?.slice(0, 140)}
            </div>
          </div>
        </div>
      ))}
    </>
  );
}

function SectionHead({ title, note, tone, label }: { title: string; note: React.ReactNode; tone: 'ok' | 'warn'; label: string }) {
  return (
    <PanelHeader>
      <div className="flex flex-col gap-0.5">
        <PanelTitle>{title}</PanelTitle>
        <PanelNote>{note}</PanelNote>
      </div>
      <StateRail tone={tone}>{label}</StateRail>
    </PanelHeader>
  );
}

export default function Integrations() {
  const cfg = useConfig();
  const reload = useReloadConfig();
  const search = useSearch({ from: '/integrations' });
  const [banner, setBanner] = useState<Banner | null>(null);
  const [checks, setChecks] = useState<Record<string, CheckResult> | null>(null);
  const [testing, setTesting] = useState(false);
  const [llmResult, setLlmResult] = useState<string | null>(null);
  const [llmBusy, setLlmBusy] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const [ghChecks, setGhChecks] = useState<Record<string, CheckResult> | null>(null);
  const [ghTesting, setGhTesting] = useState(false);
  const [vcChecks, setVcChecks] = useState<Record<string, CheckResult> | null>(null);
  const [vcTesting, setVcTesting] = useState(false);
  const [sbChecks, setSbChecks] = useState<Record<string, CheckResult> | null>(null);
  const [sbTesting, setSbTesting] = useState(false);

  const { google: googleResult, group: groupParam, reason: reasonParam } = search;

  useEffect(() => {
    const result = googleResult;
    const group = groupParam === 'youtube' ? 'YouTube' : 'Gmail, Calendar and Drive';
    if (result === 'connected') setBanner({ text: `${group} connected.`, tone: 'ok' });
    if (result === 'error') {
      setBanner({ text: `Google connection failed: ${reasonParam ?? 'unknown error'}`, tone: 'danger' });
    }
    reload();
  }, [googleResult, groupParam, reasonParam, reload]);

  const connect = (group: 'workspace' | 'youtube') => {
    window.location.href = `/api/google/auth-url?group=${group}`;
  };

  const disconnect = async () => {
    setDisconnecting(true);
    try {
      await googleDisconnect();
      reload();
      setBanner({ text: 'Google disconnected.', tone: 'info' });
    } catch (err) {
      setBanner({ text: err instanceof Error ? err.message : String(err), tone: 'danger' });
    } finally {
      setDisconnecting(false);
    }
  };

  const runTests = async () => {
    setTesting(true);
    setChecks(null);
    try {
      const res = await googleTest();
      setChecks(res.checks);
    } catch (err) {
      setBanner({ text: err instanceof Error ? err.message : String(err), tone: 'danger' });
    } finally {
      setTesting(false);
    }
  };

  const runGithubTests = async () => {
    setGhTesting(true);
    setGhChecks(null);
    try {
      const res = await githubTest();
      setGhChecks(res.checks);
    } catch (err) {
      setBanner({ text: err instanceof Error ? err.message : String(err), tone: 'danger' });
    } finally {
      setGhTesting(false);
    }
  };

  const runVercelTests = async () => {
    setVcTesting(true);
    setVcChecks(null);
    try {
      const res = await vercelTest();
      setVcChecks(res.checks);
    } catch (err) {
      setBanner({ text: err instanceof Error ? err.message : String(err), tone: 'danger' });
    } finally {
      setVcTesting(false);
    }
  };

  const runSupabaseTests = async () => {
    setSbTesting(true);
    setSbChecks(null);
    try {
      const res = await supabaseTest();
      setSbChecks(res.checks);
    } catch (err) {
      setBanner({ text: err instanceof Error ? err.message : String(err), tone: 'danger' });
    } finally {
      setSbTesting(false);
    }
  };

  const testLlm = async () => {
    setLlmBusy(true);
    setLlmResult(null);
    try {
      const res = await llmTest();
      if (res.ok) setLlmResult(`${res.model ?? 'model'} replied in ${res.ms ?? '?'} ms: "${res.reply?.slice(0, 160)}"`);
      else setLlmResult(res.error ?? 'failed');
    } catch (err) {
      setLlmResult(err instanceof Error ? err.message : String(err));
    } finally {
      setLlmBusy(false);
    }
  };

  const google = cfg?.google;

  return (
    <Page>
      <PageHeader>
        <PageHeadMain>
          <PageTitle>Integrations</PageTitle>
          <PageDescription>The services agents act on. Credentials stay on this machine.</PageDescription>
        </PageHeadMain>
      </PageHeader>

      <div className="flex flex-col gap-5">
        {banner && (
          <Alert
            variant={banner.tone === 'danger' ? 'destructive' : banner.tone === 'ok' ? 'success' : 'info'}
            role="status"
            aria-live="polite"
          >
            <Icon name={banner.tone === 'danger' ? 'alert' : banner.tone === 'ok' ? 'check' : 'info'} size={14} />
            <AlertDescription>{banner.text}</AlertDescription>
          </Alert>
        )}

        <Panel>
          <SectionHead
            title="Google Workspace"
            note={google?.connected ? google.email : 'Gmail, Calendar, Drive and YouTube'}
            tone={google?.connected ? 'ok' : 'warn'}
            label={google?.connected ? 'Connected' : 'Not connected'}
          />

          {!google?.configured ? (
            <PanelContent>
              <Alert variant="warning">
                <Icon name="alert" size={14} />
                <AlertDescription>
                  Google OAuth is not configured on the server. Add <code>GOOGLE_CLIENT_ID</code> and{' '}
                  <code>GOOGLE_CLIENT_SECRET</code> to <code>.env</code> and restart. Create an OAuth client of type Web
                  application in the{' '}
                  <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">
                    Google Cloud Console
                  </a>{' '}
                  with the redirect URI <code>{window.location.origin.replace('5173', '8787')}/api/google/callback</code>.
                </AlertDescription>
              </Alert>
            </PanelContent>
          ) : (
            <>
              <div className="flex items-center gap-3.5 border-t border-rule px-5 py-3 first:border-t-0">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-surface-2 text-muted-foreground">
                  <Icon name="mail" size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[13.5px] font-medium">Gmail, Calendar and Drive</div>
                  <div className="text-[12.5px] text-mute">
                    {google?.groups.workspace.connected ? 'Authorized' : 'Not authorized yet'}
                  </div>
                </div>
                {google?.groups.workspace.connected ? (
                  <StateRail tone="ok">Ready</StateRail>
                ) : (
                  <Button onClick={() => connect('workspace')}>Connect</Button>
                )}
              </div>

              <div className="flex items-center gap-3.5 border-t border-rule px-5 py-3">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-surface-2 text-muted-foreground">
                  <Icon name="youtube" size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[13.5px] font-medium">YouTube</div>
                  <div className="text-[12.5px] text-mute">
                    {google?.groups.youtube.connected ? 'Authorized' : 'Search and upload not authorized'}
                  </div>
                </div>
                {google?.groups.youtube.connected ? (
                  <StateRail tone="ok">Ready</StateRail>
                ) : (
                  <Button onClick={() => connect('youtube')}>Connect</Button>
                )}
              </div>

              <CheckRows checks={checks} />

              <PanelContent className="border-t border-rule">
                <p className="mt-0 text-xs text-mute">
                  Google rejects YouTube permissions requested together with Drive, so the two groups are authorized
                  separately and stored as separate tokens. Connect the groups your agents need.
                </p>
                {google?.connected && (
                  <div className="flex flex-wrap gap-2 pt-3.5">
                    <Button variant="secondary" onClick={() => void runTests()} disabled={testing}>
                      {testing ? 'Testing…' : 'Test all services'}
                    </Button>
                    <Button variant="destructive" onClick={() => void disconnect()} disabled={disconnecting}>
                      {disconnecting ? 'Disconnecting…' : 'Disconnect'}
                    </Button>
                  </div>
                )}
              </PanelContent>

              {google && google.scopes.length > 0 && (
                <details className="px-5 pb-4 text-[12.5px] text-mute">
                  <summary className="cursor-pointer py-1 hover:text-muted-foreground">
                    Granted scopes ({google.scopes.length})
                  </summary>
                  <ul className="mt-2 mb-0 flex flex-col gap-1 pl-5">
                    {google.scopes.map((scope) => (
                      <li key={scope}>
                        <code>{scope}</code>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
        </Panel>

        <Panel>
          <SectionHead
            title="GitHub"
            note={cfg?.github.configured ? `Token ${cfg.github.tokenHint} in .env` : 'Repos, issues and pull requests'}
            tone={cfg?.github.configured ? 'ok' : 'warn'}
            label={cfg?.github.configured ? 'Configured' : 'Not configured'}
          />

          {!cfg?.github.configured ? (
            <PanelContent>
              <Alert variant="warning">
                <Icon name="alert" size={14} />
                <AlertDescription>
                  Set <code>GITHUB_TOKEN</code> in <code>.env</code> and restart. Create a token at{' '}
                  <a href="https://github.com/settings/tokens" target="_blank" rel="noreferrer">
                    github.com/settings/tokens
                  </a>{' '}
                  and use a classic token with <code>repo</code> scope, or a fine-grained token with Contents, Issues and
                  Pull requests read/write on the repositories your agents should work on.
                </AlertDescription>
              </Alert>
            </PanelContent>
          ) : (
            <>
              <CheckRows checks={ghChecks} />
              <PanelContent className="border-t border-rule">
                <p className="mt-0 text-xs text-mute">
                  Tools: search and list repos, manage issues and pull requests, read and write files. Agents are
                  instructed to confirm before creating issues, pull requests or commits.
                </p>
                <div className="flex flex-wrap gap-2 pt-3.5">
                  <Button variant="secondary" onClick={() => void runGithubTests()} disabled={ghTesting}>
                    {ghTesting ? 'Testing…' : 'Test connection'}
                  </Button>
                </div>
              </PanelContent>
            </>
          )}
        </Panel>

        <Panel>
          <SectionHead
            title="Vercel"
            note={cfg?.vercel.configured ? `Token ${cfg.vercel.tokenHint} in .env` : 'Projects and deployments'}
            tone={cfg?.vercel.configured ? 'ok' : 'warn'}
            label={cfg?.vercel.configured ? 'Configured' : 'Not configured'}
          />

          {!cfg?.vercel.configured ? (
            <PanelContent>
              <Alert variant="warning">
                <Icon name="alert" size={14} />
                <AlertDescription>
                  Set <code>VERCEL_TOKEN</code> in <code>.env</code> and restart. Create a token at{' '}
                  <a href="https://vercel.com/account/tokens" target="_blank" rel="noreferrer">
                    vercel.com/account/tokens
                  </a>{' '}
                  with the <em>Full Account</em> scope so agents can list projects and redeploy. If the token belongs
                  to a team, also set <code>VERCEL_TEAM_ID</code>.
                </AlertDescription>
              </Alert>
            </PanelContent>
          ) : (
            <>
              <CheckRows checks={vcChecks} />
              <PanelContent className="border-t border-rule">
                <p className="mt-0 text-xs text-mute">
                  Tools: list projects, deployments and domains, inspect env var keys, redeploy or cancel deployments.
                  Agents are instructed to confirm before redeploying or cancelling.
                  {cfg?.vercel.teamId && (
                    <>
                      {' '}
                      Team scoping: <code>VERCEL_TEAM_ID={cfg.vercel.teamId}</code>.
                    </>
                  )}
                </p>
                <div className="flex flex-wrap gap-2 pt-3.5">
                  <Button variant="secondary" onClick={() => void runVercelTests()} disabled={vcTesting}>
                    {vcTesting ? 'Testing…' : 'Test connection'}
                  </Button>
                </div>
              </PanelContent>
            </>
          )}
        </Panel>

        <Panel>
          <SectionHead
            title="Supabase"
            note={cfg?.supabase.configured ? cfg.supabase.url : 'Database, storage and auth'}
            tone={cfg?.supabase.configured ? 'ok' : 'warn'}
            label={cfg?.supabase.configured ? 'Configured' : 'Not configured'}
          />

          {!cfg?.supabase.configured ? (
            <PanelContent>
              <Alert variant="warning">
                <Icon name="alert" size={14} />
                <AlertDescription>
                  Set <code>SUPABASE_PROJECT_REF</code> (the <code>xxx</code> in your project URL{' '}
                  <code>https://xxx.supabase.co</code>) and <code>SUPABASE_SERVICE_ROLE_KEY</code> in <code>.env</code>{' '}
                  and restart. Both are in the Supabase dashboard under{' '}
                  <a href="https://supabase.com/dashboard" target="_blank" rel="noreferrer">
                    Project Settings → API
                  </a>
                  . The service role key bypasses row-level security, so protect it. Optionally add{' '}
                  <code>SUPABASE_ACCESS_TOKEN</code> for the SQL and table-listing tools.
                </AlertDescription>
              </Alert>
            </PanelContent>
          ) : (
            <>
              <CheckRows checks={sbChecks} />
              <PanelContent className="border-t border-rule">
                <p className="mt-0 text-xs text-mute">
                  Tools: query/insert/update/delete table rows (PostgREST), upload files to storage buckets and create
                  auth users. Agents are instructed to confirm before changing data or running SQL.
                  {!cfg?.supabase.managementConfigured && (
                    <>
                      {' '}
                      The <code>supabase_run_sql</code> and <code>supabase_list_tables</code> tools also need{' '}
                      <code>SUPABASE_ACCESS_TOKEN</code> in <code>.env</code>.
                    </>
                  )}
                </p>
                <div className="flex flex-wrap gap-2 pt-3.5">
                  <Button variant="secondary" onClick={() => void runSupabaseTests()} disabled={sbTesting}>
                    {sbTesting ? 'Testing…' : 'Test connection'}
                  </Button>
                </div>
              </PanelContent>
            </>
          )}
        </Panel>

        <Panel>
          <SectionHead
            title="Model provider"
            note={cfg?.llm.mock ? 'Mock brain, offline demo' : cfg?.llm.configured ? cfg.llm.model : 'Not configured'}
            tone={cfg?.llm.configured ? 'ok' : 'warn'}
            label={cfg?.llm.mock ? 'Mock' : cfg?.llm.configured ? 'Ready' : 'Offline'}
          />

          {cfg?.llm.baseUrl && (
            <div className="flex items-center gap-3.5 border-t border-rule px-5 py-3 first:border-t-0">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-surface-2 text-muted-foreground">
                <Icon name="external" size={15} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px] font-medium">Endpoint</div>
                <div className="truncate font-mono text-[12.5px] text-mute">{cfg.llm.baseUrl}</div>
              </div>
            </div>
          )}

          <PanelContent className="border-t border-rule">
            <p className="mt-0 text-xs text-mute">
              Any OpenAI compatible endpoint works: DeepSeek V4 (<code>deepseek-v4-pro</code> or{' '}
              <code>deepseek-v4-flash</code>), OpenAI, Gemini, OpenRouter or a local vLLM. Configure{' '}
              <code>LLM_BASE_URL</code>, <code>LLM_API_KEY</code> and <code>LLM_MODEL</code> in <code>.env</code>.
            </p>

            {!cfg?.llm.mock && (
              <div className="flex flex-wrap gap-2 pt-3.5">
                <Button variant="secondary" onClick={() => void testLlm()} disabled={llmBusy}>
                  {llmBusy ? 'Calling…' : 'Test connection'}
                </Button>
              </div>
            )}

            {llmResult && (
              <Alert variant="info" className="mt-3.5" role="status" aria-live="polite">
                <Icon name="info" size={14} />
                <AlertDescription>{llmResult}</AlertDescription>
              </Alert>
            )}
          </PanelContent>
        </Panel>
      </div>
    </Page>
  );
}
