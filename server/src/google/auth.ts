import { google } from 'googleapis';
import type { Auth } from 'googleapis';
import { config, IDENTITY_SCOPES, type ScopeGroup } from '../config.js';
import { store } from '../store.js';
import type { GoogleToken } from '../types.js';

export function isGoogleConfigured(): boolean {
  return Boolean(config.googleClientId && config.googleClientSecret);
}

export function makeOAuthClient(): Auth.OAuth2Client {
  return new google.auth.OAuth2(config.googleClientId, config.googleClientSecret, config.googleRedirectUri);
}

/**
 * Every consent request carries the identity scopes plus exactly one service
 * group. Google rejects mixing YouTube scopes with Drive scopes in a single
 * authorization request, so each group is a fully independent grant with its
 * own token (no scope merging).
 */
export function scopesForGroup(group: ScopeGroup): string[] {
  return [...IDENTITY_SCOPES, ...config.googleScopeGroups[group]];
}

export const SCOPE_GROUPS: ScopeGroup[] = ['workspace', 'youtube'];

export function googleStatus() {
  const tokens = store.listGoogleTokens();
  const groupConnected = (group: ScopeGroup): boolean => {
    const token = tokens[group];
    if (!token) return false;
    const required = config.googleScopeGroups[group];
    const granted = new Set(token.scopes);
    return required.length > 0 && required.every((scope) => granted.has(scope));
  };
  const primary = tokens.workspace ?? tokens.youtube ?? null;
  return {
    configured: isGoogleConfigured(),
    connected: Boolean(tokens.workspace || tokens.youtube),
    email: primary?.email ?? null,
    name: primary?.name ?? null,
    picture: primary?.picture ?? null,
    scopes: [...new Set([...(tokens.workspace?.scopes ?? []), ...(tokens.youtube?.scopes ?? [])])],
    groups: {
      workspace: {
        connected: groupConnected('workspace'),
        scopes: config.googleScopeGroups.workspace,
        email: tokens.workspace?.email ?? null,
      },
      youtube: {
        connected: groupConnected('youtube'),
        scopes: config.googleScopeGroups.youtube,
        email: tokens.youtube?.email ?? null,
      },
    },
    connectedAt: primary?.connectedAt ?? null,
  };
}

/**
 * Build the consent-screen URL for one scope group.
 *
 * `include_granted_scopes` is deliberately left unset: Google validates the
 * combined set of previously granted + newly requested scopes, so merging would
 * fold the already-granted Drive scope into the YouTube request and fail again
 * with "scopes that cannot be requested together". Each group is granted (and
 * stored) independently instead.
 */
export function buildAuthUrl(state: string, group: ScopeGroup): string {
  const client = makeOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: scopesForGroup(group),
    state,
  });
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  try {
    const payload = token.split('.')[1];
    if (!payload) return {};
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Exchange an authorization code for tokens and store them for that group. */
export async function handleAuthCode(code: string, group: ScopeGroup): Promise<GoogleToken> {
  const client = makeOAuthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.access_token) throw new Error('Google did not return an access token.');

  const idClaims = tokens.id_token ? decodeJwtPayload(tokens.id_token) : {};
  const previous = store.getGoogleToken(group);
  const token: GoogleToken = {
    userId: 'default',
    email: String(idClaims['email'] ?? previous?.email ?? 'unknown'),
    name: typeof idClaims['name'] === 'string' ? idClaims['name'] : previous?.name,
    picture: typeof idClaims['picture'] === 'string' ? idClaims['picture'] : previous?.picture,
    scopes: (tokens.scope ?? '').split(' ').filter(Boolean),
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? previous?.refreshToken ?? null,
    expiryDate: tokens.expiry_date ?? Date.now() + 3600_000,
    connectedAt: new Date().toISOString(),
  };
  store.setGoogleToken(group, token);
  return token;
}

/**
 * Return an authenticated OAuth2 client for one scope group, refreshing the
 * token when needed (google-auth-library does this automatically; we persist
 * any refreshed tokens via the `tokens` event).
 */
export async function getAuthedClient(group: ScopeGroup): Promise<Auth.OAuth2Client | null> {
  const token = store.getGoogleToken(group);
  if (!token || (!token.accessToken && !token.refreshToken)) return null;

  const client = makeOAuthClient();
  client.setCredentials({
    access_token: token.accessToken,
    refresh_token: token.refreshToken ?? undefined,
    expiry_date: token.expiryDate,
  });
  client.on('tokens', (t) => {
    const current = store.getGoogleToken(group);
    if (!current) return;
    store.setGoogleToken(group, {
      ...current,
      accessToken: t.access_token ?? current.accessToken,
      refreshToken: t.refresh_token ?? current.refreshToken,
      expiryDate: t.expiry_date ?? Date.now() + 3600_000,
    });
  });
  return client;
}

export async function disconnectGoogle(): Promise<void> {
  const tokens = store.listGoogleTokens();
  store.clearGoogleTokens();
  for (const token of Object.values(tokens)) {
    if (!token?.accessToken) continue;
    try {
      const client = makeOAuthClient();
      client.setCredentials({ access_token: token.accessToken });
      await client.revokeToken(token.accessToken).catch(() => undefined);
    } catch {
      // revocation is best-effort
    }
  }
}

/** Human-friendly Google API error messages. */
export function googleErrorMessage(err: unknown): string {
  const e = err as {
    code?: number | string;
    message?: string;
    errors?: Array<{ message?: string; reason?: string; extendedHelp?: string }>;
  };
  const first = e?.errors?.[0];
  const reason = first?.reason ?? '';
  const raw = first?.message ?? e?.message ?? String(err);
  const blob = `${reason} ${raw}`;

  // The API was never enabled in the Google Cloud project (very common on a
  // fresh project: enabling YouTube does not enable Gmail/Calendar/Drive).
  if (/accessNotConfigured|SERVICE_DISABLED|has not been used in project|is disabled/i.test(blob)) {
    const apiName = raw.match(/([A-Za-z0-9][A-Za-z0-9 .]*? API) (?:has not been used|is disabled)/)?.[1] ?? 'This Google API';
    const url = raw.match(/https:\/\/[^\s)]+/)?.[0] ?? first?.extendedHelp;
    return `${apiName} is not enabled for your Google Cloud project. Enable it in the Google Cloud Console${url ? ` — ${url}` : ''} — then wait a minute and test again.`;
  }

  if (/rateLimitExceeded|quotaExceeded|userRateLimitExceeded/i.test(blob)) {
    return `Google API quota or rate limit reached (${reason || 'quotaExceeded'}). Wait a moment and retry, or narrow the request.`;
  }

  if (e?.code === 401 || e?.code === '401') {
    return `Google authentication expired or was revoked (${raw}). Reconnect the matching group on the Integrations page.`;
  }

  if (e?.code === 403 || e?.code === '403') {
    if (reason === 'insufficientPermissions' || reason === 'forbidden') {
      return `Google permission denied (${reason}). Reconnect the matching group on the Integrations page and approve the requested scopes.`;
    }
    return `Google refused the request (403${reason ? ` ${reason}` : ''}): ${raw}`;
  }

  return raw;
}
