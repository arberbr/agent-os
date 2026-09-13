/**
 * Runtime smoke test for the Agents OS web app.
 *
 * Loads the real app module graph through Vite's SSR pipeline (so the
 * Tailwind transform runs exactly as in dev/build), renders it into jsdom
 * with StrictMode enabled, walks every route against a running server, runs a
 * live agent chat end-to-end, and checks the server's API endpoints.
 *
 * Usage (server must be running):
 *   node smoke.mjs                  # against http://localhost:5173 (vite dev)
 *   BASE=http://localhost:8787 node smoke.mjs   # against the production build
 *
 * The audit signs in first: on a fresh instance SMOKE_EMAIL/SMOKE_PASSWORD
 * create the first account (the administrator), otherwise they log into a
 * seed account. Point them at a real account when signups are closed.
 */
import { createServer } from 'vite';
import { JSDOM } from 'jsdom';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.NODE_ENV = 'development';

const webRoot = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE ?? 'http://localhost:5173';

const SMOKE_EMAIL = process.env.SMOKE_EMAIL ?? 'smoke@agent-os.test';
const SMOKE_PASSWORD = process.env.SMOKE_PASSWORD ?? 'smoke-password';

let sessionCookie = '';
/** Flipped off by the UI audit to prove the login screen still appears. */
let withAuth = true;

const authHeaders = () => (withAuth && sessionCookie ? { Cookie: sessionCookie } : {});

/** Same headers, merged into whatever the caller already set. */
function mergeAuth(headers) {
  const merged = new Headers(headers ?? undefined);
  for (const [key, value] of Object.entries(authHeaders())) merged.set(key, value);
  return merged;
}

const dom = new JSDOM('<!doctype html><html lang="en" class="dark"><body><div id="root"></div></body></html>', {
  url: `${BASE}/`,
  pretendToBeVisual: true,
});

const g = globalThis;
g.window = dom.window;
g.self = dom.window;
g.document = dom.window.document;
Object.defineProperty(g, 'navigator', { value: dom.window.navigator, configurable: true });
g.HTMLElement = dom.window.HTMLElement;
g.localStorage = dom.window.localStorage;
g.getComputedStyle = dom.window.getComputedStyle;
g.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
g.cancelAnimationFrame = (id) => clearTimeout(id);
g.matchMedia = (q) => ({
  matches: false,
  media: q,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
});
g.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
g.IntersectionObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
};
g.scrollTo = () => {};
dom.window.Element.prototype.getAnimations = () => [];
dom.window.Element.prototype.scrollTo = () => {};

// Resolve the app's relative /api fetches against the target server. The
// session cookie rides along the same way a browser would send it, which is
// what lets the real app render signed in inside jsdom.
const originalFetch = globalThis.fetch.bind(globalThis);
g.fetch = (input, init) => {
  const url = typeof input === 'string' ? new URL(input, BASE) : input;
  const headers = mergeAuth(init?.headers);
  return originalFetch(url, { ...init, headers });
};
g.window.fetch = g.fetch;

/* ── Sign-in ───────────────────────────────────────────────────────────── */

/** Sign in, creating the first account when the instance has none yet. */
async function authenticate() {
  const post = async (path, body) => {
    const res = await originalFetch(new URL(path, BASE), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // non-JSON error body — the status is what matters
    }
    return { status: res.status, json, headers: res.headers };
  };

  let result = await post('/api/auth/login', { email: SMOKE_EMAIL, password: SMOKE_PASSWORD });
  if (result.status !== 200) {
    result = await post('/api/auth/signup', {
      email: SMOKE_EMAIL,
      password: SMOKE_PASSWORD,
      name: 'Smoke Test',
    });
  }
  if (result.status !== 200 && result.status !== 201) {
    throw new Error(
      `could not sign in as ${SMOKE_EMAIL} (HTTP ${result.status}: ${result.json?.error ?? 'no message'}). ` +
        'Pass SMOKE_EMAIL/SMOKE_PASSWORD for an existing account, or open signups in Settings.',
    );
  }

  const setCookie = result.headers.getSetCookie?.()[0] ?? result.headers.get('set-cookie') ?? '';
  sessionCookie = setCookie.split(';')[0];
  if (!sessionCookie.startsWith('agentos_session=')) {
    throw new Error(`sign-in did not return a session cookie (got "${setCookie.slice(0, 60)}")`);
  }
  const role = result.json?.user?.role ?? 'unknown';
  console.log(`ok  [auth] signed in as ${SMOKE_EMAIL} (${role})`);
}

/* ── API endpoint audit ────────────────────────────────────────────────── */

async function checkEndpoint(method, url, { status = 200, body = null, label, redirect, noAuth = false } = {}) {
  const res = await originalFetch(new URL(url, BASE), {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(noAuth ? {} : authHeaders()),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: redirect ?? 'follow',
  });
  const text = await res.text();
  const accepted = Array.isArray(status) ? status.includes(res.status) : res.status === status;
  let ok = accepted;
  if (ok && res.status !== 204 && text && redirect !== 'manual') {
    try {
      JSON.parse(text);
    } catch {
      ok = false;
    }
  }
  console.log(`${ok ? 'ok ' : 'FAIL'} [api ${method} ${url}] -> ${res.status}`);
  if (!ok) throw new Error(`${label ?? url} returned ${res.status}: ${text.slice(0, 200)}`);
  return { status: res.status, text };
}

async function auditEndpoints() {
  console.log('--- api endpoints ---');
  // The gate first: no cookie, no console.
  await checkEndpoint('GET', '/api/agents', { status: 401, noAuth: true, label: 'agents without a session' });
  const authState = JSON.parse((await checkEndpoint('GET', '/api/auth/state', { label: 'auth state' })).text);
  if (!authState.authenticated) throw new Error('auth state says signed out after sign-in');
  // Admin routes answer 403 for a member, which is also a valid audit result.
  await checkEndpoint('GET', '/api/admin/users', { status: [200, 403], label: 'admin users' });
  await checkEndpoint('GET', '/api/admin/settings', { status: [200, 403], label: 'admin settings' });

  const config = JSON.parse((await checkEndpoint('GET', '/api/config', { label: 'config' })).text);
  await checkEndpoint('GET', '/api/agents', { label: 'list agents' });
  const created = JSON.parse(
    (await checkEndpoint('POST', '/api/agents', {
      status: [200, 201],
      body: {
        name: 'Endpoint Audit',
        description: 'audit',
        instructions: 'Be brief.',
        model: '',
        color: '#2dd4bf',
        enabledTools: [],
        teamAgentIds: [],
      },
      label: 'create agent',
    })).text,
  );
  await checkEndpoint('PUT', `/api/agents/${created.id}`, {
    status: 200,
    body: { name: 'Endpoint Audit 2' },
    label: 'update agent',
  });

  // Schedules: a cadence is validated before it is stored, pausing and
  // resuming round-trip, and "Run now" really starts a run.
  const preview = JSON.parse(
    (await checkEndpoint('POST', '/api/schedules/preview', {
      body: { cron: '0 9 * * 1-5' },
      label: 'schedule preview',
    })).text,
  );
  if (!preview.valid || preview.next.length !== 3) {
    throw new Error(`schedule preview did not return three firing times: ${JSON.stringify(preview)}`);
  }
  await checkEndpoint('POST', '/api/schedules/preview', {
    body: { cron: '0 99 * * *' },
    label: 'schedule preview rejects a bad cadence',
  });
  const schedule = JSON.parse(
    (await checkEndpoint('POST', '/api/schedules', {
      status: [200, 201],
      body: {
        agentId: created.id,
        name: 'Endpoint Audit Schedule',
        input: 'Reply with the single word: ok',
        cron: '0 9 * * 1-5',
      },
      label: 'create schedule',
    })).text,
  );
  if (!schedule.nextRunAt) throw new Error('a new enabled schedule must be armed with a next run');
  await checkEndpoint('GET', '/api/schedules', { label: 'list schedules' });
  await checkEndpoint('GET', `/api/schedules/${schedule.id}`, { label: 'get schedule' });
  const paused = JSON.parse(
    (await checkEndpoint('PUT', `/api/schedules/${schedule.id}`, {
      body: { enabled: false },
      label: 'pause schedule',
    })).text,
  );
  if (paused.enabled || paused.nextRunAt !== null) {
    throw new Error(`pausing a schedule must disarm it (${JSON.stringify(paused)})`);
  }
  await checkEndpoint('PUT', `/api/schedules/${schedule.id}`, {
    body: { enabled: true, cron: '*/30 * * * *' },
    label: 'resume schedule',
  });

  const fired = JSON.parse(
    (await checkEndpoint('POST', `/api/schedules/${schedule.id}/run`, {
      status: 202,
      label: 'run schedule now',
    })).text,
  );
  if (!fired.runId) throw new Error('run now did not return a run id');
  // The engine executes in the background: watch the run reach a terminal
  // state, which is what proves the scheduler actually drove it.
  let scheduledRun = null;
  for (let i = 0; i < 40; i++) {
    scheduledRun = JSON.parse((await checkEndpoint('GET', `/api/runs/${fired.runId}`, { label: 'scheduled run detail' })).text);
    if (scheduledRun.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  if (!scheduledRun || scheduledRun.status === 'running') {
    throw new Error('the scheduled run never finished');
  }
  console.log(`ok  [scheduler] run now executed the agent (${scheduledRun.status})`);
  const runList = JSON.parse((await checkEndpoint('GET', '/api/runs?limit=20', { label: 'runs with provenance' })).text);
  const tagged = runList.find((entry) => entry.id === fired.runId);
  if (!tagged || tagged.scheduleId !== schedule.id) {
    throw new Error('the fired run is not tagged with the schedule that started it');
  }

  await checkEndpoint('DELETE', `/api/schedules/${schedule.id}`, { status: 204, label: 'delete schedule' });

  await checkEndpoint('GET', '/api/runs', { label: 'list runs' });
  await checkEndpoint('POST', '/api/llm/test', {
    status: 200,
    body: { prompt: 'hi' },
    label: 'llm test',
  });
  await checkEndpoint('GET', '/api/google/auth-url?group=workspace', {
    status: [302, 303],
    redirect: 'manual',
    label: 'google auth-url',
  });
  // Only touch disconnect when there is nothing connected to lose.
  if (!config?.google?.connected) {
    await checkEndpoint('POST', '/api/google/disconnect', { label: 'google disconnect' });
  } else {
    console.log('skip [api POST /api/google/disconnect] (connected; not touching tokens)');
  }
  // Test endpoints return 400 with a JSON error when the integration is
  // unconfigured/unconnected — both are valid responses to audit.
  await checkEndpoint('POST', '/api/google/test', { status: [200, 400], label: 'google test' });
  await checkEndpoint('POST', '/api/github/test', { status: [200, 400], label: 'github test' });
  await checkEndpoint('POST', '/api/vercel/test', { status: [200, 400], label: 'vercel test' });
  await checkEndpoint('POST', '/api/supabase/test', { status: [200, 400], label: 'supabase test' });
  await checkEndpoint('DELETE', `/api/agents/${created.id}`, { status: 204, label: 'delete agent' });
  if (!config?.llm?.mock) {
    console.log('note: llm not in mock mode; the live-run check below still exercises /run');
  }
  const runs = JSON.parse((await checkEndpoint('GET', '/api/runs?limit=5', { label: 'runs again' })).text);
  for (const run of runs.slice(0, 2)) {
    await checkEndpoint('GET', `/api/runs/${run.id}`, { label: 'run detail' });
  }
}

/* ── UI audit ──────────────────────────────────────────────────────────── */

// Run with `node --conditions=browser smoke.mjs`: the `browser` condition
// makes the natively-imported node_modules (vite 8's dev SSR externalizes
// them) resolve @tanstack/router-core/isServer to its client build. Without
// it the `node` condition wins (isServer = true) and RouterProvider renders
// in server mode against a store jsdom never hydrates, which crashes.

const vite = await createServer({
  root: webRoot,
  logLevel: 'warn',
  server: { middlewareMode: true },
  appType: 'custom',
});

try {
  await authenticate();
  await auditEndpoints();

  const { run } = await vite.ssrLoadModule('/src/smoke-entry.tsx');
  await run(BASE, {
    /** Drop and restore the session cookie to walk through the login gate. */
    setAuth: (on) => {
      withAuth = on;
    },
  });
  await vite.close();
  console.log('SMOKE OK');
  // Some modules (SWR keepalive, etc.) may keep the loop alive; exit
  // explicitly after the vite server has been closed cleanly.
  setTimeout(() => process.exit(0), 300);
} catch (err) {
  console.error('SMOKE FAILED:', err instanceof Error ? err.message : err);
  await vite.close();
  setTimeout(() => process.exit(1), 300);
}
