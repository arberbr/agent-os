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
 */
import { createServer } from 'vite';
import { JSDOM } from 'jsdom';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.NODE_ENV = 'development';

const webRoot = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE ?? 'http://localhost:5173';

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

// Resolve the app's relative /api fetches against the target server.
const originalFetch = globalThis.fetch.bind(globalThis);
g.fetch = (input, init) => {
  const url = typeof input === 'string' ? new URL(input, BASE) : input;
  return originalFetch(url, init);
};
g.window.fetch = g.fetch;

/* ── API endpoint audit ────────────────────────────────────────────────── */

async function checkEndpoint(method, url, { status = 200, body = null, label, redirect } = {}) {
  const res = await originalFetch(new URL(url, BASE), {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
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
  await auditEndpoints();

  const { run } = await vite.ssrLoadModule('/src/smoke-entry.tsx');
  await run(BASE);
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
