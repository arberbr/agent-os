import { google } from 'googleapis';
import type { Auth, gmail_v1 } from 'googleapis';
import { googleErrorMessage } from './auth.js';

// ── Gmail ───────────────────────────────────────────────────────────────
//
// One thin, typed wrapper per Gmail v1 operation the agents can reach. Every
// function maps API failures through `googleErrorMessage`, so the model always
// gets an actionable sentence ("reconnect Google", "enable the Gmail API")
// instead of a raw 403 body.
//
// Scope: the workspace grant carries `gmail.modify`, which covers reading,
// composing, sending, labels, drafts and trashing. Permanent deletion
// (`messages.delete`) needs the restricted `https://mail.google.com/` scope,
// which Agents OS deliberately does not request.

/** System labels Gmail predefines. Users may also pass their own label names. */
export const SYSTEM_LABELS = {
  inbox: 'INBOX',
  unread: 'UNREAD',
  starred: 'STARRED',
  important: 'IMPORTANT',
  spam: 'SPAM',
  trash: 'TRASH',
} as const;

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_MESSAGES_PER_CALL = 50;

// ── Types ───────────────────────────────────────────────────────────────

export interface GmailListItem {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  date: string;
  snippet: string;
  unread: boolean;
  labels: string[];
}

export interface GmailAttachmentMeta {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string;
}

export interface GmailMessage {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  cc: string;
  date: string;
  /** RFC 5322 Message-ID, needed to thread a reply. */
  messageId: string;
  body: string;
  labels: string[];
  attachments: GmailAttachmentMeta[];
}

export interface GmailAttachmentInput {
  filename: string;
  mimeType?: string;
  contentBase64: string;
}

export interface GmailThreadSummary {
  id: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
  messageCount: number;
  unread: boolean;
  labels: string[];
}

export interface GmailThread {
  id: string;
  subject: string;
  labels: string[];
  messages: Array<Pick<GmailMessage, 'id' | 'from' | 'to' | 'date' | 'subject' | 'body'>>;
}

export interface GmailLabel {
  id: string;
  name: string;
  type: string;
  messagesTotal: number;
  messagesUnread: number;
}

export interface GmailDraftSummary {
  id: string;
  messageId: string;
  threadId: string;
  to: string;
  subject: string;
  snippet: string;
}

export interface GmailProfile {
  email: string;
  messagesTotal: number;
  threadsTotal: number;
}

/** Result of any label operation, so callers report partial failures honestly. */
export interface LabelOpResult {
  updated: string[];
  failed: Array<{ id: string; error: string }>;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function api(auth: Auth.OAuth2Client): gmail_v1.Gmail {
  return google.gmail({ version: 'v1', auth });
}

function header(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
}

function toListItem(msg: gmail_v1.Schema$Message): GmailListItem {
  const headers = msg.payload?.headers;
  return {
    id: msg.id ?? '',
    threadId: msg.threadId ?? '',
    subject: header(headers, 'Subject'),
    from: header(headers, 'From'),
    to: header(headers, 'To'),
    date: header(headers, 'Date'),
    snippet: msg.snippet ?? '',
    unread: msg.labelIds?.includes('UNREAD') ?? false,
    labels: (msg.labelIds ?? []).filter((l) => !l.startsWith('CATEGORY_')),
  };
}

/** Walk the MIME tree collecting the text body and any attachment parts. */
function walkParts(
  part: gmail_v1.Schema$MessagePart | undefined,
  out: { text: string; html: string; attachments: GmailAttachmentMeta[] },
): void {
  if (!part) return;
  const mime = part.mimeType ?? '';
  const data = part.body?.data;

  if (mime === 'text/plain' && data && !out.text) {
    out.text = Buffer.from(data, 'base64url').toString('utf8');
  } else if (mime === 'text/html' && data && !out.html) {
    out.html = Buffer.from(data, 'base64url').toString('utf8');
  }

  if (part.filename && part.body?.attachmentId) {
    out.attachments.push({
      filename: part.filename,
      mimeType: mime || 'application/octet-stream',
      size: part.body.size ?? 0,
      attachmentId: part.body.attachmentId,
    });
  }

  for (const sub of part.parts ?? []) walkParts(sub, out);
}

/** Innermost text: prefer text/plain, fall back to tag-stripped HTML. */
function bodyOf(part: gmail_v1.Schema$MessagePart | undefined, limit = 20000): string {
  const out = { text: '', html: '', attachments: [] as GmailAttachmentMeta[] };
  walkParts(part, out);
  if (out.text) return out.text.slice(0, limit);
  if (out.html) {
    const stripped = out.html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return stripped.slice(0, limit);
  }
  return '';
}

/** Run `fn` over `items` with a bounded number of in-flight requests. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/** Pull bare addresses out of "Ada <ada@x.com>, bob@y.com". */
function extractAddresses(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.match(/<([^>]+)>/)?.[1] ?? part.trim())
    .map((addr) => addr.trim())
    .filter((addr) => addr.includes('@'));
}

/** Base64 the body and any attachments into an RFC 5322 message. */
function buildRawMessage(args: {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
  attachments?: GmailAttachmentInput[];
}): string {
  const head: string[] = [];
  head.push(`To: ${sanitizeHeaderValue(args.to)}`);
  if (args.cc) head.push(`Cc: ${sanitizeHeaderValue(args.cc)}`);
  if (args.bcc) head.push(`Bcc: ${sanitizeHeaderValue(args.bcc)}`);
  head.push(`Subject: ${sanitizeHeaderValue(args.subject)}`);
  if (args.inReplyTo) head.push(`In-Reply-To: ${sanitizeHeaderValue(args.inReplyTo)}`);
  if (args.references) head.push(`References: ${sanitizeHeaderValue(args.references)}`);

  const encodedBody = Buffer.from(args.body, 'utf8').toString('base64');
  const attachments = (args.attachments ?? []).filter((a) => a.contentBase64);

  if (attachments.length === 0) {
    return [
      ...head,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      encodedBody,
    ].join('\r\n');
  }

  const boundary = `agents-os-${Math.random().toString(36).slice(2)}`;
  const lines: string[] = [
    ...head,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    encodedBody,
  ];
  for (const file of attachments) {
    const name = sanitizeHeaderValue(file.filename).replace(/"/g, '');
    lines.push(
      `--${boundary}`,
      `Content-Type: ${file.mimeType || 'application/octet-stream'}; name="${name}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${name}"`,
      '',
      file.contentBase64.replace(/\s+/g, ''),
    );
  }
  lines.push(`--${boundary}--`);
  return lines.join('\r\n');
}

/** Message ids from either `id` (one) or `ids` (many), de-duplicated and capped. */
export function collectIds(args: { id?: unknown; ids?: unknown }): string[] {
  const many = Array.isArray(args.ids) ? args.ids.filter((v): v is string => typeof v === 'string') : [];
  const one = typeof args.id === 'string' && args.id ? [args.id] : [];
  return [...new Set([...many, ...one])].slice(0, MAX_MESSAGES_PER_CALL);
}

// ── Messages: read ──────────────────────────────────────────────────────

/** Search Gmail with the standard query syntax (from:, is:unread, after:…). */
export async function gmailSearch(
  auth: Auth.OAuth2Client,
  args: { query?: string; maxResults?: number; labelIds?: string[]; includeSpamTrash?: boolean },
): Promise<GmailListItem[]> {
  try {
    const max = Math.min(Math.max(args.maxResults ?? 10, 1), MAX_MESSAGES_PER_CALL);
    const res = await api(auth).users.messages.list({
      userId: 'me',
      q: args.query || undefined,
      labelIds: args.labelIds?.length ? args.labelIds : undefined,
      includeSpamTrash: args.includeSpamTrash || undefined,
      maxResults: max,
    });
    const ids = (res.data.messages ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
    if (ids.length === 0) return [];
    const gmail = api(auth);
    return await mapLimit(ids, 6, async (id) => {
      const m = await gmail.users.messages.get({
        userId: 'me',
        id,
        format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'To', 'Date'],
      });
      return toListItem(m.data);
    });
  } catch (err) {
    throw new Error(googleErrorMessage(err));
  }
}

export async function gmailGet(auth: Auth.OAuth2Client, id: string): Promise<GmailMessage> {
  try {
    const res = await api(auth).users.messages.get({ userId: 'me', id, format: 'full' });
    const data = res.data;
    const headers = data.payload?.headers;
    const walked = { text: '', html: '', attachments: [] as GmailAttachmentMeta[] };
    walkParts(data.payload, walked);
    return {
      id: data.id ?? id,
      threadId: data.threadId ?? '',
      subject: header(headers, 'Subject'),
      from: header(headers, 'From'),
      to: header(headers, 'To'),
      cc: header(headers, 'Cc'),
      date: header(headers, 'Date'),
      messageId: header(headers, 'Message-ID'),
      body: bodyOf(data.payload),
      labels: data.labelIds ?? [],
      attachments: walked.attachments,
    };
  } catch (err) {
    throw new Error(googleErrorMessage(err));
  }
}

/** Download one attachment; small files come back as base64 for drive_upload_file. */
export async function gmailGetAttachment(
  auth: Auth.OAuth2Client,
  args: { messageId: string; attachmentId: string; filename?: string },
): Promise<{ filename: string; mimeType: string; size: number; contentBase64?: string; text?: string; truncated: boolean }> {
  try {
    const gmail = api(auth);
    const res = await gmail.users.messages.attachments.get({
      userId: 'me',
      messageId: args.messageId,
      id: args.attachmentId,
    });
    const size = res.data.size ?? 0;
    if (size > MAX_ATTACHMENT_BYTES) {
      throw new Error(
        `Attachment is ${(size / 1024 / 1024).toFixed(1)} MB; this tool transfers up to ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`,
      );
    }
    const contentBase64 = res.data.data ? Buffer.from(res.data.data, 'base64url').toString('base64') : '';

    // Pull the filename/mime from the message when the caller did not pass it.
    let filename = args.filename ?? 'attachment';
    let mimeType = 'application/octet-stream';
    if (!args.filename) {
      const msg = await gmail.users.messages.get({ userId: 'me', id: args.messageId, format: 'full' });
      const walked = { text: '', html: '', attachments: [] as GmailAttachmentMeta[] };
      walkParts(msg.data.payload, walked);
      const found = walked.attachments.find((a) => a.attachmentId === args.attachmentId);
      if (found) {
        filename = found.filename;
        mimeType = found.mimeType;
      }
    }

    const isText = mimeType.startsWith('text/') || mimeType === 'application/json';
    return {
      filename,
      mimeType,
      size,
      contentBase64: isText ? undefined : contentBase64,
      text: isText ? Buffer.from(contentBase64, 'base64').toString('utf8') : undefined,
      truncated: false,
    };
  } catch (err) {
    throw new Error(googleErrorMessage(err));
  }
}

export async function gmailGetProfile(auth: Auth.OAuth2Client): Promise<GmailProfile> {
  try {
    const res = await api(auth).users.getProfile({ userId: 'me' });
    return {
      email: res.data.emailAddress ?? '',
      messagesTotal: res.data.messagesTotal ?? 0,
      threadsTotal: res.data.threadsTotal ?? 0,
    };
  } catch (err) {
    throw new Error(googleErrorMessage(err));
  }
}

// ── Threads ─────────────────────────────────────────────────────────────

export async function gmailListThreads(
  auth: Auth.OAuth2Client,
  args: { query?: string; maxResults?: number; labelIds?: string[] },
): Promise<GmailThreadSummary[]> {
  try {
    const max = Math.min(Math.max(args.maxResults ?? 10, 1), MAX_MESSAGES_PER_CALL);
    const gmail = api(auth);
    const res = await gmail.users.threads.list({
      userId: 'me',
      q: args.query || undefined,
      labelIds: args.labelIds?.length ? args.labelIds : undefined,
      maxResults: max,
    });
    const ids = (res.data.threads ?? []).map((t) => t.id).filter((id): id is string => Boolean(id));
    if (ids.length === 0) return [];
    return await mapLimit(ids, 6, async (id) => {
      const t = await gmail.users.threads.get({
        userId: 'me',
        id,
        format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'To', 'Date'],
      });
      const messages = t.data.messages ?? [];
      const first = messages[0];
      const last = messages[messages.length - 1] ?? first;
      return {
        id,
        subject: header(first?.payload?.headers, 'Subject'),
        from: header(first?.payload?.headers, 'From'),
        date: header(last?.payload?.headers, 'Date'),
        snippet: t.data.snippet ?? last?.snippet ?? '',
        messageCount: messages.length,
        unread: (last?.labelIds ?? []).includes('UNREAD'),
        labels: (last?.labelIds ?? []).filter((l) => !l.startsWith('CATEGORY_')),
      };
    });
  } catch (err) {
    throw new Error(googleErrorMessage(err));
  }
}

export async function gmailGetThread(auth: Auth.OAuth2Client, id: string): Promise<GmailThread> {
  try {
    const res = await api(auth).users.threads.get({ userId: 'me', id, format: 'full' });
    const messages = res.data.messages ?? [];
    const first = messages[0];
    const last = messages[messages.length - 1] ?? first;
    return {
      id: res.data.id ?? id,
      subject: header(first?.payload?.headers, 'Subject'),
      labels: (last?.labelIds ?? []).filter((l) => !l.startsWith('CATEGORY_')),
      messages: messages.map((m) => ({
        id: m.id ?? '',
        from: header(m.payload?.headers, 'From'),
        to: header(m.payload?.headers, 'To'),
        date: header(m.payload?.headers, 'Date'),
        subject: header(m.payload?.headers, 'Subject'),
        body: bodyOf(m.payload, 8000),
      })),
    };
  } catch (err) {
    throw new Error(googleErrorMessage(err));
  }
}

// ── Labels ──────────────────────────────────────────────────────────────

export async function gmailListLabels(auth: Auth.OAuth2Client): Promise<GmailLabel[]> {
  try {
    const res = await api(auth).users.labels.list({ userId: 'me' });
    return (res.data.labels ?? [])
      .map((l) => ({
        id: l.id ?? '',
        name: l.name ?? '',
        type: l.type ?? 'user',
        messagesTotal: l.messagesTotal ?? 0,
        messagesUnread: l.messagesUnread ?? 0,
      }))
      .filter((l) => l.id)
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    throw new Error(googleErrorMessage(err));
  }
}

export async function gmailCreateLabel(auth: Auth.OAuth2Client, name: string): Promise<GmailLabel> {
  try {
    const res = await api(auth).users.labels.create({
      userId: 'me',
      requestBody: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
    });
    return {
      id: res.data.id ?? '',
      name: res.data.name ?? name,
      type: res.data.type ?? 'user',
      messagesTotal: res.data.messagesTotal ?? 0,
      messagesUnread: res.data.messagesUnread ?? 0,
    };
  } catch (err) {
    throw new Error(googleErrorMessage(err));
  }
}

/**
 * Turn label input (system ids like INBOX/UNREAD/STARRED or user label names
 * such as "Projects/Work") into the ids the API wants. Unknown names fall
 * through as-is so a caller can pass a raw id.
 */
export async function gmailResolveLabelIds(auth: Auth.OAuth2Client, labels: string[]): Promise<string[]> {
  if (labels.length === 0) return [];
  const all = await gmailListLabels(auth);
  const byName = new Map(all.map((l) => [l.name.toLowerCase(), l.id]));
  const known = new Set(all.map((l) => l.id));
  return [...new Set(labels.map((raw) => {
    const trimmed = raw.trim();
    if (known.has(trimmed)) return trimmed;
    return byName.get(trimmed.toLowerCase()) ?? trimmed;
  }))];
}

// ── Label operations (archive, read state, stars, custom labels) ────────

async function applyToMessages(
  auth: Auth.OAuth2Client,
  ids: string[],
  addLabelIds: string[],
  removeLabelIds: string[],
): Promise<LabelOpResult> {
  const gmail = api(auth);
  // One call for many messages; per-message calls only when a batch fails.
  if (ids.length > 1) {
    try {
      await gmail.users.messages.batchModify({
        userId: 'me',
        requestBody: { ids, addLabelIds, removeLabelIds },
      });
      return { updated: ids, failed: [] };
    } catch {
      // fall through to per-message so one bad id cannot fail the batch
    }
  }
  const result: LabelOpResult = { updated: [], failed: [] };
  for (const id of ids) {
    try {
      await gmail.users.messages.modify({ userId: 'me', id, requestBody: { addLabelIds, removeLabelIds } });
      result.updated.push(id);
    } catch (err) {
      result.failed.push({ id, error: googleErrorMessage(err) });
    }
  }
  if (result.updated.length === 0 && result.failed.length > 0) {
    throw new Error(result.failed[0]!.error);
  }
  return result;
}

async function applyToThreads(
  auth: Auth.OAuth2Client,
  ids: string[],
  addLabelIds: string[],
  removeLabelIds: string[],
): Promise<LabelOpResult> {
  const gmail = api(auth);
  const result: LabelOpResult = { updated: [], failed: [] };
  for (const id of ids) {
    try {
      await gmail.users.threads.modify({ userId: 'me', id, requestBody: { addLabelIds, removeLabelIds } });
      result.updated.push(id);
    } catch (err) {
      result.failed.push({ id, error: googleErrorMessage(err) });
    }
  }
  if (result.updated.length === 0 && result.failed.length > 0) {
    throw new Error(result.failed[0]!.error);
  }
  return result;
}

export async function gmailModifyLabels(
  auth: Auth.OAuth2Client,
  targets: { messageIds?: string[]; threadIds?: string[]; add?: string[]; remove?: string[] },
): Promise<{ messages?: LabelOpResult; threads?: LabelOpResult }> {
  try {
    const add = await gmailResolveLabelIds(auth, targets.add ?? []);
    const remove = await gmailResolveLabelIds(auth, targets.remove ?? []);
    if (add.length === 0 && remove.length === 0) {
      throw new Error('Provide at least one label to add or remove (addLabels / removeLabels).');
    }
    const out: { messages?: LabelOpResult; threads?: LabelOpResult } = {};
    if (targets.messageIds?.length) out.messages = await applyToMessages(auth, targets.messageIds, add, remove);
    if (targets.threadIds?.length) out.threads = await applyToThreads(auth, targets.threadIds, add, remove);
    return out;
  } catch (err) {
    throw new Error(googleErrorMessage(err));
  }
}

/**
 * Named single-label operations. Every one is the same modify call with a
 * different label delta, which is why they share this table.
 */
export const LABEL_OPS: Record<string, { add: string[]; remove: string[] }> = {
  archive: { add: [], remove: [SYSTEM_LABELS.inbox] },
  move_to_inbox: { add: [SYSTEM_LABELS.inbox], remove: [] },
  mark_read: { add: [], remove: [SYSTEM_LABELS.unread] },
  mark_unread: { add: [SYSTEM_LABELS.unread], remove: [] },
  star: { add: [SYSTEM_LABELS.starred], remove: [] },
  unstar: { add: [], remove: [SYSTEM_LABELS.starred] },
};

export async function gmailApplyLabelOp(
  auth: Auth.OAuth2Client,
  op: keyof typeof LABEL_OPS,
  targets: { messageIds?: string[]; threadIds?: string[] },
): Promise<{ messages?: LabelOpResult; threads?: LabelOpResult }> {
  const delta = LABEL_OPS[op];
  if (!delta) throw new Error(`Unknown label operation "${op}".`);
  return gmailModifyLabels(auth, { ...targets, add: delta.add, remove: delta.remove });
}

// ── Send / reply / forward ──────────────────────────────────────────────

export async function gmailSend(
  auth: Auth.OAuth2Client,
  args: { to: string; subject: string; body: string; cc?: string; bcc?: string; attachments?: GmailAttachmentInput[] },
): Promise<{ id: string; threadId: string; attachmentsSent: number }> {
  try {
    const raw = buildRawMessage(args);
    const res = await api(auth).users.messages.send({
      userId: 'me',
      requestBody: { raw: Buffer.from(raw, 'utf8').toString('base64url') },
    });
    return { id: res.data.id ?? '', threadId: res.data.threadId ?? '', attachmentsSent: args.attachments?.length ?? 0 };
  } catch (err) {
    throw new Error(googleErrorMessage(err));
  }
}

export async function gmailCreateDraft(
  auth: Auth.OAuth2Client,
  args: { to: string; subject: string; body: string; cc?: string; bcc?: string; attachments?: GmailAttachmentInput[] },
): Promise<{ id: string; link: string }> {
  try {
    const raw = buildRawMessage(args);
    const res = await api(auth).users.drafts.create({
      userId: 'me',
      requestBody: { message: { raw: Buffer.from(raw, 'utf8').toString('base64url') } },
    });
    const id = res.data.id ?? '';
    return {
      id,
      link: id ? `https://mail.google.com/mail/u/0/#drafts?compose=${encodeURIComponent(id)}` : '',
    };
  } catch (err) {
    throw new Error(googleErrorMessage(err));
  }
}

export async function gmailListDrafts(auth: Auth.OAuth2Client, args: { maxResults?: number } = {}): Promise<GmailDraftSummary[]> {
  try {
    const gmail = api(auth);
    const max = Math.min(Math.max(args.maxResults ?? 10, 1), MAX_MESSAGES_PER_CALL);
    const res = await gmail.users.drafts.list({ userId: 'me', maxResults: max });
    const ids = (res.data.drafts ?? []).map((d) => d.id).filter((id): id is string => Boolean(id));
    if (ids.length === 0) return [];
    return await mapLimit(ids, 6, async (id) => {
      // drafts.get has no metadata mode: it returns the draft's full message.
      const d = await gmail.users.drafts.get({ userId: 'me', id });
      const headers = d.data.message?.payload?.headers;
      return {
        id,
        messageId: d.data.message?.id ?? '',
        threadId: d.data.message?.threadId ?? '',
        to: header(headers, 'To'),
        subject: header(headers, 'Subject'),
        snippet: d.data.message?.snippet ?? '',
      };
    });
  } catch (err) {
    throw new Error(googleErrorMessage(err));
  }
}

export async function gmailSendDraft(auth: Auth.OAuth2Client, draftId: string): Promise<{ id: string; threadId: string }> {
  try {
    const res = await api(auth).users.drafts.send({ userId: 'me', requestBody: { id: draftId } });
    return { id: res.data.id ?? '', threadId: res.data.threadId ?? '' };
  } catch (err) {
    throw new Error(googleErrorMessage(err));
  }
}

export async function gmailDeleteDraft(auth: Auth.OAuth2Client, draftId: string): Promise<{ id: string; deleted: true }> {
  try {
    await api(auth).users.drafts.delete({ userId: 'me', id: draftId });
    return { id: draftId, deleted: true };
  } catch (err) {
    throw new Error(googleErrorMessage(err));
  }
}

/**
 * Reply inside the original thread with proper threading headers, so Gmail
 * shows it as a reply rather than a new conversation.
 */
export async function gmailReply(
  auth: Auth.OAuth2Client,
  args: { messageId: string; body: string; replyAll?: boolean; cc?: string; bcc?: string; attachments?: GmailAttachmentInput[] },
): Promise<{ id: string; threadId: string; to: string; subject: string }> {
  try {
    const gmail = api(auth);
    const original = await gmail.users.messages.get({
      userId: 'me',
      id: args.messageId,
      format: 'metadata',
      metadataHeaders: ['Subject', 'From', 'To', 'Cc', 'Message-ID', 'References'],
    });
    const headers = original.data.payload?.headers;
    const from = header(headers, 'From');
    const subjectRaw = header(headers, 'Subject');
    const subject = /^re:/i.test(subjectRaw.trim()) ? subjectRaw : `Re: ${subjectRaw}`;

    let to = extractAddresses(from)[0] ?? from;
    if (args.replyAll) {
      const self = await gmailGetProfile(auth);
      const everyone = [
        ...extractAddresses(from),
        ...extractAddresses(header(headers, 'To')),
        ...extractAddresses(header(headers, 'Cc')),
      ];
      const unique = [...new Set(everyone)].filter((addr) => addr && addr.toLowerCase() !== self.email.toLowerCase());
      if (unique.length > 0) to = unique.join(', ');
    }

    const originalMessageId = header(headers, 'Message-ID');
    const references = [header(headers, 'References'), originalMessageId].filter(Boolean).join(' ').trim();

    const raw = buildRawMessage({
      to,
      cc: args.cc,
      bcc: args.bcc,
      subject,
      body: args.body,
      inReplyTo: originalMessageId || undefined,
      references: references || undefined,
      attachments: args.attachments,
    });
    const res = await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: Buffer.from(raw, 'utf8').toString('base64url'),
        threadId: original.data.threadId || undefined,
      },
    });
    return { id: res.data.id ?? '', threadId: res.data.threadId ?? '', to, subject };
  } catch (err) {
    throw new Error(googleErrorMessage(err));
  }
}

/** Forward a message, quoting the original below an optional note. */
export async function gmailForward(
  auth: Auth.OAuth2Client,
  args: { messageId: string; to: string; note?: string; cc?: string; bcc?: string },
): Promise<{ id: string; threadId: string; subject: string }> {
  try {
    const original = await gmailGet(auth, args.messageId);
    const subject = /^fwd:/i.test(original.subject.trim()) ? original.subject : `Fwd: ${original.subject}`;
    const quoted = [
      args.note ?? '',
      '',
      '---------- Forwarded message ----------',
      `From: ${original.from}`,
      `Date: ${original.date}`,
      `Subject: ${original.subject}`,
      `To: ${original.to}`,
      ...(original.cc ? [`Cc: ${original.cc}`] : []),
      '',
      original.body,
    ].join('\n');
    const raw = buildRawMessage({ to: args.to, cc: args.cc, bcc: args.bcc, subject, body: quoted });
    const res = await api(auth).users.messages.send({
      userId: 'me',
      requestBody: { raw: Buffer.from(raw, 'utf8').toString('base64url') },
    });
    return { id: res.data.id ?? '', threadId: res.data.threadId ?? '', subject };
  } catch (err) {
    throw new Error(googleErrorMessage(err));
  }
}

// ── Trash ───────────────────────────────────────────────────────────────

/**
 * Move messages to Trash ("delete"). Uses the `gmail.modify` scope — messages
 * stay recoverable in Trash for ~30 days. Permanent deletion needs the
 * restricted `https://mail.google.com/` scope, which Agents OS does not request.
 */
export async function gmailTrash(auth: Auth.OAuth2Client, ids: string[]): Promise<LabelOpResult> {
  const gmail = api(auth);
  const result: LabelOpResult = { updated: [], failed: [] };
  for (const id of ids.slice(0, MAX_MESSAGES_PER_CALL)) {
    try {
      await gmail.users.messages.trash({ userId: 'me', id });
      result.updated.push(id);
    } catch (err) {
      result.failed.push({ id, error: googleErrorMessage(err) });
    }
  }
  if (result.updated.length === 0 && result.failed.length > 0) {
    throw new Error(result.failed[0]!.error);
  }
  return result;
}

export async function gmailUntrash(auth: Auth.OAuth2Client, id: string): Promise<{ id: string }> {
  try {
    await api(auth).users.messages.untrash({ userId: 'me', id });
    return { id };
  } catch (err) {
    throw new Error(googleErrorMessage(err));
  }
}

/** Restore several messages at once, reporting per-id failures. */
export async function gmailUntrashMany(auth: Auth.OAuth2Client, ids: string[]): Promise<LabelOpResult> {
  const gmail = api(auth);
  const result: LabelOpResult = { updated: [], failed: [] };
  for (const id of ids.slice(0, MAX_MESSAGES_PER_CALL)) {
    try {
      await gmail.users.messages.untrash({ userId: 'me', id });
      result.updated.push(id);
    } catch (err) {
      result.failed.push({ id, error: googleErrorMessage(err) });
    }
  }
  if (result.updated.length === 0 && result.failed.length > 0) {
    throw new Error(result.failed[0]!.error);
  }
  return result;
}

export async function gmailTrashThreads(auth: Auth.OAuth2Client, ids: string[]): Promise<LabelOpResult> {
  const gmail = api(auth);
  const result: LabelOpResult = { updated: [], failed: [] };
  for (const id of ids.slice(0, MAX_MESSAGES_PER_CALL)) {
    try {
      await gmail.users.threads.trash({ userId: 'me', id });
      result.updated.push(id);
    } catch (err) {
      result.failed.push({ id, error: googleErrorMessage(err) });
    }
  }
  if (result.updated.length === 0 && result.failed.length > 0) {
    throw new Error(result.failed[0]!.error);
  }
  return result;
}

export async function gmailUntrashThreads(auth: Auth.OAuth2Client, ids: string[]): Promise<LabelOpResult> {
  const gmail = api(auth);
  const result: LabelOpResult = { updated: [], failed: [] };
  for (const id of ids.slice(0, MAX_MESSAGES_PER_CALL)) {
    try {
      await gmail.users.threads.untrash({ userId: 'me', id });
      result.updated.push(id);
    } catch (err) {
      result.failed.push({ id, error: googleErrorMessage(err) });
    }
  }
  if (result.updated.length === 0 && result.failed.length > 0) {
    throw new Error(result.failed[0]!.error);
  }
  return result;
}
