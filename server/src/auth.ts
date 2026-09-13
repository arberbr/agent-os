import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { allowedOrigins, config } from './config.js';
import { store } from './store.js';
import type { AppSettings, PublicUser, User } from './types.js';

/**
 * Accounts and sessions.
 *
 * The console is gated by an email + password login. Passwords are stored as
 * scrypt hashes (per-user salt, constant-time comparison) and a browser proves
 * itself with an HttpOnly session cookie whose raw token is never written to
 * disk — only its sha-256 is, so `db.json` cannot be replayed as a login.
 */

declare global {
  namespace Express {
    interface Request {
      /** Account resolved from the session cookie (set by `attachUser`). */
      user?: PublicUser;
      /** Raw cookie token, kept so logout can delete the right session. */
      sessionToken?: string;
    }
  }
}

export const SESSION_COOKIE = 'agentos_session';

const SCRYPT_KEYLEN = 64;
const SCRYPT_PREFIX = 'scrypt';

/* ── Passwords ─────────────────────────────────────────────────────────── */

function derive(password: string, salt: string, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt, SCRYPT_KEYLEN);
  return `${SCRYPT_PREFIX}$${salt}$${key.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== SCRYPT_PREFIX || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  if (expected.length === 0) return false;
  const actual = await derive(password, salt, expected.length);
  return timingSafeEqual(expected, actual);
}

/**
 * A hash to verify against when the email is unknown, so a missing account and
 * a wrong password cost the same time (no user enumeration by stopwatch).
 */
export const DECOY_HASH: string = (() => {
  const salt = randomBytes(16).toString('hex');
  return `${SCRYPT_PREFIX}$${salt}$${scryptSync('decoy-password-never-used', salt, SCRYPT_KEYLEN).toString('hex')}`;
})();

/* ── Email & password rules ────────────────────────────────────────────── */

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function normalizeEmail(raw: unknown): string {
  return String(raw ?? '').trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return email.length >= 6 && email.length <= 254 && EMAIL_RE.test(email);
}

export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1);
}

/** Empty list = any domain; otherwise the exact domain or one of its subdomains. */
export function domainAllowed(email: string, domains: string[]): boolean {
  if (domains.length === 0) return true;
  const domain = emailDomain(email);
  return domains.some((entry) => domain === entry || domain.endsWith(`.${entry}`));
}

export function passwordProblem(password: string): string | null {
  if (password.length < 8) return 'Password must be at least 8 characters.';
  if (password.length > 200) return 'Password must be at most 200 characters.';
  return null;
}

export function displayName(name: unknown, email: string): string {
  const trimmed = String(name ?? '').trim().slice(0, 80);
  return trimmed || email.split('@')[0] || email;
}

export function publicUser(user: User): PublicUser {
  const { passwordHash: _passwordHash, ...rest } = user;
  return rest;
}

/* ── Sessions & cookies ────────────────────────────────────────────────── */

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createSession(userId: string): { token: string; maxAgeSeconds: number } {
  const token = randomBytes(32).toString('base64url');
  const maxAgeSeconds = Math.round(store.getSettings().sessionDays * 86_400);
  store.createSession(userId, hashToken(token), new Date(Date.now() + maxAgeSeconds * 1000).toISOString());
  return { token, maxAgeSeconds };
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    if (key) out[key] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

/** `Secure` only over https, or localhost logins would never be sent back. */
const cookieSuffix = (): string => (config.publicUrl.startsWith('https://') ? '; Secure' : '');

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${cookieSuffix()}`;
}

export function expiredSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${cookieSuffix()}`;
}

/** Start (or replace) the session for a user and send the cookie. */
export function issueSession(res: Response, user: User): PublicUser {
  const { token, maxAgeSeconds } = createSession(user.id);
  res.setHeader('Set-Cookie', sessionCookie(token, maxAgeSeconds));
  return publicUser(user);
}

/* ── Middleware ────────────────────────────────────────────────────────── */

/** Resolve the account for every request; never rejects on its own. */
export function attachUser(req: Request, _res: Response, next: NextFunction): void {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) {
    const user = store.findUserBySession(hashToken(token));
    if (user) {
      req.user = publicUser(user);
      req.sessionToken = token;
    }
  }
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Sign in to continue.' });
    return;
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Sign in to continue.' });
    return;
  }
  if (req.user.role !== 'admin') {
    res.status(403).json({ error: 'Only an administrator can do that.' });
    return;
  }
  next();
}

/**
 * CSRF guard for the cookie-authenticated API. Non-browser clients send no
 * `Origin` and are unaffected; a browser request that claims another origin is
 * refused before it can act with the session cookie.
 */
export function sameOriginOnly(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    next();
    return;
  }
  const origin = req.headers.origin;
  if (origin && !allowedOrigins.includes(origin.replace(/\/+$/, ''))) {
    res.status(403).json({ error: 'Cross-origin request rejected.' });
    return;
  }
  next();
}

/* ── Login throttling ──────────────────────────────────────────────────── */

const WINDOW_MS = 10 * 60_000;
const MAX_ATTEMPTS = 8;
const attempts = new Map<string, { count: number; resetAt: number }>();

/** Seconds the caller must wait, or 0 when it may try again. */
export function loginBlocked(key: string): number {
  const entry = attempts.get(key);
  if (!entry) return 0;
  if (entry.resetAt <= Date.now()) {
    attempts.delete(key);
    return 0;
  }
  if (entry.count < MAX_ATTEMPTS) return 0;
  return Math.ceil((entry.resetAt - Date.now()) / 1000);
}

export function recordLoginFailure(key: string): void {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
  } else {
    entry.count += 1;
  }
  // Keep the map from growing without bound on a long-lived process.
  if (attempts.size > 500) {
    for (const [k, v] of attempts) if (v.resetAt <= now) attempts.delete(k);
  }
}

export function clearLoginFailures(key: string): void {
  attempts.delete(key);
}

/** Public state the login screen needs before anyone is signed in. */
export function publicAuthState(user: PublicUser | undefined): {
  authenticated: boolean;
  user: PublicUser | null;
  signupsEnabled: boolean;
  needsSetup: boolean;
  canSignup: boolean;
  allowedSignupDomains: string[];
  sessionDays: number;
} {
  const settings: AppSettings = store.getSettings();
  const needsSetup = store.countUsers() === 0;
  return {
    authenticated: user !== undefined,
    user: user ?? null,
    signupsEnabled: settings.signupsEnabled,
    // An instance without accounts must always be able to create its admin.
    canSignup: needsSetup || settings.signupsEnabled,
    needsSetup,
    allowedSignupDomains: settings.allowedSignupDomains,
    sessionDays: settings.sessionDays,
  };
}
