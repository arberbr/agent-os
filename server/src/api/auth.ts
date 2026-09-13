import express from 'express';
import { store } from '../store.js';
import {
  DECOY_HASH, clearLoginFailures, displayName, domainAllowed, expiredSessionCookie, hashPassword, hashToken,
  isValidEmail, issueSession, loginBlocked, normalizeEmail, passwordProblem, publicAuthState, publicUser,
  recordLoginFailure, requireAuth, verifyPassword,
} from '../auth.js';

interface Credentials {
  email?: unknown;
  password?: unknown;
  name?: unknown;
}

/**
 * Account routes. `GET /state`, `POST /signup` and `POST /login` are the only
 * API endpoints reachable without a session; everything else in the console
 * sits behind the gate in api/app.ts.
 */
export function createAuthRouter(): express.Router {
  const router = express.Router();

  /** What the login screen (and the console) needs to know. */
  router.get('/state', (req, res) => {
    res.json(publicAuthState(req.user));
  });

  router.post('/signup', async (req, res) => {
    const body = (req.body ?? {}) as Credentials;
    const state = publicAuthState(undefined);
    if (!state.canSignup) {
      return res.status(403).json({ error: 'Signups are closed. Ask an administrator for an account.' });
    }

    const email = normalizeEmail(body.email);
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (store.findUserByEmail(email)) {
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }
    if (!domainAllowed(email, state.allowedSignupDomains)) {
      const list = state.allowedSignupDomains.join(', ');
      return res.status(403).json({ error: `Signups are limited to ${list} addresses.` });
    }
    const password = String(body.password ?? '');
    const problem = passwordProblem(password);
    if (problem) return res.status(400).json({ error: problem });

    const user = store.createUser({
      email,
      name: displayName(body.name, email),
      // The account that creates the instance owns it.
      role: state.needsSetup ? 'admin' : 'member',
      passwordHash: await hashPassword(password),
    });
    store.updateUser(user.id, { lastLoginAt: new Date().toISOString() });
    const created = store.getUser(user.id) ?? user;
    return res.status(201).json({ user: issueSession(res, created), needsSetup: false });
  });

  router.post('/login', async (req, res) => {
    const body = (req.body ?? {}) as Credentials;
    const email = normalizeEmail(body.email);
    const password = String(body.password ?? '');
    const key = `${req.ip ?? 'local'}:${email}`;

    const waitFor = loginBlocked(key);
    if (waitFor > 0) {
      res.setHeader('Retry-After', String(waitFor));
      return res.status(429).json({
        error: `Too many failed attempts. Try again in ${Math.ceil(waitFor / 60)} minute(s).`,
      });
    }
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const user = store.findUserByEmail(email);
    // Unknown email still pays for a hash comparison (see DECOY_HASH).
    const ok = await verifyPassword(password, user?.passwordHash ?? DECOY_HASH);
    if (!user || !ok) {
      recordLoginFailure(key);
      return res.status(401).json({ error: 'Email or password is incorrect.' });
    }

    clearLoginFailures(key);
    store.updateUser(user.id, { lastLoginAt: new Date().toISOString() });
    return res.json({ user: issueSession(res, store.getUser(user.id) ?? user) });
  });

  router.post('/logout', (req, res) => {
    if (req.sessionToken) store.deleteSession(hashToken(req.sessionToken));
    res.setHeader('Set-Cookie', expiredSessionCookie());
    res.json({ ok: true });
  });

  /**
   * Own account: display name, and optionally a password change. Changing the
   * password signs out every other browser but keeps this one.
   */
  router.patch('/me', requireAuth, async (req, res) => {
    const body = (req.body ?? {}) as { name?: unknown; currentPassword?: unknown; newPassword?: unknown };
    const user = store.getUser(req.user!.id);
    if (!user) return res.status(401).json({ error: 'Sign in to continue.' });

    const patch: { name?: string; passwordHash?: string } = {};
    if (body.name !== undefined) patch.name = displayName(body.name, user.email);

    const newPassword = body.newPassword === undefined ? '' : String(body.newPassword);
    if (newPassword) {
      const ok = await verifyPassword(String(body.currentPassword ?? ''), user.passwordHash);
      if (!ok) return res.status(403).json({ error: 'Your current password is incorrect.' });
      const problem = passwordProblem(newPassword);
      if (problem) return res.status(400).json({ error: problem });
      if (newPassword === String(body.currentPassword ?? '')) {
        return res.status(400).json({ error: 'The new password must be different from the current one.' });
      }
      patch.passwordHash = await hashPassword(newPassword);
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'Nothing to update.' });
    }

    const updated = store.updateUser(user.id, patch);
    if (!updated) return res.status(404).json({ error: 'Account not found.' });
    if (patch.passwordHash && req.sessionToken) {
      store.deleteUserSessions(updated.id, hashToken(req.sessionToken));
    }
    return res.json({ user: publicUser(updated) });
  });

  return router;
}
