/**
 * Smoke entry — loaded through Vite SSR so all plugins run.
 * StrictMode is intentionally enabled: this is the same configuration the
 * real app boots with in main.tsx.
 */
export async function run(_base: string): Promise<void> {
  const React = (await import('react')).default;
  const { createRoot } = await import('react-dom/client');
  const { RouterProvider } = await import('@tanstack/react-router');
  const { router } = await import('./router');

  // Wait for the router's initial match resolution before the first render:
  // RouterProvider reads stores that only exist after the async load settles,
  // and jsdom's synchronous history emits no further events to re-render.
  await router.load();

  const root = createRoot(document.getElementById('root')!);
  root.render(
    React.createElement(React.StrictMode, null, React.createElement(RouterProvider, { router })),
  );

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const flush = () => sleep(900);
  const bodyText = () => document.body.textContent ?? '';

  function check(route: string, expected: string[]) {
    const text = bodyText();
    for (const needle of expected) {
      if (!text.includes(needle)) {
        throw new Error(`[${route}] missing "${needle}"\n--- body ---\n${text.slice(0, 1500)}`);
      }
    }
    console.log(`ok  [${route}] contains: ${expected.join(' | ')}`);
  }

  function clickButton(label: string, tag = 'button', exact = false) {
    const target = Array.from(document.querySelectorAll(tag)).find((el) => {
      const text = (el.textContent ?? '').trim();
      return exact ? text === label : text.includes(label);
    });
    if (!target) throw new Error(`"${label}" ${tag} not found`);
    (target as HTMLElement).click();
    return target;
  }

  function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
  }

  await flush();
  check('/ (dashboard)', ['Agents OS', 'Dashboard', 'New agent', 'Agents', 'Runs', 'Integrations']);

  await router.navigate({ to: '/agents' });
  await flush();
  check('/agents', ['Agents', 'Roster']);

  await router.navigate({ to: '/agents/new' });
  await flush();
  check('/agents/new', ['New agent', 'Persona', 'Instructions', 'Tools', 'Team']);

  await router.navigate({ to: '/runs' });
  await flush();
  check('/runs', ['Runs', 'Status', 'Task']);

  // Runs interactions: status filter + search field.
  clickButton('Completed', 'button');
  await flush();
  const completedSegment = Array.from(document.querySelectorAll('button')).find(
    (el) => (el.textContent ?? '').includes('Completed') && el.getAttribute('aria-pressed') !== null,
  ) as HTMLButtonElement | null;
  if (!completedSegment || completedSegment.getAttribute('aria-pressed') !== 'true') {
    throw new Error('Completed filter segment did not activate');
  }
  clickButton('All', 'button');
  const searchInput = document.querySelector('input[type="search"]') as HTMLInputElement | null;
  if (!searchInput) throw new Error('run search input missing');
  setInputValue(searchInput, 'smoke');
  if (searchInput.value !== 'smoke') throw new Error('search input value not applied');
  console.log('ok  [runs] filter segments + search field work');

  await router.navigate({ to: '/integrations' });
  await flush();
  check('/integrations', ['Integrations', 'Google Workspace', 'GitHub', 'Vercel', 'Supabase', 'Model provider']);

  await router.navigate({ to: '/integrations', search: { google: 'connected' } });
  await flush();
  check('/integrations?google=connected', ['connected.']);

  await router.navigate({ to: '/agents/$id/run', params: { id: 'does-not-exist' } });
  await flush();
  check('/agents/:id/run (missing)', ['Agent not found']);

  // ── Editor interactions: toggle a tool, rename, save ───────────────────
  const created = await fetch('/api/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Smoke Agent',
      description: 'smoke test',
      instructions: 'Reply briefly.',
      model: '',
      color: '#2dd4bf',
      enabledTools: [],
      teamAgentIds: [],
    }),
  }).then((r) => r.json());
  const agentId: string = created?.id;
  if (!agentId) throw new Error('could not create smoke agent');

  await router.navigate({ to: '/agents/$id', params: { id: agentId } });
  await flush();
  check(`/agents/${agentId} (edit)`, ['Save changes', 'Smoke Agent']);

  // Radix renders the checkbox as a button[role=checkbox]; a plain click
  // toggles it (in real browsers and in jsdom alike).
  const firstToolCheckbox = document.querySelector('button[role="checkbox"]') as HTMLButtonElement | null;
  if (!firstToolCheckbox) throw new Error('tool checkbox missing');
  firstToolCheckbox.click();
  await flush();
  const matches = bodyText().match(/\d+ of \d+/g) ?? [];
  if (!matches.some((m) => m.startsWith('1 of '))) {
    throw new Error(`tool toggle did not update the count (found: ${matches.join(', ')})`);
  }

  const nameInput = document.querySelector('#agent-name') as HTMLInputElement | null;
  if (!nameInput) throw new Error('name input missing');
  setInputValue(nameInput, 'Smoke Agent Renamed');
  await sleep(150);
  clickButton('Save changes', 'button', true);
  await flush();
  check('/agents (after save)', ['Smoke Agent Renamed']);
  console.log('ok  [editor] checkbox toggle + rename + save work');

  // Delete confirm flow (cancel it), then launch the agent via its Run link.
  const trash = document.querySelector('button[aria-label="Delete Smoke Agent Renamed"]') as HTMLElement | null;
  if (!trash) throw new Error('delete button missing');
  trash.click();
  await flush();
  if (!bodyText().includes('Cancel')) throw new Error('delete confirm did not appear');
  clickButton('Cancel', 'button', true);
  await flush();
  const agentRow = Array.from(document.querySelectorAll('.row')).find((el) =>
    (el.textContent ?? '').includes('Smoke Agent Renamed'),
  );
  const runLink = agentRow?.querySelector('a') as HTMLAnchorElement | null;
  if (!runLink) throw new Error('Run link on smoke agent row missing');
  runLink.click();
  await flush();
  check(`/agents/${agentId}/run (via Run button)`, ['Smoke Agent Renamed', 'Give Smoke Agent Renamed a task', 'Activity']);
  console.log('ok  [agents] delete confirm + Run button navigation work');

  // ── Live chat flow ─────────────────────────────────────────────────────
  // A suggestion chip must fill the composer through the prompt controller.
  const suggestionButton = Array.from(document.querySelectorAll('button')).find((el) =>
    (el.textContent ?? '').includes('Summarize my unread emails'),
  );
  if (!suggestionButton) throw new Error('suggestion chip missing');
  (suggestionButton as HTMLElement).click();
  await flush();
  const textarea = document.querySelector('textarea') as HTMLTextAreaElement | null;
  if (!textarea) throw new Error('composer textarea missing');
  if (!textarea.value.includes('Summarize my unread emails')) {
    throw new Error('suggestion did not fill the composer');
  }
  console.log('ok  [chat] suggestion chip fills the composer');

  setInputValue(textarea, 'Reply with the single word: ready');
  await sleep(150);
  const form = document.querySelector('form');
  if (!form) throw new Error('composer form missing');
  form.requestSubmit();
  await flush();

  const text0 = bodyText();
  if (!text0.includes('Reply with the single word: ready')) {
    throw new Error('user message not rendered after submit\n' + text0.slice(0, 1000));
  }
  console.log('ok  [chat] user message rendered');

  // Wait for the run to finish: the assistant message renders the
  // "saved to history" badge only after the server's `done` event flows
  // through the transport as a data-agent part.
  let completed = false;
  let failed = false;
  for (let i = 0; i < 45 && !completed && !failed; i++) {
    await sleep(1000);
    const text = bodyText();
    completed = text.includes('saved to history');
    failed = text.includes('Run failed');
  }
  if (failed) {
    throw new Error('run reported failure:\n' + bodyText().slice(0, 1200));
  }
  if (!completed) {
    throw new Error('run did not complete in time\n' + bodyText().slice(0, 1200));
  }
  const stepCount = document.querySelectorAll('.log-row').length;
  console.log(`ok  [chat] run completed through the AI SDK transport (log rows: ${stepCount})`);
  check('[chat final]', ['Reply with the single word: ready']);

  // The run must now appear in the history with a working detail screen.
  await router.navigate({ to: '/runs' });
  await flush();
  const historyRunLink = document.querySelector('table a') as HTMLAnchorElement | null;
  if (!historyRunLink) throw new Error('no run link found in history table');
  historyRunLink.click();
  await flush();
  check('/runs?run=…', ['Output', 'Activity']);

  // ── History: a session can be removed ──────────────────────────────────
  await router.navigate({ to: '/runs' });
  await flush();
  const rowsBefore = document.querySelectorAll('table tbody tr').length;
  const removeButton = Array.from(document.querySelectorAll('button[aria-label^="Remove "]'))[0];
  if (!removeButton) throw new Error('row remove button missing');
  (removeButton as HTMLElement).click();
  await flush();
  clickButton('Remove', 'button', true);
  await flush();
  const rowsAfter = document.querySelectorAll('table tbody tr').length;
  if (rowsAfter >= rowsBefore) {
    throw new Error(`session was not removed (rows ${rowsBefore} -> ${rowsAfter})`);
  }
  console.log(`ok  [runs] session removal works (${rowsBefore} -> ${rowsAfter} rows)`);

  await fetch(`/api/agents/${agentId}`, { method: 'DELETE' });
}
