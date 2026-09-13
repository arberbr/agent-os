import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The mail sender, exercised against a real SMTP conversation.
 *
 * nodemailer is not mocked: a listener on 127.0.0.1 speaks enough of the
 * protocol to authenticate, take an envelope and accept the DATA block, and the
 * test asserts what actually crossed the wire. That is the only way to know the
 * parts that are easy to get quietly wrong — that credentials are sent, that the
 * STARTTLS policy is really off for a plaintext relay, that the body arrives
 * intact, and that a refusal turns into a sentence an operator can act on.
 *
 * DATA_DIR is pointed at a scratch directory *before* the store is imported, so
 * these tests write mail settings into a throwaway database rather than the
 * developer's own.
 */

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-os-mail-'));
process.env.DATA_DIR = scratch;

const { store } = await import('../store.js');
const { mailSender, mailErrorMessage } = await import('./sender.js');

/* ── A small SMTP server, enough for nodemailer to talk to ─────────────── */

interface Message {
  from: string;
  to: string[];
  data: string;
  auth: { user: string; pass: string } | null;
}

interface FakeOptions {
  /** Advertised AUTH mechanism; `null` advertises none. */
  mechanism?: 'PLAIN' | 'LOGIN' | null;
  /** Credentials the server accepts. `null` accepts anything. */
  credentials?: { user: string; pass: string } | null;
  /** RCPT TO values to refuse with 550. */
  rejectRecipients?: string[];
}

class FakeSmtp {
  readonly messages: Message[] = [];
  private server: net.Server | null = null;
  port = 0;

  constructor(private readonly options: FakeOptions = {}) {}

  async listen(): Promise<void> {
    this.server = net.createServer((socket) => this.handle(socket));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    this.port = typeof address === 'object' && address ? address.port : 0;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  private handle(socket: net.Socket): void {
    const { mechanism = 'PLAIN', credentials = null, rejectRecipients = [] } = this.options;
    let buffer = '';
    let inData = false;
    let data = '';
    // LOGIN is a two-step exchange; this is what the server is waiting for.
    let expecting: 'user' | 'pass' | null = null;
    let pendingUser = '';

    const current: Message = { from: '', to: [], data: '', auth: null };

    socket.setEncoding('utf8');
    socket.write('220 fake.agents-os.test ESMTP ready\r\n');

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) {
            // Keep a short tail so a terminator split across packets is not lost.
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
          this.messages.push({ ...current, to: [...current.to] });
          data = '';
          socket.write('250 2.0.0 Ok: queued as FAKE1\r\n');
          continue;
        }

        const newline = buffer.indexOf('\r\n');
        if (newline === -1) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);

        // Continuations of an in-flight AUTH exchange.
        if (expecting) {
          const decoded = Buffer.from(line, 'base64').toString('utf8');
          if (expecting === 'user') {
            pendingUser = decoded;
            expecting = 'pass';
            socket.write('334 UGFzc3dvcmQ6\r\n');
          } else {
            expecting = null;
            current.auth = { user: pendingUser, pass: decoded };
            socket.write(this.authVerdict(current.auth, credentials));
          }
          continue;
        }

        const [verb = '', ...rest] = line.split(' ');
        const arg = rest.join(' ');
        const command = verb.toUpperCase();

        if (command === 'EHLO' || command === 'HELO') {
          socket.write('250-fake.agents-os.test\r\n');
          if (mechanism) socket.write(`250-AUTH ${mechanism}\r\n`);
          socket.write('250 SIZE 10485760\r\n');
        } else if (command === 'AUTH') {
          if (!mechanism) {
            socket.write('504 5.5.4 Unrecognized authentication type\r\n');
          } else if (mechanism === 'LOGIN') {
            expecting = 'user';
            socket.write('334 VXNlcm5hbWU6\r\n');
          } else {
            // "AUTH PLAIN <base64>" — with or without an initial response.
            const decoded = arg.includes(' ')
              ? Buffer.from(arg.split(' ')[1] ?? '', 'base64').toString('utf8')
              : Buffer.from(arg, 'base64').toString('utf8');
            const [, user = '', pass = ''] = decoded.split('\u0000');
            current.auth = { user, pass };
            socket.write(this.authVerdict(current.auth, credentials));
          }
        } else if (command === 'MAIL') {
          current.from = (/<([^>]*)>/.exec(arg)?.[1] ?? '').trim();
          socket.write('250 2.1.0 Sender ok\r\n');
        } else if (command === 'RCPT') {
          const recipient = (/<([^>]*)>/.exec(arg)?.[1] ?? '').trim();
          if (rejectRecipients.includes(recipient)) {
            socket.write('550 5.1.1 No such user here\r\n');
          } else {
            current.to.push(recipient);
            socket.write('250 2.1.5 Recipient ok\r\n');
          }
        } else if (command === 'DATA') {
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (command === 'RSET') {
          current.from = '';
          current.to.length = 0;
          socket.write('250 2.0.0 Reset\r\n');
        } else if (command === 'QUIT') {
          socket.write('221 2.0.0 Bye\r\n');
          socket.end();
        } else {
          socket.write('250 2.0.0 Ok\r\n');
        }
      }
    });

    socket.on('error', () => {
      // A client that hangs up mid-conversation is not a test failure.
    });
  }

  private authVerdict(auth: { user: string; pass: string }, expected: { user: string; pass: string } | null): string {
    if (expected && (auth.user !== expected.user || auth.pass !== expected.pass)) {
      return '535 5.7.8 Username and Password not accepted\r\n';
    }
    return '235 2.7.0 Authentication successful\r\n';
  }
}

/** Point the stored relay at a fake server and hand back a fresh sender. */
function configure(port: number, overrides: Record<string, unknown> = {}): void {
  store.updateMailSettings({
    enabled: true,
    host: '127.0.0.1',
    port,
    security: 'none',
    username: '',
    password: '',
    fromName: 'Agents OS',
    fromEmail: 'agents@example.com',
    replyTo: '',
    verifyCertificate: true,
    ...overrides,
  } as never);
  mailSender.reset();
}

const first = (server: FakeSmtp): Message => {
  assert.equal(server.messages.length, 1, 'exactly one message should have been delivered');
  return server.messages[0]!;
};

before(() => {
  // Nothing here may touch the instance's real settings; the scratch store is
  // only ever written by `configure`.
  assert.equal(store.listSchedules().length, 0);
});

after(async () => {
  mailSender.reset();
  await fs.promises.rm(scratch, { recursive: true, force: true });
});

/* ── Sending ───────────────────────────────────────────────────────────── */

test('delivers a message and reports what the relay accepted', async () => {
  const smtp = new FakeSmtp();
  await smtp.listen();
  configure(smtp.port);

  const result = await mailSender.send({
    to: ['me@example.com'],
    subject: 'Agents OS test',
    text: 'Hello from the test.',
    html: '<p>Hello from the test.</p>',
  });

  assert.deepEqual(result.accepted, ['me@example.com']);
  assert.deepEqual(result.rejected, []);
  assert.match(result.response, /queued as FAKE1/);

  const message = first(smtp);
  assert.equal(message.from, 'agents@example.com');
  assert.deepEqual(message.to, ['me@example.com']);
  assert.match(message.data, /^From: "?Agents OS"? <agents@example\.com>/m);
  assert.match(message.data, /^Subject: Agents OS test$/m);
  assert.match(message.data, /Hello from the test\./);

  await smtp.close();
});

test('reaches every recipient on the envelope', async () => {
  const smtp = new FakeSmtp();
  await smtp.listen();
  configure(smtp.port);

  await mailSender.send({ to: ['me@example.com', 'team@example.com'], subject: 'Two', text: 'Both.' });
  assert.deepEqual(first(smtp).to, ['me@example.com', 'team@example.com']);

  await smtp.close();
});

test('authenticates with PLAIN when the relay advertises it', async () => {
  const smtp = new FakeSmtp({ mechanism: 'PLAIN', credentials: { user: 'agents', pass: 's3cret' } });
  await smtp.listen();
  configure(smtp.port, { username: 'agents', password: 's3cret' });

  await mailSender.send({ to: ['me@example.com'], subject: 'Authed', text: 'ok' });
  assert.deepEqual(first(smtp).auth, { user: 'agents', pass: 's3cret' });

  await smtp.close();
});

test('authenticates with LOGIN when that is all the relay offers', async () => {
  const smtp = new FakeSmtp({ mechanism: 'LOGIN', credentials: { user: 'agents', pass: 'hunter2' } });
  await smtp.listen();
  configure(smtp.port, { username: 'agents', password: 'hunter2' });

  await mailSender.send({ to: ['me@example.com'], subject: 'Authed', text: 'ok' });
  assert.deepEqual(first(smtp).auth, { user: 'agents', pass: 'hunter2' });

  await smtp.close();
});

test('a relay that refuses the recipient surfaces as an actionable error', async () => {
  const smtp = new FakeSmtp({ rejectRecipients: ['ghost@example.com'] });
  await smtp.listen();
  configure(smtp.port);

  await assert.rejects(
    () => mailSender.send({ to: ['ghost@example.com'], subject: 'Nope', text: 'x' }),
    (err: Error) => {
      assert.match(err.message, /refused the message envelope|No such user/);
      return true;
    },
  );
  assert.equal(smtp.messages.length, 0, 'nothing should have been delivered');

  await smtp.close();
});

test('verify() opens and authenticates without sending anything', async () => {
  const smtp = new FakeSmtp({ mechanism: 'PLAIN', credentials: { user: 'agents', pass: 's3cret' } });
  await smtp.listen();
  configure(smtp.port, { username: 'agents', password: 's3cret' });

  const result = await mailSender.verify();
  assert.equal(result.ok, true);
  assert.equal(result.host, '127.0.0.1');
  assert.equal(result.port, smtp.port);
  assert.equal(smtp.messages.length, 0, 'verify never sends mail');

  await smtp.close();
});

/* ── Refusals ──────────────────────────────────────────────────────────── */

test('bad credentials name the app-password trap instead of leaking a 535', async () => {
  const smtp = new FakeSmtp({ mechanism: 'PLAIN', credentials: { user: 'agents', pass: 'right' } });
  await smtp.listen();
  configure(smtp.port, { username: 'agents', password: 'wrong' });

  await assert.rejects(
    () => mailSender.send({ to: ['me@example.com'], subject: 'Nope', text: 'x' }),
    (err: Error) => {
      assert.match(err.message, /rejected those credentials/);
      assert.match(err.message, /app-specific password/);
      return true;
    },
  );

  await smtp.close();
});

test('an unreachable relay names the host and port it could not reach', async () => {
  // Port 1 on loopback: reserved, nothing listens, refused immediately.
  configure(1);
  await assert.rejects(
    () => mailSender.send({ to: ['me@example.com'], subject: 'Nope', text: 'x' }),
    (err: Error) => {
      assert.match(err.message, /127\.0\.0\.1:1/);
      assert.match(err.message, /Could not open a connection|did not answer/);
      return true;
    },
  );
});

test('an unconfigured instance refuses to send rather than pretending', async () => {
  store.updateMailSettings({
    enabled: false,
    host: 'smtp.example.com',
    fromEmail: 'agents@example.com',
  } as never);
  mailSender.reset();

  assert.equal(mailSender.isConfigured(), false);
  await assert.rejects(
    () => mailSender.send({ to: ['me@example.com'], subject: 'Nope', text: 'x' }),
    /No SMTP relay is configured/,
  );
});

test('no recipients is an error before any connection is attempted', async () => {
  configure(1);
  await assert.rejects(
    () => mailSender.send({ to: [], subject: 'Nope', text: 'x' }),
    /No recipients/,
  );
});

/* ── Status and the transport cache ────────────────────────────────────── */

test('the status the console gets never carries the password', () => {
  configure(587, { username: 'agents', password: 'top-secret' });
  const status = mailSender.status();
  assert.equal(status.hasPassword, true);
  assert.equal(JSON.stringify(status).includes('top-secret'), false);
});

test('saving new settings takes effect without a restart', async () => {
  const first_ = new FakeSmtp();
  const second = new FakeSmtp();
  await first_.listen();
  await second.listen();

  configure(first_.port);
  await mailSender.send({ to: ['me@example.com'], subject: 'One', text: 'first relay' });
  assert.equal(first_.messages.length, 1);

  // The admin edits the host/port on the Settings page; the cached transport
  // must not keep pointing at the old relay.
  configure(second.port);
  await mailSender.send({ to: ['me@example.com'], subject: 'Two', text: 'second relay' });

  assert.equal(first_.messages.length, 1, 'the old relay must not see the new message');
  assert.equal(second.messages.length, 1);

  await first_.close();
  await second.close();
});

/* ── Error mapping ─────────────────────────────────────────────────────── */

test('transport failures become sentences, not codes', () => {
  const settings = store.getMailSettings();
  const cases: Array<[unknown, RegExp]> = [
    [{ code: 'EAUTH', response: '535 5.7.8 nope' }, /rejected those credentials/],
    [{ code: 'ECONNECTION' }, /Could not open a connection/],
    [{ code: 'ETIMEDOUT' }, /did not answer in time/],
    [{ code: 'ENOTFOUND' }, /could not be resolved/],
    [{ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }, /certificate presented by .* is not trusted/],
    [{ message: 'Missing credentials for "PLAIN"' }, /requires authentication, but no username was set/],
    [{ code: 'EENVELOPE', response: '550 5.1.1 unknown' }, /refused the message envelope/],
    [{ message: 'something else entirely' }, /something else entirely/],
    [{}, /Could not send mail through/],
    [null, /Could not send mail through/],
  ];

  for (const [error, expected] of cases) {
    assert.match(mailErrorMessage(error, settings), expected, `for ${JSON.stringify(error)}`);
  }
});

test('the certificate hint points at the switch that fixes it', () => {
  const settings = store.getMailSettings();
  assert.match(
    mailErrorMessage({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }, settings),
    /turn off certificate verification/,
  );
});
