/**
 * End-to-end verification of the notification feature against a running server.
 *
 *   node verify-notifications.mjs http://localhost:8799
 *
 * Stands up a real SMTP listener, enters the credentials through the admin API
 * exactly as the Settings page does, then fires a schedule and asserts that a
 * notification email actually crossed the wire — and that the schedule recorded
 * it. Not part of the repo: a one-off proof.
 */
import net from 'node:net';

const BASE = process.argv[2] ?? 'http://localhost:8799';
const EMAIL = 'smoke@agent-os.test';
const PASSWORD = 'smoke-password';

let failures = 0;
const ok = (label, detail = '') => console.log(`ok   ${label}${detail ? ` — ${detail}` : ''}`);
const bad = (label, detail = '') => {
  failures++;
  console.error(`FAIL ${label}${detail ? ` — ${detail}` : ''}`);
};
const assert = (condition, label, detail = '') => (condition ? ok(label, detail) : bad(label, detail));

/* ── A real SMTP listener ──────────────────────────────────────────────── */

const messages = [];

const smtp = net.createServer((socket) => {
  let buffer = '';
  let inData = false;
  let data = '';
  const current = { from: '', to: [], data: '' };

  socket.setEncoding('utf8');
  socket.write('220 verify.local ESMTP\r\n');

  socket.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      if (inData) {
        const end = buffer.indexOf('\r\n.\r\n');
        if (end === -1) {
          if (buffer.length > 4) {
            data += buffer.slice(0, -4);
            buffer = buffer.slice(-4);
          }
          return;
        }
        data += buffer.slice(0, end);
        buffer = buffer.slice(end + 5);
        inData = false;
        current.data = data.replace(/^\.\./gm, '.');
        messages.push({ ...current, to: [...current.to] });
        data = '';
        socket.write('250 2.0.0 Ok: queued\r\n');
        continue;
      }
      const newline = buffer.indexOf('\r\n');
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 2);
      const [verb = '', ...rest] = line.split(' ');
      const command = verb.toUpperCase();
      const arg = rest.join(' ');

      if (command === 'EHLO' || command === 'HELO') {
        socket.write('250-verify.local\r\n250 AUTH PLAIN\r\n');
      } else if (command === 'AUTH') {
        const decoded = arg.includes(' ') ? Buffer.from(arg.split(' ')[1] ?? '', 'base64').toString('utf8') : '';
        const [, user = '', pass = ''] = decoded.split('\u0000');
        if (user === 'agents' && pass === 's3cret') socket.write('235 2.7.0 Authentication successful\r\n');
        else socket.write('535 5.7.8 Username and Password not accepted\r\n');
      } else if (command === 'MAIL') {
        current.from = (/<([^>]*)>/.exec(arg)?.[1] ?? '').trim();
        socket.write('250 2.1.0 Sender ok\r\n');
      } else if (command === 'RCPT') {
        current.to.push((/<([^>]*)>/.exec(arg)?.[1] ?? '').trim());
        socket.write('250 2.1.5 Recipient ok\r\n');
      } else if (command === 'DATA') {
        inData = true;
        socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
      } else if (command === 'QUIT') {
        socket.write('221 2.0.0 Bye\r\n');
        socket.end();
      } else {
        socket.write('250 2.0.0 Ok\r\n');
      }
    }
  });
  socket.on('error', () => {});
});

await new Promise((resolve) => smtp.listen(0, '127.0.0.1', resolve));
const smtpPort = smtp.address().port;
ok('smtp listener', `127.0.0.1:${smtpPort}`);

/* ── HTTP helpers ──────────────────────────────────────────────────────── */

let cookie = '';
async function call(method, path, body) {
  const res = await fetch(new URL(path, BASE), {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json, text, headers: res.headers };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Decode a raw RFC 5322 message the way a mail client would: unfold the
 * encoded-word headers and decode each MIME part. A non-ASCII subject ("—") and
 * any body are transfer-encoded on the wire, so asserting on the raw DATA block
 * would fail for the wrong reason.
 */
function decodeQuotedPrintable(text) {
  const bytes = [];
  const unfolded = text.replace(/=\r?\n/g, '');
  for (let i = 0; i < unfolded.length; i++) {
    const hex = unfolded.slice(i + 1, i + 3);
    if (unfolded[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(...Buffer.from(unfolded[i], 'utf8'));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** RFC 2047 encoded words, including the folding whitespace between them. */
function decodeEncodedWords(value) {
  return value
    .replace(/\?=\s+(?==\?)/g, '?=')
    .replace(/=\?UTF-8\?([BQ])\?([^?]*)\?=/gi, (_, kind, payload) =>
      kind.toUpperCase() === 'B'
        ? Buffer.from(payload, 'base64').toString('utf8')
        : decodeQuotedPrintable(payload.replace(/_/g, ' ')),
    );
}

function decodeMessage(raw) {
  const split = raw.indexOf('\r\n\r\n');
  const rawHeaders = split === -1 ? raw : raw.slice(0, split);
  const rawBody = split === -1 ? '' : raw.slice(split + 4);

  const headers = decodeEncodedWords(rawHeaders);

  const decode = (partHeaders, content) => {
    if (/Content-Transfer-Encoding:\s*base64/i.test(partHeaders)) {
      return Buffer.from(content.replace(/\r?\n/g, ''), 'base64').toString('utf8');
    }
    if (/Content-Transfer-Encoding:\s*quoted-printable/i.test(partHeaders)) {
      return decodeQuotedPrintable(content);
    }
    return content;
  };

  const boundary = /boundary="?([^"\r\n;]+)"?/i.exec(rawHeaders)?.[1];
  if (!boundary) return { headers, parts: [decode(rawHeaders, rawBody)] };

  const parts = [];
  for (const chunk of rawBody.split(`--${boundary}`)) {
    const inner = chunk.indexOf('\r\n\r\n');
    if (inner === -1) continue;
    parts.push(decode(chunk.slice(0, inner), chunk.slice(inner + 4)));
  }
  return { headers, parts };
}

/* ── The run ───────────────────────────────────────────────────────────── */

const login = await call('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });
if (login.status !== 200) {
  console.error(`could not sign in (${login.status}): ${login.text.slice(0, 200)}`);
  process.exit(1);
}
cookie = (login.headers.getSetCookie?.()[0] ?? '').split(';')[0];
ok('signed in', EMAIL);

// 1. Enter SMTP credentials exactly as the Settings page posts them.
const saved = await call('PUT', '/api/admin/mail', {
  enabled: true,
  host: '127.0.0.1',
  port: smtpPort,
  security: 'none',
  username: 'agents',
  password: 's3cret',
  fromName: 'Agents OS',
  fromEmail: 'agents@example.com',
  replyTo: 'nobody@example.com',
  verifyCertificate: true,
});
assert(saved.status === 200, 'saving credentials is accepted', `HTTP ${saved.status}`);
assert(saved.json?.mail?.configured === true, 'the relay reports as configured');
assert(saved.json?.mail?.hasPassword === true, 'a password is on file');
assert(!JSON.stringify(saved.json).includes('s3cret'), 'the password is never echoed back');

// The password must survive an unrelated save (blank field = keep it).
const resaved = await call('PUT', '/api/admin/mail', { fromName: 'Agents OS Notifier' });
assert(resaved.json?.mail?.hasPassword === true, 'an unrelated save keeps the saved password');
assert(resaved.json?.mail?.fromName === 'Agents OS Notifier', 'the edit itself was applied');

// 2. The test button: connect, authenticate, deliver.
const tested = await call('POST', '/api/admin/mail/test', { to: 'verify@example.com' });
assert(tested.status === 200, 'the test endpoint reports success', `HTTP ${tested.status}`);
assert(tested.json?.checks?.connection?.ok === true, 'connection check passed');
assert(tested.json?.checks?.delivery?.ok === true, 'delivery check passed');
assert(messages.length === 1, 'the test message reached the relay', `${messages.length} message(s)`);

// Bad credentials must be refused with an actionable message.
await call('PUT', '/api/admin/mail', { password: 'wrong' });
const rejected = await call('POST', '/api/admin/mail/test', {});
assert(rejected.status === 502, 'a wrong password fails the test', `HTTP ${rejected.status}`);
assert(
  /rejected those credentials|app-specific password/.test(JSON.stringify(rejected.json)),
  'the failure explains itself',
  rejected.json?.checks?.connection?.error,
);
await call('PUT', '/api/admin/mail', { password: 's3cret' });
const restored = await call('POST', '/api/admin/mail/test', {});
assert(restored.status === 200, 'restoring the password works again');

// 3. A schedule that asks to be notified, fired by hand.
const agent = await call('POST', '/api/agents', {
  name: 'Notification Verify',
  description: 'verification',
  instructions: 'Reply briefly.',
  model: '',
  color: '#2dd4bf',
  enabledTools: [],
  teamAgentIds: [],
});
assert(agent.status === 201, 'a test agent exists');

const schedule = await call('POST', '/api/schedules', {
  agentId: agent.json.id,
  name: 'Notification Verify Schedule',
  input: 'Reply with the single word: notified',
  cron: '0 3 1 1 *',
  notifyOn: 'always',
  notifyEmails: ['ops@example.com'],
});
assert(schedule.status === 201, 'a schedule with notifications is accepted', `HTTP ${schedule.status}`);
assert(schedule.json?.notifyOn === 'always', 'the notify mode round-tripped');
assert(
  (schedule.json?.notifyRecipients ?? []).includes('ops@example.com') &&
    (schedule.json?.notifyRecipients ?? []).includes(EMAIL),
  'both the extra address and the creator are recipients',
  JSON.stringify(schedule.json?.notifyRecipients),
);

const before = messages.length;
const fired = await call('POST', `/api/schedules/${schedule.json.id}/run`);
assert(fired.status === 202, 'Run now started', `HTTP ${fired.status}`);

// Wait for the run to settle and the notification to go out.
let run = null;
for (let i = 0; i < 40; i++) {
  run = (await call('GET', `/api/runs/${fired.json.runId}`)).json;
  if (run?.status !== 'running' && messages.length > before) break;
  await sleep(500);
}
assert(run?.status === 'completed', 'the scheduled run completed', `status: ${run?.status}`);
assert(messages.length > before, 'a notification was delivered', `${messages.length - before} message(s)`);

const notification = messages[messages.length - 1];
assert(
  notification.to.includes(EMAIL) && notification.to.includes('ops@example.com'),
  'it went to the creator and the extra address',
  notification.to.join(', '),
);
assert(notification.from === 'agents@example.com', 'the envelope sender is the configured From', notification.from);

const decoded = decodeMessage(notification.data);
assert(
  /^Subject: \[Agents OS\] Notification Verify Schedule — completed$/m.test(decoded.headers),
  'the subject names the schedule and the outcome',
  /^Subject: .*$/m.exec(decoded.headers)?.[0],
);
assert(
  /Reply-To: nobody@example\.com/i.test(decoded.headers),
  'the reply-to from Settings is carried',
);
assert(
  decoded.parts.some((part) => part.includes(`/runs?run=${fired.json.runId}`)),
  'the email links back to the run',
);
assert(
  decoded.parts.some((part) => part.includes('Reply with the single word: notified')),
  'the email carries the task the agent was given',
);
assert(
  decoded.parts.some((part) => /<!doctype html>/i.test(part)),
  'an HTML alternative is included',
);
assert(
  decoded.parts.some((part) => /AGENTS OS · SCHEDULED RUN COMPLETED/.test(part)),
  'and a plaintext alternative for clients that refuse HTML',
);

const settled = (await call('GET', `/api/schedules/${schedule.json.id}`)).json;
assert(Boolean(settled?.lastNotifyAt), 'the schedule records when it notified', settled?.lastNotifyAt);
assert(settled?.lastNotifyError === null, 'and records no error', String(settled?.lastNotifyError));

// 4. Switching to "Never" must stop the mail.
await call('PUT', `/api/schedules/${schedule.json.id}`, { notifyOn: 'never' });
const beforeQuiet = messages.length;
const quiet = await call('POST', `/api/schedules/${schedule.json.id}/run`);
for (let i = 0; i < 40; i++) {
  const current = (await call('GET', `/api/runs/${quiet.json.runId}`)).json;
  if (current?.status !== 'running') break;
  await sleep(500);
}
await sleep(1200);
assert(
  messages.length === beforeQuiet,
  'a schedule set to Never sends nothing',
  `${messages.length - beforeQuiet} message(s)`,
);

// 5. Removing the relay must leave the schedule intact but unable to report.
const cleared = await call('DELETE', '/api/admin/mail');
assert(cleared.json?.mail?.configured === false, 'credentials can be removed');
assert(cleared.json?.mail?.hasPassword === false, 'and the password goes with them');
const refused = await call('PUT', `/api/schedules/${schedule.json.id}`, { notifyOn: 'failure' });
assert(refused.status === 400, 'asking for notifications without a relay is refused', `HTTP ${refused.status}`);

// Clean up.
await call('DELETE', `/api/schedules/${schedule.json.id}`);
await call('DELETE', `/api/agents/${agent.json.id}`);

smtp.close();
console.log(failures === 0 ? '\nNOTIFICATION VERIFY OK' : `\nNOTIFICATION VERIFY FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
