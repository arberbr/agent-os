import { registerTool, type ToolContext } from './registry.js';
import type { ScopeGroup } from '../config.js';
import { getAuthedClient } from '../google/auth.js';
import {
  gmailSearch, gmailGet, gmailSend, gmailCreateDraft, gmailTrash, gmailUntrashMany,
  gmailTrashThreads, gmailUntrashThreads, gmailListThreads, gmailGetThread,
  gmailListLabels, gmailCreateLabel, gmailListDrafts, gmailSendDraft,
  gmailDeleteDraft, gmailReply, gmailForward, gmailGetAttachment, gmailGetProfile,
  gmailModifyLabels, gmailApplyLabelOp, gmailResolveLabelIds, collectIds,
  type GmailAttachmentInput,
} from '../google/gmail.js';
import {
  calendarListEvents, calendarCreateEvent, calendarUpdateEvent, calendarDeleteEvent, calendarFindFreeTime,
} from '../google/calendar.js';
import {
  driveListFiles, driveCreateDoc, driveAppendDoc, driveCreateSheet, driveReadSheet,
  driveUploadFile, driveGetFileContent, driveShareFile,
} from '../google/drive.js';
import {
  youtubeSearchVideos, youtubeGetVideo, youtubeListMyVideos, youtubeUploadVideo,
} from '../google/youtube.js';

async function requireAuth(ctx: ToolContext, group: ScopeGroup) {
  const auth = ctx.googleAuth[group];
  if (auth) return auth;
  throw new Error(
    group === 'youtube'
      ? 'YouTube is not connected. Open the Integrations page and click Connect next to YouTube — Google requires it to be authorized separately from Drive.'
      : 'Google Workspace (Gmail/Calendar/Drive) is not connected. Open the Integrations page and click Connect next to "Gmail · Calendar · Drive".',
  );
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : v == null ? fallback : String(v));
const num = (v: unknown, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const strArr = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;

/**
 * Every Gmail tool that changes a message can be aimed at single messages
 * (`id`/`ids`) or at whole conversations (`threadId`/`threadIds`).
 */
const ID_PARAMS = {
  id: { type: 'string', description: 'A single message id (from gmail_search or gmail_get_message)' },
  ids: { type: 'array', items: { type: 'string' }, description: 'Message ids, max 50' },
  threadId: { type: 'string', description: 'A single thread id (acts on the whole conversation)' },
  threadIds: { type: 'array', items: { type: 'string' }, description: 'Thread ids, max 50' },
};

const ATTACHMENTS_PARAM = {
  type: 'array',
  description: 'Files to attach, as base64 content. Read an existing Gmail attachment with gmail_get_attachment, or produce the bytes another way.',
  items: {
    type: 'object',
    properties: {
      filename: { type: 'string', description: 'File name including extension' },
      mimeType: { type: 'string', description: 'MIME type, e.g. application/pdf, image/png (default application/octet-stream)' },
      contentBase64: { type: 'string', description: 'Base64-encoded file bytes' },
    },
    required: ['filename', 'contentBase64'],
    additionalProperties: false,
  },
};

/** Resolve the message/thread ids a Gmail tool was called with. */
function targetsOf(args: Record<string, unknown>): { messageIds: string[]; threadIds: string[] } {
  const messageIds = collectIds(args);
  const threadIds = [...new Set([
    ...(strArr(args.threadIds) ?? []),
    ...(str(args.threadId) ? [str(args.threadId)] : []),
  ])].slice(0, 50);
  if (messageIds.length === 0 && threadIds.length === 0) {
    throw new Error('Provide at least one message id (id / ids) or thread id (threadId / threadIds).');
  }
  return { messageIds, threadIds };
}

/** Parse the optional attachments argument into sender-ready files. */
function attachmentsOf(value: unknown): GmailAttachmentInput[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const files: GmailAttachmentInput[] = [];
  for (const raw of value) {
    const a = (raw ?? {}) as Record<string, unknown>;
    const filename = str(a.filename).trim();
    const contentBase64 = str(a.contentBase64).trim();
    if (!filename || !contentBase64) continue;
    files.push({ filename, mimeType: str(a.mimeType).trim() || undefined, contentBase64 });
  }
  return files.length > 0 ? files : undefined;
}

/** One Gmail label operation per tool — same body, different label delta. */
function registerLabelOp(name: string, op: Parameters<typeof gmailApplyLabelOp>[1], description: string): void {
  registerTool({
    name,
    description,
    parameters: { type: 'object', properties: ID_PARAMS, additionalProperties: false },
    requiresGoogle: true,
    async execute(args, ctx) {
      const auth = await requireAuth(ctx, 'workspace');
      return gmailApplyLabelOp(auth, op, targetsOf(args));
    },
  });
}

// ── Gmail ───────────────────────────────────────────────────────────────

registerTool({
  name: 'gmail_search',
  description: 'Search the user\'s Gmail using Gmail search syntax, e.g. "from:boss@example.com is:unread", "subject:invoice after:2025/01/01", "in:anywhere has:attachment". Returns message metadata (id, threadId, subject, sender, date, snippet, labels, unread). Omit the query to list a label, e.g. labelIds ["INBOX"].',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Gmail search query (optional if labelIds is given)' },
      maxResults: { type: 'number', description: 'Max results, default 10, max 50' },
      labelIds: { type: 'array', items: { type: 'string' }, description: 'Restrict to labels, e.g. ["INBOX"], ["UNREAD"], ["STARRED"] or a custom label name' },
      includeSpamTrash: { type: 'boolean', description: 'Also search Spam and Trash' },
    },
    additionalProperties: false,
  },
  requiresGoogle: true,
  async execute(args, ctx) {
    const auth = await requireAuth(ctx, 'workspace');
    const labelIds = strArr(args.labelIds);
    return gmailSearch(auth, {
      query: str(args.query) || undefined,
      maxResults: num(args.maxResults, 10),
      labelIds: labelIds ? await gmailResolveLabelIds(auth, labelIds) : undefined,
      includeSpamTrash: args.includeSpamTrash === true,
    });
  },
});

registerTool({
  name: 'gmail_get_message',
  description: 'Fetch the full content (headers + body text) of a Gmail message by id.',
  parameters: {
    type: 'object',
    properties: { id: { type: 'string', description: 'Message id' } },
    required: ['id'],
    additionalProperties: false,
  },
  requiresGoogle: true,
  async execute(args, ctx) {
    const auth = await requireAuth(ctx, 'workspace');
    return gmailGet(auth, str(args.id));
  },
});

registerTool({
  name: 'gmail_send',
  description: 'Send an email from the user\'s Gmail account, optionally with attachments. Always confirm the recipient and content with the user before sending.',
  parameters: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Recipient email (comma-separate multiple)' },
      subject: { type: 'string' },
      body: { type: 'string', description: 'Plain-text email body' },
      cc: { type: 'string' },
      bcc: { type: 'string' },
      attachments: ATTACHMENTS_PARAM,
    },
    required: ['to', 'subject', 'body'],
    additionalProperties: false,
  },
  requiresGoogle: true,
  async execute(args, ctx) {
    const auth = await requireAuth(ctx, 'workspace');
    return gmailSend(auth, {
      to: str(args.to),
      subject: str(args.subject),
      body: str(args.body),
      cc: str(args.cc) || undefined,
      bcc: str(args.bcc) || undefined,
      attachments: attachmentsOf(args.attachments),
    });
  },
});

registerTool({
  name: 'gmail_create_draft',
  description: 'Create a draft email in the user\'s Gmail (does not send). Returns the draft id and a Gmail link that opens it in the composer, so the user can review before sending. Send it later with gmail_send_draft.',
  parameters: {
    type: 'object',
    properties: {
      to: { type: 'string' },
      subject: { type: 'string' },
      body: { type: 'string' },
      cc: { type: 'string' },
      bcc: { type: 'string' },
      attachments: ATTACHMENTS_PARAM,
    },
    required: ['to', 'subject', 'body'],
    additionalProperties: false,
  },
  requiresGoogle: true,
  async execute(args, ctx) {
    const auth = await requireAuth(ctx, 'workspace');
    return gmailCreateDraft(auth, {
      to: str(args.to),
      subject: str(args.subject),
      body: str(args.body),
      cc: str(args.cc) || undefined,
      bcc: str(args.bcc) || undefined,
      attachments: attachmentsOf(args.attachments),
    });
  },
});

registerTool({
  name: 'gmail_trash_email',
  description: 'Delete email by moving it to Trash (recoverable for ~30 days; permanent deletion is not available). Works on messages (id/ids) or whole conversations (threadId/threadIds). Always confirm with the user before deleting.',
  parameters: {
    type: 'object',
    properties: ID_PARAMS,
    additionalProperties: false,
  },
  requiresGoogle: true,
  async execute(args, ctx) {
    const auth = await requireAuth(ctx, 'workspace');
    const { messageIds, threadIds } = targetsOf(args);
    const out: { messages?: unknown; threads?: unknown } = {};
    if (messageIds.length) out.messages = await gmailTrash(auth, messageIds);
    if (threadIds.length) out.threads = await gmailTrashThreads(auth, threadIds);
    return out;
  },
});

registerTool({
  name: 'gmail_untrash_email',
  description: 'Restore trashed email back to the inbox. Works on messages (id/ids) or whole conversations (threadId/threadIds).',
  parameters: {
    type: 'object',
    properties: ID_PARAMS,
    additionalProperties: false,
  },
  requiresGoogle: true,
  async execute(args, ctx) {
    const auth = await requireAuth(ctx, 'workspace');
    const { messageIds, threadIds } = targetsOf(args);
    const out: { messages?: unknown; threads?: unknown } = {};
    if (messageIds.length) out.messages = await gmailUntrashMany(auth, messageIds);
    if (threadIds.length) out.threads = await gmailUntrashThreads(auth, threadIds);
    return out;
  },
});

registerTool({
  name: 'gmail_list_threads',
  description: 'Search conversations (threads) rather than individual messages. Returns thread id, subject, first sender, last date, message count and labels — use the thread id with gmail_get_thread or the label tools to act on a whole conversation.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Gmail search query' },
      maxResults: { type: 'number', description: 'Default 10, max 50' },
      labelIds: { type: 'array', items: { type: 'string' }, description: 'Restrict to labels (INBOX, UNREAD, a custom label name…)' },
    },
    additionalProperties: false,
  },
  requiresGoogle: true,
  async execute(args, ctx) {
    const auth = await requireAuth(ctx, 'workspace');
    const labelIds = strArr(args.labelIds);
    return gmailListThreads(auth, {
      query: str(args.query) || undefined,
      maxResults: num(args.maxResults, 10),
      labelIds: labelIds ? await gmailResolveLabelIds(auth, labelIds) : undefined,
    });
  },
});

registerTool({
  name: 'gmail_get_thread',
  description: 'Read a whole conversation: every message in the thread with sender, date and body text. Use this to understand an email exchange before replying or summarising it.',
  parameters: {
    type: 'object',
    properties: { id: { type: 'string', description: 'Thread id (from gmail_list_threads or gmail_search)' } },
    required: ['id'],
    additionalProperties: false,
  },
  requiresGoogle: true,
  async execute(args, ctx) {
    const auth = await requireAuth(ctx, 'workspace');
    return gmailGetThread(auth, str(args.id));
  },
});

registerTool({
  name: 'gmail_list_labels',
  description: 'List every Gmail label with its id, name, type and message counts. Call this before gmail_modify_labels when you need a custom label\'s exact name.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  requiresGoogle: true,
  async execute(_args, ctx) {
    const auth = await requireAuth(ctx, 'workspace');
    return gmailListLabels(auth);
  },
});

registerTool({
  name: 'gmail_create_label',
  description: 'Create a new Gmail label (fails if a label with that name already exists). Use "/" for nesting, e.g. "Projects/Invoices".',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string', description: 'Label name' } },
    required: ['name'],
    additionalProperties: false,
  },
  requiresGoogle: true,
  async execute(args, ctx) {
    const auth = await requireAuth(ctx, 'workspace');
    return gmailCreateLabel(auth, str(args.name));
  },
});

registerTool({
  name: 'gmail_modify_labels',
  description: 'Add or remove any Gmail labels on messages or whole threads. System labels: INBOX, UNREAD, STARRED, IMPORTANT, SPAM, TRASH; custom labels by name (e.g. "Projects/Work"). Useful for filing mail, marking it read, or starring it in one call.',
  parameters: {
    type: 'object',
    properties: {
      ...ID_PARAMS,
      addLabels: { type: 'array', items: { type: 'string' }, description: 'Labels to add' },
      removeLabels: { type: 'array', items: { type: 'string' }, description: 'Labels to remove' },
    },
    additionalProperties: false,
  },
  requiresGoogle: true,
  async execute(args, ctx) {
    const auth = await requireAuth(ctx, 'workspace');
    return gmailModifyLabels(auth, {
      ...targetsOf(args),
      add: strArr(args.addLabels) ?? [],
      remove: strArr(args.removeLabels) ?? [],
    });
  },
});

registerLabelOp(
  'gmail_archive_email',
  'archive',
  'Archive email: removes it from the inbox while keeping it searchable under All Mail. The everyday alternative to deleting — reversible with gmail_move_to_inbox. Works on messages (id/ids) or whole conversations (threadId/threadIds).',
);

registerLabelOp(
  'gmail_move_to_inbox',
  'move_to_inbox',
  'Move archived email back to the inbox (adds the INBOX label). Works on messages or whole threads.',
);

registerLabelOp(
  'gmail_mark_read',
  'mark_read',
  'Mark email as read (removes UNREAD). Works on messages or whole threads.',
);

registerLabelOp(
  'gmail_mark_unread',
  'mark_unread',
  'Mark email as unread (adds UNREAD). Works on messages or whole threads.',
);

registerLabelOp(
  'gmail_star_email',
  'star',
  'Star email (adds STARRED). Works on messages or whole threads.',
);

registerLabelOp(
  'gmail_unstar_email',
  'unstar',
  'Remove the star from email (removes STARRED). Works on messages or whole threads.',
);

registerTool({
  name: 'gmail_reply',
  description: 'Reply to an email inside its existing conversation, with correct threading headers. Set replyAll to include everyone on the original message (the user is excluded automatically). Always confirm the reply text with the user before sending.',
  parameters: {
    type: 'object',
    properties: {
      messageId: { type: 'string', description: 'Id of the message being replied to' },
      body: { type: 'string', description: 'Plain-text reply body' },
      replyAll: { type: 'boolean', description: 'Reply to all recipients, not just the sender' },
      cc: { type: 'string', description: 'Extra Cc addresses' },
      bcc: { type: 'string' },
      attachments: ATTACHMENTS_PARAM,
    },
    required: ['messageId', 'body'],
    additionalProperties: false,
  },
  requiresGoogle: true,
  async execute(args, ctx) {
    const auth = await requireAuth(ctx, 'workspace');
    return gmailReply(auth, {
      messageId: str(args.messageId),
      body: str(args.body),
      replyAll: args.replyAll === true,
      cc: str(args.cc) || undefined,
      bcc: str(args.bcc) || undefined,
      attachments: attachmentsOf(args.attachments),
    });
  },
});

registerTool({
  name: 'gmail_forward',
  description: 'Forward an email to a new recipient, quoting the original below an optional note.',
  parameters: {
    type: 'object',
    properties: {
      messageId: { type: 'string', description: 'Id of the message to forward' },
      to: { type: 'string', description: 'Recipient email' },
      note: { type: 'string', description: 'Optional message to write above the forwarded content' },
      cc: { type: 'string' },
      bcc: { type: 'string' },
    },
    required: ['messageId', 'to'],
    additionalProperties: false,
  },
  requiresGoogle: true,
  async execute(args, ctx) {
    const auth = await requireAuth(ctx, 'workspace');
    return gmailForward(auth, {
      messageId: str(args.messageId),
      to: str(args.to),
      note: str(args.note) || undefined,
      cc: str(args.cc) || undefined,
      bcc: str(args.bcc) || undefined,
    });
  },
});

registerTool({
  name: 'gmail_list_drafts',
  description: 'List the drafts in the user\'s Gmail (id, To, subject, snippet). Send one later with gmail_send_draft.',
  parameters: {
    type: 'object',
    properties: { maxResults: { type: 'number', description: 'Default 10, max 50' } },
    additionalProperties: false,
  },
  requiresGoogle: true,
  async execute(args, ctx) {
    const auth = await requireAuth(ctx, 'workspace');
    return gmailListDrafts(auth, { maxResults: num(args.maxResults, 10) });
  },
});

registerTool({
  name: 'gmail_send_draft',
  description: 'Send an existing draft. Confirm with the user before sending.',
  parameters: {
    type: 'object',
    properties: { draftId: { type: 'string', description: 'Draft id from gmail_list_drafts or gmail_create_draft' } },
    required: ['draftId'],
    additionalProperties: false,
  },
  requiresGoogle: true,
  async execute(args, ctx) {
    const auth = await requireAuth(ctx, 'workspace');
    return gmailSendDraft(auth, str(args.draftId));
  },
});

registerTool({
  name: 'gmail_delete_draft',
  description: 'Permanently discard a draft. Confirm with the user first.',
  parameters: {
    type: 'object',
    properties: { draftId: { type: 'string' } },
    required: ['draftId'],
    additionalProperties: false,
  },
  requiresGoogle: true,
  async execute(args, ctx) {
    const auth = await requireAuth(ctx, 'workspace');
    return gmailDeleteDraft(auth, str(args.draftId));
  },
});

registerTool({
  name: 'gmail_get_attachment',
  description: 'Download one attachment from a message. Filenames and attachmentIds come from gmail_get_message (its attachments array). Text files are returned as text; other files as base64 you can pass to drive_upload_file.',
  parameters: {
    type: 'object',
    properties: {
      messageId: { type: 'string' },
      attachmentId: { type: 'string', description: 'From the attachments array of gmail_get_message' },
      filename: { type: 'string', description: 'Optional filename hint' },
    },
    required: ['messageId', 'attachmentId'],
    additionalProperties: false,
  },
  requiresGoogle: true,
  async execute(args, ctx) {
    const auth = await requireAuth(ctx, 'workspace');
    return gmailGetAttachment(auth, {
      messageId: str(args.messageId),
      attachmentId: str(args.attachmentId),
      filename: str(args.filename) || undefined,
    });
  },
});

registerTool({
  name: 'gmail_get_profile',
  description: 'The signed-in Gmail address plus total message and thread counts.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  requiresGoogle: true,
  async execute(_args, ctx) {
    const auth = await requireAuth(ctx, 'workspace');
    return gmailGetProfile(auth);
  },
});

// ── Calendar ────────────────────────────────────────────────────────────

registerTool({
  name: 'calendar_list_events',
  description: 'List events on the user\'s primary Google Calendar in a time range. ISO timestamps (e.g. 2025-06-01T00:00:00Z). Defaults: now → +7 days.',
  parameters: {
    type: 'object',
    properties: {
      timeMin: { type: 'string', description: 'Start ISO timestamp' },
      timeMax: { type: 'string', description: 'End ISO timestamp' },
      maxResults: { type: 'number', description: 'Max events, default 20' },
      query: { type: 'string', description: 'Free-text search over event fields' },
    },
    additionalProperties: false,
  },
  requiresGoogle: true,
  async execute(args, ctx) {
    const auth = await requireAuth(ctx, 'workspace');
    const timeMin = str(args.timeMin) || new Date().toISOString();
    const timeMax = str(args.timeMax) || new Date(Date.now() + 7 * 86400_000).toISOString();
    return calendarListEvents(auth, { timeMin, timeMax, maxResults: num(args.maxResults, 20), query: str(args.query) || undefined });
  },
});

registerTool({
  name: 'calendar_create_event',
  description: 'Create an event on the user\'s primary Google Calendar. Times are ISO strings with offset (e.g. 2025-06-03T10:00:00+02:00).',
  parameters: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'Event title' },
      startISO: { type: 'string', description: 'Start time ISO' },
      endISO: { type: 'string', description: 'End time ISO' },
      description: { type: 'string' },
      location: { type: 'string' },
      timeZone: { type: 'string', description: 'IANA tz, e.g. Europe/Berlin' },
      attendees: { type: 'array', items: { type: 'string' }, description: 'Attendee emails' },
    },
    required: ['summary', 'startISO', 'endISO'],
    additionalProperties: false,
  },
  requiresGoogle: true,
  async execute(args, ctx) {
    const auth = await requireAuth(ctx, 'workspace');
    return calendarCreateEvent(auth, {
      summary: str(args.summary),
      startISO: str(args.startISO),
      endISO: str(args.endISO),
      description: str(args.description) || undefined,
      location: str(args.location) || undefined,
      timeZone: str(args.timeZone) || undefined,
      attendees: strArr(args.attendees),
    });
  },
});

registerTool({
  name: 'calendar_update_event',
  description: 'Update an existing event (summary, times, description, location, attendees). Only provided fields change.',
  parameters: {
    type: 'object',
    properties: {
      eventId: { type: 'string' },
      summary: { type: 'string' },
      startISO: { type: 'string' },
      endISO: { type: 'string' },
      description: { type: 'string' },
      location: { type: 'string' },
      timeZone: { type: 'string' },
      attendees: { type: 'array', items: { type: 'string' } },
    },
    required: ['eventId'],
    additionalProperties: false,
  },
  requiresGoogle: true,
  async execute(args, ctx) {
    const auth = await requireAuth(ctx, 'workspace');
    return calendarUpdateEvent(auth, str(args.eventId), {
      summary: args.summary === undefined ? undefined : str(args.summary),
      startISO: args.startISO === undefined ? undefined : str(args.startISO),
      endISO: args.endISO === undefined ? undefined : str(args.endISO),
      description: args.description === undefined ? undefined : str(args.description),
      location: args.location === undefined ? undefined : str(args.location),
      timeZone: args.timeZone === undefined ? undefined : str(args.timeZone),
      attendees: strArr(args.attendees),
    });
  },
});

registerTool({
  name: 'calendar_delete_event',
  description: 'Delete an event from the user\'s calendar. Confirm with the user before deleting.',
  parameters: {
    type: 'object',
    properties: { eventId: { type: 'string' } },
    required: ['eventId'],
    additionalProperties: false,
  },
  requiresGoogle: true,
  async execute(args, ctx) {
    const auth = await requireAuth(ctx, 'workspace');
    return calendarDeleteEvent(auth, str(args.eventId));
  },
});

registerTool({
  name: 'calendar_find_free_time',
  description: 'Find free time slots on the user\'s calendar over the coming days (e.g. for scheduling meetings).',
  parameters: {
    type: 'object',
    properties: {
      days: { type: 'number', description: 'How many days ahead, default 5, max 14' },
      durationMin: { type: 'number', description: 'Slot duration in minutes, default 60' },
      startHour: { type: 'number', description: 'Working-day start hour, default 9' },
      endHour: { type: 'number', description: 'Working-day end hour, default 17' },
      timeZone: { type: 'string', description: 'IANA timezone, default UTC' },
    },
    additionalProperties: false,
  },
  requiresGoogle: true,
  async execute(args, ctx) {
    const auth = await requireAuth(ctx, 'workspace');
    return calendarFindFreeTime(auth, {
      days: num(args.days, 5),
      durationMin: num(args.durationMin, 60),
      startHour: num(args.startHour, 9),
      endHour: num(args.endHour, 17),
      timeZone: str(args.timeZone) || undefined,
    });
  },
});

// ── Drive ───────────────────────────────────────────────────────────────

registerTool({
  name: 'drive_list_files',
  description: 'List/search the user\'s Google Drive files (the app sees files it created or that were opened with it, plus any others the account can access). Use Drive query syntax: name contains \'report\', mimeType=\'application/vnd.google-apps.document\'.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Drive query string' },
      maxResults: { type: 'number', description: 'Default 20, max 100' },
    },
    additionalProperties: false,
  },
  requiresGoogle: true,
  async execute(args, ctx) {
    const auth = await requireAuth(ctx, 'workspace');
    return driveListFiles(auth, { query: str(args.query) || undefined, maxResults: num(args.maxResults, 20) });
  },
});

registerTool({
  name: 'drive_create_doc',
  description: 'Create a native Google Doc in the user\'s Drive. Content is Markdown: # headings, **bold**, *italic*, `inline code`, [links](https://…), - bullets, 1. numbered lists, > blockquotes, ``` fenced code blocks and --- rules. Returns the file id and link.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Document title' },
      content: { type: 'string', description: 'Markdown content' },
      parentFolderId: { type: 'string', description: 'Optional Drive folder id to save the doc into' },
    },
    required: ['name', 'content'],
    additionalProperties: false,
  },
  requiresGoogle: true,
  async execute(args, ctx) {
    const auth = await requireAuth(ctx, 'workspace');
    return driveCreateDoc(auth, {
      name: str(args.name),
      content: str(args.content),
      parentFolderId: str(args.parentFolderId) || undefined,
    });
  },
});

registerTool({
  name: 'drive_append_doc',
  description: 'Append Markdown content to the end of an existing Google Doc (same Markdown syntax as drive_create_doc).',
  parameters: {
    type: 'object',
    properties: {
      fileId: { type: 'string', description: 'Id of the Google Doc to append to' },
      content: { type: 'string', description: 'Markdown content to append' },
    },
    required: ['fileId', 'content'],
    additionalProperties: false,
  },
  requiresGoogle: true,
  async execute(args, ctx) {
    const auth = await requireAuth(ctx, 'workspace');
    return driveAppendDoc(auth, { fileId: str(args.fileId), content: str(args.content) });
  },
});

registerTool({
  name: 'drive_create_sheet',
  description: 'Create a Google Sheet in the user\'s Drive from CSV content or a rows array (provide exactly one of csv/rows). Returns the file id and link.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      csv: { type: 'string', description: 'CSV content (rows separated by newlines, cells by commas)' },
      rows: { type: 'array', items: { type: 'array', items: { type: ['string', 'number'] } }, description: 'Rows as a 2D array, e.g. [["Name","Age"],["Ada",36]] — alternative to csv' },
      parentFolderId: { type: 'string', description: 'Optional Drive folder id to save the sheet into' },
    },
    required: ['name'],
    additionalProperties: false,
  },
  requiresGoogle: true,
  async execute(args, ctx) {
    const auth = await requireAuth(ctx, 'workspace');
    const rows: unknown[][] | undefined = Array.isArray(args.rows)
      ? args.rows.map((r) => (Array.isArray(r) ? r : [r]))
      : undefined;
    return driveCreateSheet(auth, {
      name: str(args.name),
      csv: str(args.csv) || undefined,
      rows,
      parentFolderId: str(args.parentFolderId) || undefined,
    });
  },
});

registerTool({
  name: 'drive_read_sheet',
  description: 'Read a Google Sheet as rows (2D array of string values). Optionally restrict to a range like "Sheet1!A1:D20".',
  parameters: {
    type: 'object',
    properties: {
      fileId: { type: 'string', description: 'Id of the Google Sheet' },
      range: { type: 'string', description: 'A1-style range, e.g. "Sheet1!A1:D20"' },
    },
    required: ['fileId'],
    additionalProperties: false,
  },
  requiresGoogle: true,
  async execute(args, ctx) {
    const auth = await requireAuth(ctx, 'workspace');
    return driveReadSheet(auth, { fileId: str(args.fileId), range: str(args.range) || undefined });
  },
});

registerTool({
  name: 'drive_upload_file',
  description: 'Upload a file to Google Drive. contentBase64 is the base64-encoded file content. Use for files up to a few MB.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'File name including extension' },
      mimeType: { type: 'string', description: 'MIME type, e.g. image/png, application/pdf' },
      contentBase64: { type: 'string' },
      parentFolderId: { type: 'string' },
    },
    required: ['name', 'mimeType', 'contentBase64'],
    additionalProperties: false,
  },
  requiresGoogle: true,
  async execute(args, ctx) {
    const auth = await requireAuth(ctx, 'workspace');
    return driveUploadFile(auth, {
      name: str(args.name),
      mimeType: str(args.mimeType),
      contentBase64: str(args.contentBase64),
      parentFolderId: str(args.parentFolderId) || undefined,
    });
  },
});

registerTool({
  name: 'drive_get_file_content',
  description: 'Read the content of a Drive file. Google Docs/Sheets are exported as text/CSV; binary files return base64.',
  parameters: {
    type: 'object',
    properties: { fileId: { type: 'string' } },
    required: ['fileId'],
    additionalProperties: false,
  },
  requiresGoogle: true,
  async execute(args, ctx) {
    const auth = await requireAuth(ctx, 'workspace');
    return driveGetFileContent(auth, { fileId: str(args.fileId) });
  },
});

registerTool({
  name: 'drive_share_file',
  description: 'Share a Drive file with an email address (reader/commenter/writer).',
  parameters: {
    type: 'object',
    properties: {
      fileId: { type: 'string' },
      email: { type: 'string' },
      role: { type: 'string', enum: ['reader', 'commenter', 'writer'] },
    },
    required: ['fileId', 'email'],
    additionalProperties: false,
  },
  requiresGoogle: true,
  async execute(args, ctx) {
    const auth = await requireAuth(ctx, 'workspace');
    const roleRaw = str(args.role, 'writer');
    const role = roleRaw === 'reader' || roleRaw === 'commenter' ? roleRaw : 'writer';
    return driveShareFile(auth, { fileId: str(args.fileId), email: str(args.email), role });
  },
});

// ── YouTube ─────────────────────────────────────────────────────────────

registerTool({
  name: 'youtube_search_videos',
  description: 'Search YouTube for videos matching a query. Returns id, title, channel, published date, view/like counts, thumbnail and URL.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      maxResults: { type: 'number', description: 'Default 5, max 25' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  requiresGoogle: true,
  async execute(args, ctx) {
    const auth = await requireAuth(ctx, 'youtube');
    return youtubeSearchVideos(auth, { query: str(args.query), maxResults: num(args.maxResults, 5) });
  },
});

registerTool({
  name: 'youtube_get_video',
  description: 'Get details and statistics for a YouTube video by id.',
  parameters: {
    type: 'object',
    properties: { videoId: { type: 'string' } },
    required: ['videoId'],
    additionalProperties: false,
  },
  requiresGoogle: true,
  async execute(args, ctx) {
    const auth = await requireAuth(ctx, 'youtube');
    return youtubeGetVideo(auth, str(args.videoId));
  },
});

registerTool({
  name: 'youtube_list_my_videos',
  description: 'List the videos on the user\'s own YouTube channel.',
  parameters: {
    type: 'object',
    properties: { maxResults: { type: 'number', description: 'Default 10, max 50' } },
    additionalProperties: false,
  },
  requiresGoogle: true,
  async execute(args, ctx) {
    const auth = await requireAuth(ctx, 'youtube');
    return youtubeListMyVideos(auth, { maxResults: num(args.maxResults, 10) });
  },
});

registerTool({
  name: 'youtube_upload_video',
  description: 'Upload a video to the user\'s YouTube channel. Video bytes come from a Drive file id (needs the Drive group connected) or base64 content. Defaults to private; confirm with the user before making public.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      description: { type: 'string' },
      driveFileId: { type: 'string', description: 'Drive file id containing the video' },
      contentBase64: { type: 'string', description: 'Base64 video content (alternative to driveFileId)' },
      mimeType: { type: 'string', description: 'Default video/mp4' },
      tags: { type: 'array', items: { type: 'string' } },
      privacyStatus: { type: 'string', enum: ['private', 'unlisted', 'public'] },
    },
    required: ['title'],
    additionalProperties: false,
  },
  requiresGoogle: true,
  async execute(args, ctx) {
    const auth = await requireAuth(ctx, 'youtube');
    const privacyRaw = str(args.privacyStatus, 'private');
    const privacyStatus = privacyRaw === 'public' || privacyRaw === 'unlisted' ? privacyRaw : 'private';
    return youtubeUploadVideo(auth, {
      title: str(args.title),
      description: str(args.description) || undefined,
      driveFileId: str(args.driveFileId) || undefined,
      contentBase64: str(args.contentBase64) || undefined,
      mimeType: str(args.mimeType) || undefined,
      tags: strArr(args.tags),
      privacyStatus,
    }, ctx.googleAuth.workspace);
  },
});
