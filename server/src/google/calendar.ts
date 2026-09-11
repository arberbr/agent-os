import { google } from 'googleapis';
import type { Auth, calendar_v3 } from 'googleapis';
import { googleErrorMessage } from './auth.js';

// ── Google Calendar ─────────────────────────────────────────────────────

export interface CalendarEvent {
  id: string;
  summary: string;
  description: string;
  location: string;
  start: string; // ISO
  end: string; // ISO
  timeZone: string;
  attendees: Array<{ email: string; responseStatus?: string }>;
  organizer: string;
  link: string;
}

function simplifyEvent(e: calendar_v3.Schema$Event): CalendarEvent {
  const startRaw = e.start?.dateTime ?? (e.start?.date ? `${e.start.date}T00:00:00` : '');
  const endRaw = e.end?.dateTime ?? (e.end?.date ? `${e.end.date}T23:59:59` : '');
  return {
    id: e.id ?? '',
    summary: e.summary ?? '(no title)',
    description: e.description ?? '',
    location: e.location ?? '',
    start: startRaw,
    end: endRaw,
    timeZone: e.start?.timeZone ?? 'UTC',
    attendees: (e.attendees ?? [])
      .filter((a): a is calendar_v3.Schema$EventAttendee => Boolean(a?.email))
      .map((a) => ({ email: a.email as string, responseStatus: a.responseStatus ?? undefined })),
    organizer: e.organizer?.email ?? '',
    link: e.htmlLink ?? '',
  };
}

export async function calendarListEvents(
  auth: Auth.OAuth2Client,
  args: { timeMin?: string; timeMax?: string; maxResults?: number; query?: string; timeZone?: string },
): Promise<CalendarEvent[]> {
  try {
    const res = await google.calendar({ version: 'v3', auth }).events.list({
      calendarId: 'primary',
      timeMin: args.timeMin ?? new Date().toISOString(),
      timeMax: args.timeMax,
      maxResults: Math.min(args.maxResults ?? 20, 100),
      singleEvents: true,
      orderBy: 'startTime',
      q: args.query || undefined,
      timeZone: args.timeZone,
    });
    return (res.data.items ?? []).map(simplifyEvent);
  } catch (err) {
    throw new Error(googleErrorMessage(err));
  }
}

export interface CreateEventInput {
  summary: string;
  startISO: string;
  endISO: string;
  description?: string;
  location?: string;
  timeZone?: string;
  attendees?: string[];
}

export async function calendarCreateEvent(auth: Auth.OAuth2Client, args: CreateEventInput): Promise<CalendarEvent> {
  try {
    const res = await google.calendar({ version: 'v3', auth }).events.insert({
      calendarId: 'primary',
      requestBody: {
        summary: args.summary,
        description: args.description,
        location: args.location,
        start: { dateTime: args.startISO, timeZone: args.timeZone },
        end: { dateTime: args.endISO, timeZone: args.timeZone },
        attendees: args.attendees?.map((email) => ({ email })),
      },
    });
    return simplifyEvent(res.data);
  } catch (err) {
    throw new Error(googleErrorMessage(err));
  }
}

export async function calendarUpdateEvent(
  auth: Auth.OAuth2Client,
  eventId: string,
  patch: Partial<CreateEventInput>,
): Promise<CalendarEvent> {
  try {
    const res = await google.calendar({ version: 'v3', auth }).events.patch({
      calendarId: 'primary',
      eventId,
      requestBody: {
        ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.location !== undefined ? { location: patch.location } : {}),
        ...(patch.startISO !== undefined ? { start: { dateTime: patch.startISO, timeZone: patch.timeZone } } : {}),
        ...(patch.endISO !== undefined ? { end: { dateTime: patch.endISO, timeZone: patch.timeZone } } : {}),
        ...(patch.attendees ? { attendees: patch.attendees.map((email) => ({ email })) } : {}),
      },
    });
    return simplifyEvent(res.data);
  } catch (err) {
    throw new Error(googleErrorMessage(err));
  }
}

export async function calendarDeleteEvent(auth: Auth.OAuth2Client, eventId: string): Promise<{ deleted: boolean }> {
  try {
    await google.calendar({ version: 'v3', auth }).events.delete({ calendarId: 'primary', eventId });
    return { deleted: true };
  } catch (err) {
    throw new Error(googleErrorMessage(err));
  }
}

/**
 * Find free time slots on the primary calendar in the coming days.
 * Uses freebusy.query against the primary calendar.
 */
export async function calendarFindFreeTime(
  auth: Auth.OAuth2Client,
  args: { days?: number; durationMin?: number; startHour?: number; endHour?: number; timeZone?: string },
): Promise<{ slots: Array<{ start: string; end: string }>; timeZone: string }> {
  try {
    const days = Math.min(args.days ?? 5, 14);
    const durationMin = Math.max(args.durationMin ?? 60, 15);
    const startHour = args.startHour ?? 9;
    const endHour = Math.min(args.endHour ?? 17, 23);
    const tz = args.timeZone ?? 'UTC';

    // Calendar API takes dateTime ranges in UTC; express day windows in local tz via offset.
    const now = new Date();
    const dayStart = (offsetDays: number, hour: number): Date => {
      // Build a UTC instant for "today+offsetDays at hour:00 in tz" using the Intl trick.
      const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      });
      const parts = fmt.formatToParts(new Date(now.getTime() + offsetDays * 86400_000));
      const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '0';
      const y = Number(get('year'));
      const mo = Number(get('month')) - 1;
      const d = Number(get('day'));
      return new Date(Date.UTC(y, mo, d, hour, 0, 0));
    };

    const timeMin = dayStart(0, startHour).toISOString();
    const timeMax = dayStart(days, endHour).toISOString();

    const busyRes = await google.calendar({ version: 'v3', auth }).freebusy.query({
      requestBody: {
        timeMin,
        timeMax,
        items: [{ id: 'primary' }],
      },
    });
    const busy = busyRes.data.calendars?.['primary']?.busy ?? [];
    const sorted = busy
      .map((b) => ({ start: new Date(b.start ?? timeMin).getTime(), end: new Date(b.end ?? timeMin).getTime() }))
      .filter((b) => !Number.isNaN(b.start) && !Number.isNaN(b.end))
      .sort((a, b) => a.start - b.start);

    const slots: Array<{ start: string; end: string }> = [];
    const step = 15 * 60_000;
    const dur = durationMin * 60_000;
    for (let d = 0; d < days; d++) {
      let cursor = dayStart(d, startHour).getTime();
      const dayEnd = dayStart(d, endHour).getTime();
      while (cursor + dur <= dayEnd) {
        const slotEnd = cursor + dur;
        const overlaps = sorted.some((b) => cursor < b.end && slotEnd > b.start);
        if (!overlaps) {
          slots.push({ start: new Date(cursor).toISOString(), end: new Date(slotEnd).toISOString() });
          cursor = slotEnd;
        } else {
          cursor += step;
        }
      }
    }
    return { slots: slots.slice(0, 20), timeZone: tz };
  } catch (err) {
    throw new Error(googleErrorMessage(err));
  }
}
