import express from 'express';
import { store } from '../store.js';
import {
  displayName, hashPassword, isValidEmail, normalizeEmail, passwordProblem, publicUser, requireAdmin,
} from '../auth.js';
import type { AppSettings, UserRole } from '../types.js';

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
