/**
 * Smoke entry — loaded through Vite SSR so all plugins run.
 * StrictMode is intentionally enabled: this is the same configuration the
 * real app boots with in main.tsx.
 *
 * `control.setAuth(false)` makes the shared fetch wrapper stop sending the
 * session cookie, which is how the login gate below is exercised.
 */
export async function run(
  _base: string,
  control: { setAuth: (on: boolean) => void } = { setAuth: () => {} },
): Promise<void> {
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
  check('/ (dashboard)', ['Agents OS', 'Dashboard', 'New agent', 'Agents', 'Runs', 'Schedules', 'Integrations']);

  // ── The gate: without a session the console must give way to the login card
  const authState = (await (await fetch('/api/auth/state')).json()) as {
    user: { role: string; email: string } | null;
  };
  const role = authState.user?.role ?? 'member';
  const signedInEmail = authState.user?.email ?? '';
  const signedOut = () => window.dispatchEvent(new window.Event('agentos:unauthorized'));

  control.setAuth(false);
  signedOut();
  await flush();
  check('(signed out)', ['Agents OS', 'Sign in', 'Email', 'Password']);
  if (bodyText().includes('Dashboard')) {
    throw new Error('the console rendered while signed out');
  }
  console.log('ok  [auth] signed-out visitors get the login screen');

  control.setAuth(true);
  signedOut();
  await flush();
  check('(signed in again)', ['Dashboard', signedInEmail]);
  console.log('ok  [auth] signing back in restores the console');

  await router.navigate({ to: '/agents' });
  await flush();
  // A fresh instance legitimately has no agents yet; the roster only exists
  // once there is at least one.
  if (!bodyText().includes('Roster') && !bodyText().includes('No agents yet')) {
    throw new Error(`[/agents] neither the roster nor the empty state rendered\n--- body ---\n${bodyText().slice(0, 1200)}`);
  }
  console.log('ok  [/agents] roster or empty state rendered');

  await router.navigate({ to: '/agents/new' });
  await flush();
  check('/agents/new', ['New agent', 'Persona', 'Instructions', 'Tools', 'Team']);

  await router.navigate({ to: '/runs' });
  await flush();
  // The history table (and its filters) only render once a session exists.
  const runsText = bodyText();
  if (runsText.includes('No runs yet')) {
    console.log('ok  [/runs] empty history rendered');
  } else {
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
  }

  await router.navigate({ to: '/integrations' });
  await flush();
  check('/integrations', ['Integrations', 'Google Workspace', 'GitHub', 'Vercel', 'Supabase', 'Model provider']);

  await router.navigate({ to: '/integrations', search: { google: 'connected' } });
  await flush();
  check('/integrations?google=connected', ['connected.']);

  // ── Settings: everyone gets their account, admins get the instance panels
  await router.navigate({ to: '/settings' });
  await flush();
  const settingsText = role === 'admin'
    ? ['Settings', 'Access', 'People', 'Account']
    : ['Settings', 'Account'];
  check('/settings', settingsText);
  if (role !== 'admin') {
    console.log('ok  [settings] rendered for member');
  } else {
    // The admin's headline control: flip signups off, save, and confirm both
    // the panel and the API agree — then put it back.
    const readSignups = async () => {
      const res = (await (await fetch('/api/admin/settings')).json()) as {
        settings: { signupsEnabled: boolean };
      };
      return res.settings.signupsEnabled;
    };
    const signupToggle = () =>
      document.querySelector('button[role="checkbox"]') as HTMLButtonElement | null;

    const before = await readSignups();
    if (!signupToggle()) throw new Error('the signups toggle is missing from the access panel');
    signupToggle()!.click();
    await sleep(150);
    clickButton('Save changes', 'button', true);
    await flush();

    const after = await readSignups();
    if (after === before) throw new Error('saving the signups toggle did not change the setting');
    const label = after ? 'Signups open' : 'Signups closed';
    if (!bodyText().includes(label)) throw new Error(`the access panel still does not show "${label}"`);

    signupToggle()!.click();
    await sleep(150);
    clickButton('Save changes', 'button', true);
    await flush();
    if ((await readSignups()) !== before) throw new Error('the signups setting could not be restored');
    console.log(`ok  [settings] signups toggle round-tripped (${before} → ${after} → ${before})`);
  }

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

  // ── A second message must continue the same session ────────────────────
  // The transport learned the session id from the first turn's `start` event;
  // sending another message must append to that session instead of opening a
  // new one, and the model must receive the first turn as history.
  const sessionsForAgent = async () => {
    const runs = JSON.parse((await (await fetch('/api/runs?limit=200')).text()) as string) as Array<{
      id: string;
      agentId: string;
    }>;
    return runs.filter((entry) => entry.agentId === agentId);
  };

  const sessionsAfterFirst = await sessionsForAgent();
  if (sessionsAfterFirst.length !== 1 || !sessionsAfterFirst[0]) {
    throw new Error(`expected exactly one session after the first turn, found ${sessionsAfterFirst.length}`);
  }
  const sessionId = sessionsAfterFirst[0].id;
  const messagesAfterFirst = (JSON.parse((await (await fetch(`/api/runs/${sessionId}`)).text()) as string) as {
    messages: unknown[];
  }).messages.length;

  const composer = document.querySelector('textarea') as HTMLTextAreaElement | null;
  const composerForm = document.querySelector('form');
  if (!composer || !composerForm) throw new Error('composer missing for the second turn');
  setInputValue(composer, 'Reply with the single word: continued');
  await sleep(150);
  composerForm.requestSubmit();

  let continued = false;
  for (let i = 0; i < 45 && !continued; i++) {
    await sleep(1000);
    const detail = JSON.parse((await (await fetch(`/api/runs/${sessionId}`)).text()) as string) as {
      status: string;
      messages: unknown[];
    };
    if (detail.status === 'failed') throw new Error('the second turn failed');
    continued = detail.status === 'completed' && detail.messages.length > messagesAfterFirst;
  }
  if (!continued) throw new Error('the second message did not continue the session');
  await flush();

  const sessionsAfterSecond = await sessionsForAgent();
  if (sessionsAfterSecond.length !== 1 || sessionsAfterSecond[0]?.id !== sessionId) {
    throw new Error(`the second message opened a new session (${sessionsAfterSecond.length} sessions now)`);
  }
  if (!bodyText().includes('Reply with the single word: ready')) {
    throw new Error('the first turn disappeared from the chat after the second turn');
  }
  console.log(`ok  [chat] second message continued the session (2 turns, 1 session ${sessionId.slice(0, 8)})`);

  // The run must now appear in the history with a working detail screen.
  await router.navigate({ to: '/runs' });
  await flush();
  const historyHeaders = Array.from(document.querySelectorAll('table th')).map((el) => (el.textContent ?? '').trim());
  if (!historyHeaders.includes('By')) {
    throw new Error(`run history is missing the creator column (headers: ${historyHeaders.join(', ')})`);
  }
  const creatorCells = Array.from(document.querySelectorAll('table tbody tr')).map((row) =>
    (row.textContent ?? '').includes(signedInEmail),
  );
  if (!creatorCells.some(Boolean)) {
    throw new Error(`run history does not attribute the session to ${signedInEmail}`);
  }
  console.log('ok  [runs] history attributes each session to its account');
  const historyRunLink = document.querySelector('table a') as HTMLAnchorElement | null;
  if (!historyRunLink) throw new Error('no run link found in history table');
  historyRunLink.click();
  await flush();
  check('/runs?run=…', ['Conversation', 'Activity']);

  // Opening the session from history must show the whole conversation, not
  // just the answer to the last request.
  await router.navigate({ to: '/runs', search: { run: sessionId } });
  await flush();
  const transcriptText = bodyText();
  if (!transcriptText.includes('Reply with the single word: ready')) {
    throw new Error('session history lost its first turn\n' + transcriptText.slice(0, 1200));
  }
  if (!transcriptText.includes('Reply with the single word: continued')) {
    throw new Error('session history lost its last turn');
  }
  console.log('ok  [runs] session detail replays every turn of the conversation');

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

  // ── Schedules: build one in the editor, pause it, then remove it ────────
  await router.navigate({ to: '/schedules' });
  await flush();
  check('/schedules', ['Schedules', 'New schedule']);
  clickButton('New schedule', 'button');
  await flush();
  check('/schedules (editor)', ['Agent', 'Task', 'Cadence', 'Create schedule']);

  const scheduleTask = document.querySelector('#schedule-input') as HTMLTextAreaElement | null;
  const scheduleName = document.querySelector('#schedule-name') as HTMLInputElement | null;
  if (!scheduleTask || !scheduleName) throw new Error('schedule editor fields missing');
  setInputValue(scheduleTask, 'Reply with the single word: scheduled');
  setInputValue(scheduleName, 'Smoke schedule');

  // The cadence is validated server-side as it is typed: a bad expression is
  // reported (and Save blocked) before anything is stored.
  clickButton('Custom cron', 'button');
  await flush();
  const cronInput = document.querySelector('input[aria-label="Cron expression"]') as HTMLInputElement | null;
  if (!cronInput) throw new Error('custom cron input missing');
  setInputValue(cronInput, '0 99 * * *');
  await sleep(900);
  if (!bodyText().includes('out of range for the hour field')) {
    throw new Error('an invalid cadence was not reported in the editor');
  }
  // A far-future yearly cadence: nothing fires while this test runs.
  setInputValue(cronInput, '0 4 1 1 *');
  await sleep(900);
  if (!bodyText().includes('Yearly on January 1 at 04:00')) {
    throw new Error(`the cadence preview did not describe the custom cron\n--- body ---\n${bodyText().slice(0, 1200)}`);
  }
  clickButton('Create schedule', 'button', true);
  await flush();
  if (!bodyText().includes('Smoke schedule')) throw new Error('the created schedule is not in the list');
  console.log('ok  [/schedules] created a schedule through the editor');

  const pauseToggle = document.querySelector('button[aria-label^="Pause Smoke schedule"]') as HTMLButtonElement | null;
  if (!pauseToggle) throw new Error('schedule pause toggle missing');
  pauseToggle.click();
  await flush();
  if (!bodyText().includes('Paused')) throw new Error('pausing the schedule did not show a paused state');
  console.log('ok  [/schedules] the pause toggle disarms the cadence');

  const scheduleDelete = document.querySelector('button[aria-label="Delete Smoke schedule"]') as HTMLElement | null;
  if (!scheduleDelete) throw new Error('schedule delete button missing');
  scheduleDelete.click();
  await flush();
  clickButton('Remove', 'button', true);
  await flush();
  if (bodyText().includes('Smoke schedule')) throw new Error('the schedule was not removed');
  console.log('ok  [/schedules] delete removes the schedule');

  await fetch(`/api/agents/${agentId}`, { method: 'DELETE' });
}
