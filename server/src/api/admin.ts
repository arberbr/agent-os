import express from 'express';
import { store } from '../store.js';
import {
  displayName, hashPassword, isValidEmail, normalizeEmail, passwordProblem, publicUser, requireAdmin,
} from '../auth.js';
import { DEFAULT_PORTS, MAIL_SECURITIES, isMailSecurity, mailStatus } from '../mail/settings.js';
import { mailSender } from '../mail/sender.js';
import type { AppSettings, MailSettings, UserRole } from '../types.js';

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function isRole(value: unknown): value is UserRole {
  return value === 'admin' || value === 'member';
}

/** Domains may arrive as a list or as the comma-separated text of an input. */
function parseDomains(value: unknown): string[] | null {
  const items = Array.isArray(value)
    ? value.map((entry) => String(entry))
    : String(value ?? '').split(',');
  const domains: string[] = [];
  for (const item of items) {
    const domain = item.trim().toLowerCase().replace(/^@/, '');
    if (!domain) continue;
    if (!DOMAIN_RE.test(domain)) return null;
    if (!domains.includes(domain)) domains.push(domain);
  }
  return domains;
}

function positiveInt(value: unknown, min: number, max: number): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const rounded = Math.round(parsed);
  return rounded >= min && rounded <= max ? rounded : null;
}

/**
 * Read an SMTP patch from the Settings form.
 *
 * The password is deliberately tri-state, because the console never receives
 * the stored one: absent means "leave it alone", an empty string means "clear
 * it", and any other string replaces it. Getting this wrong would either wipe a
 * working credential whenever an unrelated field is saved, or make it
 * impossible to remove one.
 */
function readMailPatch(body: Record<string, unknown>, current: MailSettings): { patch: Partial<MailSettings> } | { error: string } {
  const patch: Partial<MailSettings> = {};

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') return { error: '"enabled" must be true or false.' };
    patch.enabled = body.enabled;
  }
  if (body.host !== undefined) {
    const host = String(body.host).trim();
    // A host is either absent or a plausible name/IP — never a URL with a scheme.
    if (host && !/^[a-z0-9._:[\]-]+$/i.test(host)) {
      return { error: 'The SMTP host should be a bare host name or IP address, without a scheme (e.g. smtp.example.com).' };
    }
    patch.host = host.slice(0, 255);
  }
  if (body.security !== undefined) {
    if (!isMailSecurity(body.security)) {
      return { error: `Security must be one of: ${MAIL_SECURITIES.join(', ')}.` };
    }
    patch.security = body.security;
    // Moving between modes without a port means the conventional one for the
    // new mode, not the one that belonged to the old.
    if (body.port === undefined && current.port === DEFAULT_PORTS[current.security]) {
      patch.port = DEFAULT_PORTS[body.security];
    }
  }
  if (body.port !== undefined) {
    const port = positiveInt(body.port, 1, 65535);
    if (port === null) return { error: 'Port must be a number between 1 and 65535.' };
    patch.port = port;
  }
  if (body.username !== undefined) patch.username = String(body.username).trim().slice(0, 255);
  if (body.password !== undefined) {
    if (typeof body.password !== 'string') return { error: 'The password must be a string.' };
    patch.password = body.password;
  }
  if (body.fromName !== undefined) patch.fromName = String(body.fromName).trim().slice(0, 120);
  if (body.fromEmail !== undefined) {
    const fromEmail = normalizeEmail(body.fromEmail);
    if (fromEmail && !isValidEmail(fromEmail)) return { error: 'The sender address is not a valid email address.' };
    patch.fromEmail = fromEmail;
  }
  if (body.replyTo !== undefined) {
    const replyTo = normalizeEmail(body.replyTo);
    if (replyTo && !isValidEmail(replyTo)) return { error: 'The reply-to address is not a valid email address.' };
    patch.replyTo = replyTo;
  }
  if (body.verifyCertificate !== undefined) {
    if (typeof body.verifyCertificate !== 'boolean') return { error: '"verifyCertificate" must be true or false.' };
    patch.verifyCertificate = body.verifyCertificate;
  }

  const next = { ...current, ...patch };
  if (next.enabled && !next.host) return { error: 'An SMTP host is required before notifications can be switched on.' };
  if (next.enabled && !next.fromEmail) return { error: 'A sender address is required before notifications can be switched on.' };
  return { patch };
}

/**
 * Administrator routes: instance settings and the people who can sign in.
 * Mounted behind `requireAuth` in api/app.ts; `requireAdmin` guards the whole
 * router, so no route here can be reached by a member.
 */
export function createAdminRouter(): express.Router {
  const router = express.Router();
  router.use(requireAdmin);

  const stats = () => ({
    users: store.countUsers(),
    admins: store.listUsers().filter((u) => u.role === 'admin').length,
    sessions: store.countSessions(),
  });

  router.get('/settings', (_req, res) => {
    res.json({ settings: store.getSettings(), stats: stats() });
  });

  router.put('/settings', (req, res) => {
    const body = (req.body ?? {}) as Partial<Record<keyof AppSettings, unknown>>;
    const patch: Partial<AppSettings> = {};

    if (body.signupsEnabled !== undefined) {
      if (typeof body.signupsEnabled !== 'boolean') {
        return res.status(400).json({ error: 'signupsEnabled must be true or false.' });
      }
      patch.signupsEnabled = body.signupsEnabled;
    }
    if (body.allowedSignupDomains !== undefined) {
      const domains = parseDomains(body.allowedSignupDomains);
      if (domains === null) {
        return res.status(400).json({ error: 'Use bare domains, e.g. acme.com, example.org.' });
      }
      patch.allowedSignupDomains = domains;
    }
    if (body.sessionDays !== undefined) {
      const days = positiveInt(body.sessionDays, 1, 365);
      if (days === null) return res.status(400).json({ error: 'Session length must be between 1 and 365 days.' });
      patch.sessionDays = days;
    }
    if (body.runHistoryLimit !== undefined) {
      const limit = positiveInt(body.runHistoryLimit, 10, 5000);
      if (limit === null) return res.status(400).json({ error: 'History limit must be between 10 and 5000 sessions.' });
      patch.runHistoryLimit = limit;
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'Nothing to update.' });
    }

    res.json({ settings: store.updateSettings(patch), stats: stats() });
  });

  router.get('/users', (_req, res) => {
    res.json(store.listUsers().map(publicUser));
  });

  /* ── Email notifications (SMTP) ────────────────────────────────────────
   *
   * Admin-only, like the rest of this router: the relay is an instance-wide
   * credential, and anyone who can write it can redirect every notification.
   * The password is never returned — only whether one is on file.
   */

  router.get('/mail', (_req, res) => {
    res.json({ mail: mailStatus(store.getMailSettings()) });
  });

  router.put('/mail', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = readMailPatch(body, store.getMailSettings());
    if ('error' in result) return res.status(400).json({ error: result.error });
    if (Object.keys(result.patch).length === 0) {
      return res.status(400).json({ error: 'Nothing to update.' });
    }
    const saved = store.updateMailSettings(result.patch);
    // The sender fingerprints the settings and rebuilds its transport, so this
    // is what makes a saved change take effect on the next message.
    mailSender.reset();
    const status = mailStatus(saved);
    res.json({ mail: status });
  });

  /** Forget the relay: nothing is sent until credentials are entered again. */
  router.delete('/mail', (_req, res) => {
    const cleared = store.clearMailSettings();
    mailSender.reset();
    res.json({ mail: mailStatus(cleared) });
  });

  /**
   * Prove the relay works. Without `to` this only opens the connection and
   * authenticates; with `to` it sends a real message, which is the only way to
   * know the sender address is accepted and delivery actually happens.
   */
  router.post('/mail/test', async (req, res) => {
    const body = (req.body ?? {}) as { to?: unknown };
    const to = normalizeEmail(body.to) || store.getMailSettings().fromEmail;

    try {
      const checks: Record<string, { ok: boolean; sample?: unknown; error?: string }> = {};
      try {
        checks.connection = { ok: true, sample: await mailSender.verify() };
      } catch (err) {
        checks.connection = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }

      if (checks.connection.ok && to) {
        try {
          const sent = await mailSender.sendTest(to);
          checks.delivery = { ok: true, sample: { to, messageId: sent.messageId, ms: sent.ms } };
        } catch (err) {
          checks.delivery = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }

      const ok = Object.values(checks).every((check) => check.ok);
      return res.status(ok ? 200 : 502).json({ ok, to: to || null, checks });
    } catch (err) {
      return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  /** An admin adds an account directly — the path that works when signups are off. */
  router.post('/users', async (req, res) => {
    const body = (req.body ?? {}) as { email?: unknown; name?: unknown; password?: unknown; role?: unknown };
    const email = normalizeEmail(body.email);
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (store.findUserByEmail(email)) {
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }
    const password = String(body.password ?? '');
    const problem = passwordProblem(password);
    if (problem) return res.status(400).json({ error: problem });
    if (body.role !== undefined && !isRole(body.role)) {
      return res.status(400).json({ error: 'Role must be admin or member.' });
    }

    const user = store.createUser({
      email,
      name: displayName(body.name, email),
      role: isRole(body.role) ? body.role : 'member',
      passwordHash: await hashPassword(password),
    });
    return res.status(201).json(publicUser(user));
  });

  router.patch('/users/:id', async (req, res) => {
    const body = (req.body ?? {}) as { name?: unknown; role?: unknown; password?: unknown };
    const user = store.getUser(req.params.id);
    if (!user) return res.status(404).json({ error: 'Account not found.' });

    const patch: { name?: string; role?: UserRole; passwordHash?: string } = {};
    if (body.name !== undefined) patch.name = displayName(body.name, user.email);

    if (body.role !== undefined) {
      if (!isRole(body.role)) return res.status(400).json({ error: 'Role must be admin or member.' });
      if (user.id === req.user!.id) {
        return res.status(400).json({ error: 'You cannot change your own role.' });
      }
      const admins = store.listUsers().filter((u) => u.role === 'admin');
      if (user.role === 'admin' && body.role !== 'admin' && admins.length <= 1) {
        return res.status(400).json({ error: 'At least one administrator must remain.' });
      }
      patch.role = body.role;
    }

    if (body.password !== undefined) {
      const password = String(body.password);
      const problem = passwordProblem(password);
      if (problem) return res.status(400).json({ error: problem });
      patch.passwordHash = await hashPassword(password);
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'Nothing to update.' });
    }

    const updated = store.updateUser(user.id, patch);
    if (!updated) return res.status(404).json({ error: 'Account not found.' });
    // A reset password invalidates every browser that was signed in as this user.
    if (patch.passwordHash) store.deleteUserSessions(updated.id);
    return res.json(publicUser(updated));
  });

  router.delete('/users/:id', (req, res) => {
    const user = store.getUser(req.params.id);
    if (!user) return res.status(404).json({ error: 'Account not found.' });
    if (user.id === req.user!.id) {
      return res.status(400).json({ error: 'You cannot remove your own account.' });
    }
    if (user.role === 'admin' && store.listUsers().filter((u) => u.role === 'admin').length <= 1) {
      return res.status(400).json({ error: 'At least one administrator must remain.' });
    }
    store.deleteUser(user.id);
    res.status(204).end();
  });

  return router;
}
