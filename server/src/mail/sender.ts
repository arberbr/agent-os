import nodemailer from 'nodemailer';
import type { SentMessageInfo, Transporter } from 'nodemailer';
import { store } from '../store.js';
import type { MailSettings, MailStatus } from '../types.js';
import { mailFingerprint, mailIsConfigured, mailStatus } from './settings.js';

/**
 * The mail sender — the one place Agents OS talks SMTP.
 *
 * It owns three things the rest of the server should not have to think about:
 *
 *  - **transport lifetime.** A transport is built from the stored settings and
 *    cached; it is rebuilt only when those settings change (compared by
 *    fingerprint), so saving the Settings page takes effect on the very next
 *    message instead of at the next restart.
 *  - **bounded waiting.** Connecting to a dead relay must never wedge a
 *    scheduled run, so connect/greeting/socket timeouts are set explicitly
 *    rather than left at nodemailer's minutes-long defaults.
 *  - **readable failures.** Every error is mapped to a sentence an operator can
 *    act on ("check the port and security setting", "the certificate is not
 *    trusted") instead of a raw `ESOCKET` or a TLS code.
 *
 * Nothing here throws on a *configuration* problem: `isConfigured()` is the
 * caller's gate, and `send()` only throws when it actually tried and failed.
 */

/** One message out. Addresses are already validated by the caller. */
export interface OutgoingMail {
  to: string[];
  subject: string;
  text: string;
  html?: string;
  /** Extra headers, e.g. provenance for a filter rule on the receiving side. */
  headers?: Record<string, string>;
}

export interface SendResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
  response: string;
}

export interface VerifyResult {
  ok: true;
  host: string;
  port: number;
  security: MailSettings['security'];
  ms: number;
}

/** Connection and socket budgets, in milliseconds. */
const CONNECTION_TIMEOUT_MS = 10_000;
const GREETING_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 60_000;

export class MailSender {
  private transporter: Transporter<SentMessageInfo> | null = null;
  private fingerprint = '';

  /** The settings as stored right now. */
  settings(): MailSettings {
    return store.getMailSettings();
  }

  /** Switched on *and* complete: host plus a sender address. */
  isConfigured(): boolean {
    return mailIsConfigured(this.settings());
  }

  /** The redacted view for the console (never carries the password). */
  status(): MailStatus {
    return mailStatus(this.settings());
  }

  /**
   * The cached transport, rebuilt whenever the stored settings changed. Not
   * pooled: a notification is a rare, one-off message, and an idle pooled
   * socket would keep the process alive for no reason.
   */
  private transport(settings: MailSettings): Transporter<SentMessageInfo> {
    const fingerprint = mailFingerprint(settings);
    if (this.transporter && this.fingerprint === fingerprint) return this.transporter;

    this.transporter?.close();
    this.transporter = nodemailer.createTransport({
      host: settings.host,
      port: settings.port,
      // `secure` means TLS from the first byte — that is implicit TLS (465).
      secure: settings.security === 'tls',
      // STARTTLS is required, not opportunistic: silently sending credentials
      // over a plaintext connection is worse than failing loudly.
      requireTLS: settings.security === 'starttls',
      auth: settings.username ? { user: settings.username, pass: settings.password } : undefined,
      tls: { rejectUnauthorized: settings.verifyCertificate },
      connectionTimeout: CONNECTION_TIMEOUT_MS,
      greetingTimeout: GREETING_TIMEOUT_MS,
      socketTimeout: SOCKET_TIMEOUT_MS,
    });
    this.fingerprint = fingerprint;
    return this.transporter;
  }

  /** Drop the cached transport (settings changed, or a test wants a fresh one). */
  reset(): void {
    this.transporter?.close();
    this.transporter = null;
    this.fingerprint = '';
  }

  /**
   * Open a connection, greet and authenticate — without sending anything. This
   * is what "Test connection" runs, so credentials can be checked before a
   * schedule ever depends on them.
   */
  async verify(): Promise<VerifyResult> {
    const settings = this.settings();
    if (!mailIsConfigured(settings)) {
      throw new Error('No SMTP relay is configured yet — fill in the host and sender address first.');
    }
    const started = Date.now();
    try {
      await this.transport(settings).verify();
      return {
        ok: true,
        host: settings.host,
        port: settings.port,
        security: settings.security,
        ms: Date.now() - started,
      };
    } catch (err) {
      // A rejected connection may be a stale socket; never keep it.
      this.reset();
      throw new Error(mailErrorMessage(err, settings));
    }
  }

  /** Send one message. Throws a readable error when the relay refused it. */
  async send(mail: OutgoingMail): Promise<SendResult> {
    const settings = this.settings();
    if (!mailIsConfigured(settings)) {
      throw new Error('No SMTP relay is configured yet — fill in the host and sender address first.');
    }
    if (mail.to.length === 0) {
      throw new Error('No recipients — nothing to send to.');
    }

    const from = settings.fromName
      ? { name: settings.fromName, address: settings.fromEmail }
      : settings.fromEmail;

    try {
      const info = await this.transport(settings).sendMail({
        from,
        to: mail.to.join(', '),
        replyTo: settings.replyTo || undefined,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        headers: mail.headers,
      });
      return {
        messageId: info.messageId ?? '',
        accepted: (info.accepted ?? []).map(String),
        rejected: (info.rejected ?? []).map(String),
        response: info.response ?? '',
      };
    } catch (err) {
      this.reset();
      throw new Error(mailErrorMessage(err, settings));
    }
  }

  /**
   * Deliver a probe message to one address — the full path, not just the
   * handshake, so "Test connection" can prove mail is actually deliverable.
   */
  async sendTest(to: string): Promise<SendResult & { ms: number }> {
    const started = Date.now();
    const sentAt = new Date().toISOString();
    const result = await this.send({
      to: [to],
      subject: '[Agents OS] Test message',
      text: [
        'This is a test message from Agents OS.',
        '',
        'If you are reading it, scheduled run notifications will reach you.',
        '',
        `Sent: ${sentAt}`,
        `Relay: ${this.settings().host}:${this.settings().port} (${this.settings().security})`,
      ].join('\n'),
      html: testHtml(to, sentAt, this.settings()),
      headers: { 'X-Agents-OS': 'test' },
    });
    return { ...result, ms: Date.now() - started };
  }
}

function testHtml(to: string, sentAt: string, settings: MailSettings): string {
  return [
    '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:14px;line-height:1.6;color:#191a17">',
    '<p style="margin:0 0 12px"><strong>This is a test message from Agents OS.</strong></p>',
    '<p style="margin:0 0 12px">If you are reading it, scheduled run notifications will reach you.</p>',
    `<p style="margin:0;color:#71756a;font-size:12.5px">Sent ${escapeHtml(sentAt)} to ${escapeHtml(to)} · relay ${escapeHtml(settings.host)}:${settings.port} (${escapeHtml(settings.security)})</p>`,
    '</div>',
  ].join('');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** TLS failures surface as codes, not sentences; these are the common ones. */
const TLS_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_SSL_WRONG_VERSION_NUMBER',
]);

interface MailErrorLike {
  code?: string;
  command?: string;
  response?: string;
  responseCode?: number;
  message?: string;
}

/**
 * Turn a transport failure into something an operator can act on. The relay is
 * named in the message because "connection refused" is useless without it.
 */
export function mailErrorMessage(err: unknown, settings: MailSettings): string {
  const e = (err ?? {}) as MailErrorLike;
  const code = typeof e.code === 'string' ? e.code : '';
  const where = `${settings.host}:${settings.port}`;
  const hint = settings.security === 'tls' ? 'implicit TLS (port 465)' : settings.security === 'starttls' ? 'STARTTLS (port 587)' : 'no encryption';

  if (code === 'EAUTH' || /invalid login|authentication failed|535|534/i.test(e.response ?? '')) {
    return (
      `The relay at ${where} rejected those credentials. Check the username and password — ` +
      'providers such as Gmail, Fastmail and Zoho require an app-specific password rather than your account password.'
    );
  }
  if (code === 'ECONNECTION' || code === 'ESOCKET' || code === 'ECONNREFUSED' || code === 'ECONNRESET') {
    return (
      `Could not open a connection to ${where}. Check the host and port, and that the relay is reachable from this ` +
      `machine. The current security mode is ${hint}.`
    );
  }
  if (code === 'ENOTFOUND' || code === 'EDNS' || code === 'EAI_AGAIN') {
    return `The host name "${settings.host}" could not be resolved. Check the spelling of the SMTP host.`;
  }
  if (code === 'ETIMEDOUT' || code === 'ETIME') {
    return `${where} did not answer in time. The relay may be down, or a firewall may be blocking the port.`;
  }
  if (TLS_CODES.has(code) || /self.signed certificate|unable to verify/i.test(e.message ?? '')) {
    return (
      `The TLS certificate presented by ${where} is not trusted (${code || 'certificate error'}). ` +
      'Either point at a relay with a valid certificate, or turn off certificate verification if this is an internal relay you control.'
    );
  }
  if (/missing credentials/i.test(e.message ?? '')) {
    return `The relay at ${where} requires authentication, but no username was set.`;
  }
  if (code === 'EENVELOPE') {
    return `The relay refused the message envelope${e.response ? `: ${e.response}` : '.'} Check the sender and recipient addresses.`;
  }
  if (e.response) {
    return `The relay at ${where} refused the message${e.responseCode ? ` (${e.responseCode})` : ''}: ${e.response}`;
  }
  return e.message ? `Could not send mail through ${where}: ${e.message}` : `Could not send mail through ${where}.`;
}

export const mailSender = new MailSender();
