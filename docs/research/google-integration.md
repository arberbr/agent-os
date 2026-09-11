# Google Integration Research — Agents OS

Researched from live Google developer docs. Note: as of the research date, Google docs reflect a 2026 state (Gmail/Calendar quota model changed **May 1, 2026**; YouTube default quota structure changed 2026; Gemini line-up now includes 3.x models). Everything below reflects what the docs say *now*.

## 1. OAuth 2.0 for a self-hosted localhost app

- **Client type:** use **"Web application"** with authorized redirect URI `http://localhost:PORT/oauth2callback` (loopback `http://127.0.0.1:PORT` is also accepted). "Desktop app" client type with loopback IP redirects is still supported for desktop flows; loopback for *mobile* apps was deprecated in Feb 2022 ([native-app guide](https://developers.google.com/identity/protocols/oauth2/native-app)). The legacy **out-of-band (OOB) flow is dead** — do not use it ([OOB migration](https://developers.google.com/identity/protocols/oauth2/resources/oob-migration)).
- **Google Identity Services (GIS)** replaced the old Sign-In JS library, but it does **not** change server-side OAuth: you still use the authorization-code flow + `google-auth-library`. PKCE (`code_verifier`/S256) is recommended for installed apps; DPoP is now optionally supported for desktop apps (overkill for a single-user self-hosted app).
- **2025-era gotchas:** unused OAuth clients are now **auto-deleted** (restorable within 30 days) → `deleted_client` errors ([client docs](https://support.google.com/cloud/answer/15549257)); consent screens now use a **Testing / Published** model with "app audience" controls ([Manage App Audience](https://support.google.com/cloud/answer/15549945)).
- **Publishing status model** ([production readiness overview](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview)):
  - **Testing** (External user type): only users explicitly added to the test-user allowlist can authorize — **max 100 test users**; refresh tokens **expire after 7 days**; users see a "testing" warning. A Workspace admin marking the app "Trusted" overrides the 100-user cap and 7-day expiry.
  - **Published + unverified**: all users can authorize, but unverified-app warning shows and there is a **100-user cap** for sensitive/restricted scopes.
  - **Published + verified**: required for any real multi-user deployment with sensitive/restricted scopes.

```ts
import { OAuth2Client } from 'google-auth-library';

const oauth = new OAuth2Client({
  clientId: process.env.GOOGLE_CLIENT_ID!,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
  redirectUri: 'http://localhost:3000/oauth2callback', // must exactly match Cloud Console
});

// Step 1: redirect the user here
const authUrl = oauth.generateAuthUrl({
  access_type: 'offline',        // REQUIRED or no refresh_token is returned
  prompt: 'consent',             // force consent so new scopes re-issue a refresh_token
  scope: DEFAULT_SCOPES,         // string[] | string (space-delimited)
  include_granted_scopes: true,  // incremental auth: adds to previously granted scopes
  state: csrfToken,              // verify on callback
});

// Step 2 (callback route): exchange code
const { tokens } = await oauth.getToken(code); // Credentials: access_token, refresh_token, scope, expiry_date
oauth.setCredentials(tokens);
await saveTokens(tokens);        // persist refresh_token

// Step 3: use it — getAccessToken() auto-refreshes silently when expired
const { token } = await oauth.getAccessToken();

// Step 4: re-persist on every silent refresh
oauth.on('tokens', (t) => void saveTokens({ ...loadTokens(), ...t }));
// (Optional) force a refresh: await oauth.refreshAccessToken();
// If refresh fails with invalid_grant, the refresh_token was revoked → re-run consent flow.
```

## 2. Gmail API

**Scopes** ([OAuth scopes page](https://developers.google.com/identity/protocols/oauth2/scopes#gmail)): `gmail.readonly`, `gmail.modify`, `gmail.send`, `gmail.compose`, `gmail.insert` are **restricted** (need app verification + security assessment to go public; fine for 1 test user). `gmail.metadata`, `gmail.settings.basic/sharing` are only *sensitive*.

```ts
import { google } from 'googleapis';
const gmail = google.gmail({ version: 'v1', auth: oauth });

// List (returns id + threadId only; each call = 5 quota units)
const res = await gmail.users.messages.list({
  userId: 'me',
  q: 'is:unread newer_than:2d from:boss@example.com has:attachment',
  maxResults: 50,
});

// Fetch full message (must follow list; format: 'full' | 'metadata')
const msg = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });

// Decode body (handle multipart: walk payload.parts[]; attrs via users.messages.attachments.get)
function decodeBody(data: string): string {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

// Send — raw is a full RFC 2822 MIME message, base64url-encoded (URL-safe!)
async function sendEmail(to: string, subject: string, text: string) {
  const raw = Buffer.from(
    `To: ${to}\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\n` +
    `Content-Type: text/plain; charset="UTF-8"\r\n\r\n${text}`,
  ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return gmail.users.messages.send({ userId: 'me', requestBody: { raw } }); // 100 units!
}

// Drafts (needs gmail.compose): create then send
const draft = await gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw } } });
await gmail.users.drafts.send({ userId: 'me', id: draft.data.id! });

// Mutate labels (needs gmail.modify)
await gmail.users.messages.modify({
  userId: 'me', id: messageId,
  requestBody: { addLabelIds: ['INBOX'], removeLabelIds: ['UNREAD'] },
});
```

**Search operators (`q`)** ([Gmail search operators](https://support.google.com/mail/answer/7190); same syntax as Gmail UI):
`from:`, `to:`, `subject:`, `cc:`, `bcc:`, `after:YYYY/MM/DD`, `before:`, `newer_than:2d`, `older_than:1w`, `is:unread`, `is:read`, `is:important`, `is:starred`, `is:draft`, `has:attachment`, `filename:pdf`, `in:inbox|sent|spam|trash`, `label:work`, `category:primary|updates|promotions`, `larger:10M`, `smaller:1M`, `from:me`, `to:me`, `-term` (negation), `OR`, `"exact phrase"`, `list:listname@example.com`, `has:youtube`.

## 3. Google Calendar API v3

**Scopes**: `calendar.readonly`, `calendar.events`, `calendar.events.readonly` — all **restricted**. `freebusy.query` requires `calendar.readonly` or `calendar.events.readonly` ([freebusy reference](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query)).

```ts
const cal = google.calendar({ version: 'v3', auth: oauth });

// List upcoming events (expanded instances, sorted)
const events = await cal.events.list({
  calendarId: 'primary',
  timeMin: new Date().toISOString(),
  timeMax: endOfWeek.toISOString(),
  singleEvents: true,        // expand recurring series
  orderBy: 'startTime',      // requires singleEvents: true
  maxResults: 100,
});

// Insert / update / delete
await cal.events.insert({ calendarId: 'primary', requestBody: {
  summary: '1:1 with Alice', location: 'Zoom',
  start: { dateTime: start.toISOString(), timeZone: 'America/New_York' }, // IANA tz
  end:   { dateTime: end.toISOString(),   timeZone: 'America/New_York' },
  attendees: [{ email: 'alice@example.com' }],
  reminders: { useDefault: true },
}, sendUpdates: 'all' }); // emails attendees
await cal.events.update({ calendarId: 'primary', eventId, requestBody: patch, sendUpdates: 'all' });
await cal.events.delete({ calendarId: 'primary', eventId, sendUpdates: 'all' });

// Free/busy across attendees (expensive; throttle!)
const fb = await cal.freebusy.query({ requestBody: {
  timeMin, timeMax,
  items: [{ id: 'primary' }],           // one item per calendar/attendee
} }); // fb.data.calendars['primary'].busy → [{ start, end }]

// Timezone notes: always send timeZone (IANA) with dateTime; use { date: 'YYYY-MM-DD' }
// for all-day events. The API default tz is UTC — never rely on the calendar's tz.
```

## 4. Google Drive API v3

**Scopes** ([Drive choose scopes](https://developers.google.com/drive/api/guides/api-specific-auth)):
- `drive.file` — **sensitive** (not restricted!). App can only see files **it created or the user opened with it** ("Open with…"). Ideal default for an agent.
- `drive.readonly` — restricted; view *all* files. `drive` — restricted; full read/write of everything.
- `drive.appdata` / `drive.metadata.readonly` — sensitive, for app-private data / metadata-only listing.

```ts
const drive = google.drive({ version: 'v3', auth: oauth });

// Search + partial response (fields keeps payloads small and fast)
const files = await drive.files.list({
  q: "mimeType='application/pdf' and name contains 'invoice' and trashed=false",
  fields: 'files(id,name,mimeType,size,webViewLink),nextPageToken',
  pageSize: 100,
});

// Create + small upload (multipart, single request; ≤ ~5 MB)
const small = await drive.files.create({
  requestBody: { name: 'notes.txt', parents: [folderId] }, // drive.file scope covers it
  media: { mimeType: 'text/plain', body: Buffer.from('hello world') },
  fields: 'id,name',
});

// Large upload — pass a stream and googleapis switches to RESUMABLE automatically
const big = await drive.files.create({
  requestBody: { name: 'video.mp4', parents: [folderId] },
  media: { mimeType: 'video/mp4', body: fs.createReadStream('video.mp4') },
}, { onUploadProgress: (e) => console.log(e.bytesRead) });

// Download / export Google Docs → office formats
const doc = await drive.files.export(
  { fileId, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  { responseType: 'arraybuffer' },
);
// Export mime types: docs→docx above; sheets→application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;
// slides→application/vnd.openxmlformats-officedocument.presentationml.presentation; also text/plain, application/pdf

// Share (permissions.create); drive or drive.file scope
await drive.permissions.create({
  fileId,
  requestBody: { role: 'reader', type: 'anyone' }, // link-sharing; or { role:'writer', type:'user', emailAddress }
  sendNotificationEmail: false,
});
// Upload/download guides: https://developers.google.com/drive/api/guides/manage-uploads
// https://developers.google.com/drive/api/guides/manage-downloads
```

## 5. YouTube Data API v3

**Scopes**: `youtube.readonly`, `youtube`, `youtube.upload`, `youtube.force-ssl` — all **restricted**. Uploads in practice require the YouTube API compliance audit for production use ([audit guide](https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits)); in **Testing status** they work for your ≤100 test users, and videos inserted by unaudited projects are typically locked **private**.

```ts
const yt = google.youtube({ version: 'v3', auth: oauth });

// Find the uploads playlist for the authenticated channel
const ch = await yt.channels.list({ part: ['contentDetails'], mine: true });
const uploadsPlaylistId = ch.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads!;

// Search videos (100 quota units each — very expensive)
const sr = await yt.search.list({ part: ['snippet'], q: 'deepseek tutorial', maxResults: 10, type: ['video'] });

// Stats / snippet by id (1 unit)
const vid = await yt.videos.list({ part: ['statistics', 'snippet'], id: [videoId] });

// Upload via resumable upload to the uploads playlist (1600 quota units; part of the 100 videos.insert/day cap)
const up = await yt.videos.insert({
  part: ['snippet', 'status'],
  requestBody: {
    snippet: { title: 'My upload', description: 'by Agents OS' },
    status: { privacyStatus: 'private', selfDeclaredMadeForKids: false },
  },
  media: { body: fs.createReadStream('video.mp4') }, // stream → resumable
});
// Upload guide: https://developers.google.com/youtube/v3/guides/uploading_a_video
// Quota costs: search.list=100, videos.insert=1600, videos.list=1, channels.list=1,
// playlistItems.list=1. Default: 100 search.list calls + 100 videos.insert calls + 10,000
// units/day for everything else (resets midnight PT): https://developers.google.com/youtube/v3/determine_quota_cost
```

## 6. Token storage + refresh middleware (single-user self-hosted)

Refresh tokens never expire while the grant is active (exception: **7 days in Testing status**), so a local JSON file is acceptable for a single-user self-hosted app — protect it with OS perms and never commit it.

```ts
import { Credentials } from 'google-auth-library';
import { promises as fs } from 'node:fs';
const TOKEN_PATH = process.env.TOKEN_PATH ?? './data/tokens.json';

export async function saveTokens(t: Credentials): Promise<void> {
  await fs.mkdir(dirname(TOKEN_PATH), { recursive: true });
  await fs.writeFile(TOKEN_PATH, JSON.stringify(t, null, 2), { mode: 0o600 });
}
export async function loadTokens(): Promise<Credentials> {
  return JSON.parse(await fs.readFile(TOKEN_PATH, 'utf-8'));
}

// TokenRefresh middleware pattern: one OAuth2Client per request, wired to re-save
export function authClient(): OAuth2Client {
  const oauth = new OAuth2Client(clientId, clientSecret, redirectUri);
  oauth.setCredentials({ refresh_token: tokens.refresh_token }); // access_token optional
  oauth.on('tokens', (t) => void saveTokens({ ...tokens, ...t })); // fires on silent refresh
  return oauth;
}

// Express middleware that also retries once on expired/invalid access token
export async function withGoogleApi<T>(fn: (auth: OAuth2Client) => Promise<T>): Promise<T> {
  const oauth = authClient();
  try { return await fn(oauth); }
  catch (e: any) {
    if (e?.response?.status === 401 || e?.code === 401) {
      await oauth.refreshAccessToken();      // throws invalid_grant if refresh_token revoked
      return fn(oauth);
    }
    if (e?.code === 'invalid_grant') { /* redirect user to /auth → consent flow */ }
    throw e;
  }
}
```

Also handle: 429/403 `rateLimitExceeded` → exponential backoff with jitter; `quotaExceeded` → stop, don't retry. Refresh tokens can be revoked by the user at [myaccount.google.com/permissions](https://myaccount.google.com/permissions) — always surface a "reconnect Google" path.

## 7. Gemini as the LLM brain (OpenAI-compatible)

**Endpoint:** `https://generativelanguage.googleapis.com/v1beta/openai/` — drop-in for the `openai` npm client ([OpenAI compatibility docs](https://ai.google.dev/gemini-api/docs/openai)). Function/tool calling is supported via the standard `tools`/`tool_calls` protocol. **API key:** [aistudio.google.com/apikey](https://aistudio.google.com/apikey).

```ts
import OpenAI from 'openai';

const llm = new OpenAI({
  apiKey: process.env.GEMINI_API_KEY,
  baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
});

const res = await llm.chat.completions.create({
  model: 'gemini-2.5-flash', // classic agent default; see note below
  messages: [{ role: 'user', content: 'Draft a reply to the last email from Alice' }],
  tools: [{
    type: 'function',
    function: {
      name: 'gmail_send',
      description: 'Send an email via Gmail',
      parameters: {
        type: 'object',
        properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } },
        required: ['to', 'subject', 'body'],
      },
    },
  }],
});
```

**Models** ([models list](https://ai.google.dev/gemini-api/docs/models)): the docs now lead with the Gemini **3.x** family — `gemini-3.8-flash` (agentic flagship), `gemini-3.7-flash`, `gemini-3.5-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-pro` (preview), `gemini-3-flash` (preview). The 2.x family (`gemini-2.5-flash`, `gemini-2.5-pro`, `gemini-2.0-flash`) remains available. All Chat Completions-capable models work through the OpenAI endpoint; embeddings and structured output (`response_format: json_schema`) are also supported. **Alternatives:** OpenAI (`api.openai.com`), DeepSeek (`https://api.deepseek.com`, OpenAI-compatible, `deepseek-chat` / `deepseek-reasoner`) — abstract the provider behind one client interface so the agent brain is swappable.

## 8. Quotas / limits (agent-relevant)

- **Gmail** ([usage limits](https://developers.google.com/workspace/gmail/api/reference/quota)): the classic model was **250 quota units/user/sec** (moving average) with `messages.list`=5, `messages.get`=5, `messages.send`=100, `messages.insert`=25, drafts=5. **Changed May 1, 2026** for new projects (projects active Nov 2025–Apr 2026 keep old quotas for now): **1,200,000 units/min/project, 6,000/min/user**, 80,000,000 units/day billing threshold (not billed yet, ≥90 days notice before billing), and new method costs — `messages.list`=5, `messages.get`=**20**, `threads.get`=**40**, `messages.send`=100, `history.list`=2. Gmail product limit: ~2,000 sent msgs/day for consumer accounts.
- **Calendar** ([usage limits](https://developers.google.com/workspace/calendar/api/guides/quota)): classic courtesy limit 1,000,000 queries/day. **May 1, 2026** for new projects: **10,000 req/min/project and 600 req/min/user**, with a 1M/day billing threshold. `freebusy.query` bursts hit per-user limits fastest — batch or back off.
- **Drive** ([limits](https://developers.google.com/drive/api/guides/limits)): per-user burst caps (~100 requests/100s per user) and per-project caps; media uploads count too. Use `fields` partial responses everywhere and back off on 403/429 `rateLimitExceeded`.
- **YouTube**: 10,000 units/day default; per-call costs above. Every request (even failed ones) costs ≥1 unit. More quota requires the compliance audit.
- **2025–2026 API changes worth knowing:** Google shipped official **Workspace MCP servers** (Gmail/Calendar/Drive) in 2025 as an agent-tool layer ([Workspace updates blog](https://workspaceupdates.googleblog.com/2026/05/agent-tools-and-security-updates-for-workspace-developers.html), [agent tools & safety model](https://developers.google.com/workspace/tools-safety)); YouTube policy update on view counting (Aug 2026); OAuth unused-client auto-deletion; granular (per-scope) consent screens. Gmail API v1 endpoints themselves are stable — the agent-facing changes are the new quota model and MCP option.

## Recommended default scope set for an agent platform

```ts
export const DEFAULT_SCOPES = [
  'openid', 'email', 'profile',       // basic identity — never restricted
  'gmail.readonly',                   // RESTRICTED
  'gmail.modify',                     // RESTRICTED (labels/archive/read-state)
  'gmail.send',                       // RESTRICTED
  'gmail.compose',                    // RESTRICTED (drafts)
  'calendar.events',                  // RESTRICTED (read+write events)
  'calendar.events.readonly',         // RESTRICTED (needed for freebusy.query)
  'drive.file',                       // sensitive — files the app creates/opens only. NOT restricted.
  'youtube.readonly',                 // RESTRICTED (optional)
  // 'youtube.upload',                // RESTRICTED + needs YouTube API audit; add only when needed
];
```

**What restricted means for testing:** restricted (and sensitive) scopes force app verification before public use — a security assessment (CASA Tier 2, annual) + verified brand ([verification FAQ](https://support.google.com/cloud/answer/9110914)). Until then: keep the consent screen in **Testing**, add your Google account as a test user (≤100), expect the "unverified/testing app" warning, re-consent every **7 days** (refresh tokens expire), and request scopes incrementally (`include_granted_scopes`) so the consent screen doesn't scare the user away.
