import { config } from '../config.js';
import type { MailSecurity, MailSettings, MailStatus } from '../types.js';

/**
 * The SMTP relay settings: defaults, coercion and the redacted view the console
 * is allowed to see.
 *
 * `db.json` is hand-editable and the Settings page posts whatever the form
 * holds, so nothing downstream may assume a field is present or sane — every
 * read goes through `normalizeMailSettings`.
 */

/** The mode names, in the order the Settings page lists them. */
export const MAIL_SECURITIES: MailSecurity[] = ['starttls', 'tls', 'none'];

/** The conventional port for each mode, used when none was entered. */
export const DEFAULT_PORTS: Record<MailSecurity, number> = {
  starttls: 587,
  tls: 465,
  none: 25,
};

/** Short description of each mode, shown under the selector. */
export const SECURITY_NOTES: Record<MailSecurity, string> = {
  starttls: 'Plaintext connect, upgraded to TLS — port 587, the usual choice.',
  tls: 'TLS from the first byte (implicit TLS) — port 465.',
  none: 'No encryption at all — port 25. Only sane on a trusted network.',
};

export const DEFAULT_MAIL_SETTINGS: MailSettings = {
  enabled: false,
  host: '',
  port: DEFAULT_PORTS.starttls,
  security: 'starttls',
  username: '',
  password: '',
  fromName: 'Agents OS',
  fromEmail: '',
  replyTo: '',
  verifyCertificate: true,
  updatedAt: null,
};

export function isMailSecurity(value: unknown): value is MailSecurity {
  return typeof value === 'string' && (MAIL_SECURITIES as string[]).includes(value);
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

/** A port that can actually be dialed, else the mode's conventional one. */
export function resolvePort(security: MailSecurity, port: unknown): number {
  const parsed = Math.round(Number(port));
  if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 65535) return parsed;
  return DEFAULT_PORTS[security];
}

/**
 * The `.env` seed, merged under whatever is stored: a saved record always wins
 * key by key, so editing the pane in the console is never undone by a restart.
 */
export function mailEnvSeed(): Partial<MailSettings> {
  return config.mailEnv ?? {};
}

/**
 * Coerce a stored record into complete, usable settings.
 *
 * The `.env` seed is used only while nobody has saved the Settings pane — once
 * `updatedAt` is set, that record is authoritative and editing it (including
 * clearing a field) is never undone by a restart.
 */
export function normalizeMailSettings(input: Partial<MailSettings> | undefined): MailSettings {
  const stored: Partial<MailSettings> = input ?? {};
  const merged: Partial<MailSettings> = stored.updatedAt ? { ...stored } : { ...mailEnvSeed(), ...stored };
  for (const key of Object.keys(merged) as Array<keyof MailSettings>) {
    if (merged[key] === undefined) delete merged[key];
  }

  const security = isMailSecurity(merged.security) ? merged.security : DEFAULT_MAIL_SETTINGS.security;
  const rawFromName = text(merged.fromName);
  return {
    enabled: merged.enabled === true,
    host: text(merged.host),
    port: resolvePort(security, merged.port),
    security,
    username: text(merged.username),
    // Never trimmed on the right: a password may legitimately end in a space.
    password: typeof merged.password === 'string' ? merged.password : '',
    fromName: rawFromName || DEFAULT_MAIL_SETTINGS.fromName,
    fromEmail: text(merged.fromEmail),
    replyTo: text(merged.replyTo),
    verifyCertificate: merged.verifyCertificate !== false,
    updatedAt: typeof merged.updatedAt === 'string' && merged.updatedAt ? merged.updatedAt : null,
  };
}

/**
 * Usable, not merely switched on: a relay needs somewhere to connect and a
 * sender address the receiving server will accept.
 */
export function mailIsConfigured(settings: MailSettings): boolean {
  return settings.enabled && settings.host.length > 0 && settings.fromEmail.length > 0;
}

/** The console's view: everything except the password. */
export function mailStatus(settings: MailSettings): MailStatus {
  return {
    configured: mailIsConfigured(settings),
    enabled: settings.enabled,
    host: settings.host,
    port: settings.port,
    security: settings.security,
    username: settings.username,
    fromName: settings.fromName,
    fromEmail: settings.fromEmail,
    replyTo: settings.replyTo,
    verifyCertificate: settings.verifyCertificate,
    hasPassword: settings.password.length > 0,
    updatedAt: settings.updatedAt,
  };
}

/**
 * Everything the connection depends on, as one string. The sender caches its
 * transport and rebuilds it only when this changes, so saving the Settings page
 * takes effect on the next mail instead of at the next restart.
 */
export function mailFingerprint(settings: MailSettings): string {
  return [
    settings.host,
    settings.port,
    settings.security,
    settings.username,
    // Length and a cheap digest: enough to notice a new password without
    // keeping a second copy of it in memory.
    settings.password.length,
    hash(settings.password),
    settings.verifyCertificate ? 'verify' : 'trust',
  ].join('\u0000');
}

/** FNV-1a — not security, just change detection. */
function hash(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
