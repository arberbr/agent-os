import { Readable } from 'node:stream';
import { google } from 'googleapis';
import type { Auth, drive_v3, docs_v1 } from 'googleapis';
import { googleErrorMessage } from './auth.js';
import { store } from '../store.js';

// ── Google Drive ────────────────────────────────────────────────────────

export interface DriveFileItem {
  id: string;
  name: string;
  mimeType: string;
  size: string;
  createdTime: string;
  modifiedTime: string;
  webViewLink: string;
}

function simplifyFile(f: drive_v3.Schema$File): DriveFileItem {
  return {
    id: f.id ?? '',
    name: f.name ?? '',
    mimeType: f.mimeType ?? '',
    size: f.size ?? '',
    createdTime: f.createdTime ?? '',
    modifiedTime: f.modifiedTime ?? '',
    webViewLink: f.webViewLink ?? '',
  };
}

/** List/search files. `query` uses Drive query syntax (name contains '...', mimeType='...'). */
export async function driveListFiles(auth: Auth.OAuth2Client, args: { query?: string; maxResults?: number }): Promise<DriveFileItem[]> {
  try {
    const res = await google.drive({ version: 'v3', auth }).files.list({
      q: args.query || undefined,
      pageSize: Math.min(args.maxResults ?? 20, 100),
      fields: 'files(id,name,mimeType,size,createdTime,modifiedTime,webViewLink)',
      orderBy: 'modifiedTime desc',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    return (res.data.files ?? []).map(simplifyFile);
  } catch (err) {
    throw new Error(googleErrorMessage(err));
  }
}

// ── Markdown → formatted Google Doc (Docs API batchUpdate) ──────────────

const DOCS_SCOPE = 'https://www.googleapis.com/auth/documents';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

/** Whether the connected workspace token carries a given OAuth scope. */
function workspaceHasScope(scope: string): boolean {
  return (store.getGoogleToken('workspace')?.scopes ?? []).includes(scope);
}

const MAX_DOC_CHARS = 100_000;

const BULLET_LIST_ID = 'kix.agentsos-bullets';
const NUMBERED_LIST_ID = 'kix.agentsos-numbers';

interface InlineSegment {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  link?: string;
}

const INLINE_RE = /(\*\*[^*]+\*\*)|(\*[^*]+\*)|(`[^`]+`)|(\[[^\]]+\]\([^)]*\))/g;

/** Split one markdown line into styled inline segments (bold/italic/code/links). */
function parseInline(line: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let last = 0;
  for (const m of line.matchAll(INLINE_RE)) {
    if (m.index > last) segments.push({ text: line.slice(last, m.index) });
    const token = m[0];
    if (m[1]) segments.push({ text: token.slice(2, -2), bold: true });
    else if (m[2]) segments.push({ text: token.slice(1, -1), italic: true });
    else if (m[3]) segments.push({ text: token.slice(1, -1), code: true });
    else if (m[4]) {
      const link = /^\[([^\]]+)\]\(([^)]*)\)$/.exec(token);
      segments.push({ text: link?.[1] ?? token, link: link?.[2] || undefined });
    }
    last = (m.index ?? 0) + token.length;
  }
  if (last < line.length) segments.push({ text: line.slice(last) });
  return segments;
}

const GRAY = { rgbColor: { red: 0.85, green: 0.85, blue: 0.85 } };
const CODE_BG = { rgbColor: { red: 0.96, green: 0.96, blue: 0.96 } };

function makeCodeTextStyle(): docs_v1.Schema$TextStyle {
  return {
    weightedFontFamily: { fontFamily: 'Consolas', weight: 400 },
    backgroundColor: { color: CODE_BG },
  };
}

function codeParagraphStyle(): docs_v1.Schema$ParagraphStyle {
  return {
    namedStyleType: 'NORMAL_TEXT',
    shading: { backgroundColor: { color: CODE_BG } },
  };
}

/**
 * Turn markdown content into Docs API batchUpdate requests, inserting at
 * `startIndex`. Supports headings, bold/italic/inline code, links, bullet and
 * numbered lists, blockquotes, fenced code blocks, and `---` rules.
 */
export function buildMarkdownRequests(content: string, startIndex: number): docs_v1.Schema$Request[] {
  if (content.length > MAX_DOC_CHARS) {
    throw new Error(`Document content too long (${content.length} chars, max ${MAX_DOC_CHARS}).`);
  }
  const requests: docs_v1.Schema$Request[] = [];
  let cursor = startIndex;
  let inCodeFence = false;

  const insertSegments = (segments: InlineSegment[]): void => {
    for (const seg of segments) {
      if (!seg.text) continue;
      requests.push({ insertText: { location: { index: cursor }, text: seg.text } });
      const style: docs_v1.Schema$TextStyle = {};
      if (seg.bold) style.bold = true;
      if (seg.italic) style.italic = true;
      if (seg.link) style.link = { url: seg.link };
      if (seg.code) Object.assign(style, makeCodeTextStyle());
      if (Object.keys(style).length > 0) {
        requests.push({
          updateTextStyle: {
            range: { startIndex: cursor, endIndex: cursor + seg.text.length },
            textStyle: style,
            fields: '*',
          },
        });
      }
      cursor += seg.text.length;
    }
    // Paragraph terminator.
    requests.push({ insertText: { location: { index: cursor }, text: '\n' } });
    cursor += 1;
  };

  for (const raw of content.split(/\r?\n/)) {
    if (/^\s*```/.test(raw)) {
      inCodeFence = !inCodeFence;
      continue;
    }

    const blockStart = cursor;
    let kind: 'heading' | 'bullet' | 'numbered' | 'quote' | 'code' | 'hr' | 'normal' = 'normal';
    let headingLevel = 1;

    const heading = /^(#{1,6})\s+(.+)$/.exec(raw);
    const bullet = /^\s*[-*+]\s+(.+)$/.exec(raw);
    const numbered = /^\s*\d+[.)]\s+(.+)$/.exec(raw);
    const quote = /^\s*>\s?(.*)$/.exec(raw);
    const isHr = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(raw);

    let text: string;
    if (inCodeFence) {
      kind = 'code';
      text = raw;
    } else if (heading) {
      kind = 'heading';
      headingLevel = Math.min(heading[1]?.length ?? 1, 6);
      text = heading[2] ?? raw;
    } else if (isHr) {
      kind = 'hr';
      text = '';
    } else if (bullet) {
      kind = 'bullet';
      text = bullet[1] ?? raw;
    } else if (numbered) {
      kind = 'numbered';
      text = numbered[1] ?? raw;
    } else if (quote) {
      kind = 'quote';
      text = quote[1] ?? '';
    } else {
      text = raw;
    }

    if (!text && kind !== 'hr') {
      if (raw.trim() === '') continue; // blank line: no paragraph
    }

    if (kind === 'code') {
      requests.push({ insertText: { location: { index: cursor }, text } });
      requests.push({
        updateTextStyle: {
          range: { startIndex: cursor, endIndex: cursor + text.length },
          textStyle: makeCodeTextStyle(),
          fields: '*',
        },
      });
      cursor += text.length;
      requests.push({ insertText: { location: { index: cursor }, text: '\n' } });
      cursor += 1;
    } else {
      insertSegments(parseInline(text));
    }

    const paragraphStyle: docs_v1.Schema$ParagraphStyle = (() => {
      switch (kind) {
        case 'heading':
          return { namedStyleType: `HEADING_${headingLevel}` };
        case 'bullet':
          return {
            namedStyleType: 'NORMAL_TEXT',
            bullet: { listId: BULLET_LIST_ID, nestingLevel: 0, glyphPresetId: 'BULLET_DISC_CIRCLE_SQUARE' },
          };
        case 'numbered':
          return {
            namedStyleType: 'NORMAL_TEXT',
            bullet: { listId: NUMBERED_LIST_ID, nestingLevel: 0, glyphPresetId: 'NUMBERED_DECIMAL_ALPHA_ROMAN' },
          };
        case 'quote':
          return {
            namedStyleType: 'NORMAL_TEXT',
            indentStart: { magnitude: 36, unit: 'PT' },
            borderLeft: { dashStyle: 'SOLID', width: { magnitude: 1.5, unit: 'PT' }, color: { color: GRAY } },
          };
        case 'code':
          return codeParagraphStyle();
        case 'hr':
          return {
            namedStyleType: 'NORMAL_TEXT',
            borderBottom: { dashStyle: 'SOLID', width: { magnitude: 1, unit: 'PT' }, color: { color: GRAY } },
          };
        default:
          return { namedStyleType: 'NORMAL_TEXT' };
      }
    })();

    requests.push({
      updateParagraphStyle: {
        range: { startIndex: blockStart, endIndex: cursor },
        paragraphStyle,
        fields: '*',
      },
    });
  }

  return requests;
}

/**
 * Create a native Google Doc. Content is Markdown: headings, bold/italic,
 * inline code, links, bullet/numbered lists, blockquotes, code fences, rules.
 * When the connected grant lacks the `documents` scope (connected before it
 * was added), it falls back to an unformatted plain-text doc with a note.
 */
export async function driveCreateDoc(
  auth: Auth.OAuth2Client,
  args: { name: string; content: string; parentFolderId?: string },
): Promise<DriveFileItem & { note?: string }> {
  try {
    const parents = args.parentFolderId ? [args.parentFolderId] : undefined;

    if (!workspaceHasScope(DOCS_SCOPE)) {
      const res = await google.drive({ version: 'v3', auth }).files.create({
        requestBody: { name: args.name, mimeType: 'application/vnd.google-apps.document', parents },
        media: { mimeType: 'text/plain', body: args.content },
        fields: 'id,name,mimeType,size,createdTime,modifiedTime,webViewLink',
      });
      return {
        ...simplifyFile(res.data),
        note: 'Saved as plain text (no formatting) because the current Google grant lacks the documents scope. Reconnect the Gmail/Calendar/Drive group on the Integrations page to unlock Markdown formatting.',
      };
    }

    const created = await google.drive({ version: 'v3', auth }).files.create({
      requestBody: { name: args.name, mimeType: 'application/vnd.google-apps.document', parents },
      fields: 'id,name,mimeType,size,createdTime,modifiedTime,webViewLink',
    });
    const fileId = created.data.id;
    if (fileId) {
      await google.docs({ version: 'v1', auth }).documents.batchUpdate({
        documentId: fileId,
        requestBody: { requests: buildMarkdownRequests(args.content, 1) },
      });
    }
    return simplifyFile(created.data);
  } catch (err) {
    throw new Error(googleErrorMessage(err));
  }
}

/** Append Markdown content to the end of an existing Google Doc. */
export async function driveAppendDoc(
  auth: Auth.OAuth2Client,
  args: { fileId: string; content: string },
): Promise<{ appended: boolean; chars: number; documentId: string }> {
  try {
    if (!workspaceHasScope(DOCS_SCOPE)) {
      throw new Error('Appending formatted content needs the documents scope, which your current Google grant does not include. Reconnect the Gmail/Calendar/Drive group on the Integrations page, then retry.');
    }
    const meta = await google.docs({ version: 'v1', auth }).documents.get({
      documentId: args.fileId,
      fields: 'body',
    });
    const blocks = meta.data.body?.content ?? [];
    const endIndex = blocks.length > 0 ? (blocks[blocks.length - 1]?.endIndex ?? 1) : 1;
    await google.docs({ version: 'v1', auth }).documents.batchUpdate({
      documentId: args.fileId,
      requestBody: { requests: buildMarkdownRequests(args.content, endIndex) },
    });
    return { appended: true, chars: args.content.length, documentId: args.fileId };
  } catch (err) {
    throw new Error(googleErrorMessage(err));
  }
}

// ── Sheets ──────────────────────────────────────────────────────────────

/** Quote CSV cells that contain commas, quotes or newlines. */
function rowsToCsv(rows: unknown[][]): string {
  const cell = (v: unknown): string => {
    const s = v == null ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\r\n');
}

/** Minimal CSV parser (handles quoted fields and escaped quotes). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (inQuotes) {
      if (ch === '"') {
        if (text.charAt(i + 1) === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cur);
      cur = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text.charAt(i + 1) === '\n') i++;
      row.push(cur);
      cur = '';
      rows.push(row);
      row = [];
    } else {
      cur += ch;
    }
  }
  if (cur !== '' || row.length > 0) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

/** Create a Google Sheet from CSV text or a rows array. */
export async function driveCreateSheet(
  auth: Auth.OAuth2Client,
  args: { name: string; csv?: string; rows?: unknown[][]; parentFolderId?: string },
): Promise<DriveFileItem> {
  try {
    const csv = args.rows && args.rows.length > 0 ? rowsToCsv(args.rows) : (args.csv ?? '');
    const res = await google.drive({ version: 'v3', auth }).files.create({
      requestBody: {
        name: args.name,
        mimeType: 'application/vnd.google-apps.spreadsheet',
        ...(args.parentFolderId ? { parents: [args.parentFolderId] } : {}),
      },
      media: { mimeType: 'text/csv', body: csv },
      fields: 'id,name,mimeType,size,createdTime,modifiedTime,webViewLink',
    });
    return simplifyFile(res.data);
  } catch (err) {
    throw new Error(googleErrorMessage(err));
  }
}

/**
 * Read a Google Sheet as rows. Uses the Sheets API when the grant includes the
 * `spreadsheets` scope, otherwise falls back to a CSV export via the Drive API
 * (full sheet only — `range` is ignored in that case).
 */
export async function driveReadSheet(
  auth: Auth.OAuth2Client,
  args: { fileId: string; range?: string },
): Promise<{ range: string; rows: string[][] }> {
  try {
    if (workspaceHasScope(SHEETS_SCOPE)) {
      const res = await google.sheets({ version: 'v4', auth }).spreadsheets.values.get({
        spreadsheetId: args.fileId,
        range: args.range || undefined,
      });
      return { range: res.data.range ?? '', rows: res.data.values ?? [] };
    }
    const res = await google.drive({ version: 'v3', auth }).files.export({
      fileId: args.fileId,
      mimeType: 'text/csv',
    });
    const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    return { range: 'full sheet (CSV fallback)', rows: parseCsv(text) };
  } catch (err) {
    throw new Error(googleErrorMessage(err));
  }
}

/** Upload an arbitrary file to Drive. `contentBase64` is the base64-encoded file content. */
export async function driveUploadFile(
  auth: Auth.OAuth2Client,
  args: { name: string; mimeType: string; contentBase64: string; parentFolderId?: string },
): Promise<DriveFileItem> {
  try {
    const buffer = Buffer.from(args.contentBase64, 'base64');
    const res = await google.drive({ version: 'v3', auth }).files.create({
      requestBody: {
        name: args.name,
        ...(args.parentFolderId ? { parents: [args.parentFolderId] } : {}),
      },
      media: { mimeType: args.mimeType || 'application/octet-stream', body: Readable.from(buffer) },
      fields: 'id,name,mimeType,size,createdTime,modifiedTime,webViewLink',
    });
    return simplifyFile(res.data);
  } catch (err) {
    throw new Error(googleErrorMessage(err));
  }
}

/** Read file content. Google Docs/Sheets are exported as text/csv; binary files come back as base64. */
export async function driveGetFileContent(
  auth: Auth.OAuth2Client,
  args: { fileId: string },
): Promise<{ mimeType: string; text?: string; contentBase64?: string; size: number }> {
  try {
    const meta = await google.drive({ version: 'v3', auth }).files.get({
      fileId: args.fileId,
      fields: 'mimeType,name,size',
    });
    const mimeType = meta.data.mimeType ?? '';

    if (mimeType === 'application/vnd.google-apps.document') {
      const res = await google.drive({ version: 'v3', auth }).files.export({ fileId: args.fileId, mimeType: 'text/plain' });
      const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      return { mimeType, text: text.slice(0, 30000), size: text.length };
    }
    if (mimeType === 'application/vnd.google-apps.spreadsheet') {
      const res = await google.drive({ version: 'v3', auth }).files.export({ fileId: args.fileId, mimeType: 'text/csv' });
      const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      return { mimeType, text: text.slice(0, 30000), size: text.length };
    }

    const res = await google.drive({ version: 'v3', auth }).files.get({ fileId: args.fileId, alt: 'media' }, { responseType: 'arraybuffer' });
    const buf = Buffer.from(res.data as ArrayBuffer);
    return { mimeType, contentBase64: buf.toString('base64'), size: buf.length };
  } catch (err) {
    throw new Error(googleErrorMessage(err));
  }
}

/** Share a file with an email address (writer role by default). */
export async function driveShareFile(
  auth: Auth.OAuth2Client,
  args: { fileId: string; email: string; role?: 'reader' | 'writer' | 'commenter' },
): Promise<{ shared: boolean; link: string }> {
  try {
    await google.drive({ version: 'v3', auth }).permissions.create({
      fileId: args.fileId,
      requestBody: { type: 'user', emailAddress: args.email, role: args.role ?? 'writer' },
      sendNotificationEmail: true,
    });
    const meta = await google.drive({ version: 'v3', auth }).files.get({ fileId: args.fileId, fields: 'webViewLink' });
    return { shared: true, link: meta.data.webViewLink ?? '' };
  } catch (err) {
    throw new Error(googleErrorMessage(err));
  }
}
