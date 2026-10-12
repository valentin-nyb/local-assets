import ical from 'node-ical';

// Each venue's own calendar of sets (an iCal link from Google Calendar or Apple Calendar),
// saved from the Camera page. Every event is one set: the title is the artist,
// start and end are the exact minutes the recording is cut at.

export const calendarKey = slug => `calendar_url:${slug}`;

// Accepts webcal:// and https:// iCal links; returns the https URL or null
export function cleanCalendarUrl(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  if (/^webcal:\/\//i.test(s)) s = 'https://' + s.slice(9);
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:') return null;
    return u.toString();
  } catch { return null; }
}

// "DJ Tennis @ Fold" or "DJ Tennis - Main room" → "DJ TENNIS"
export function artistFromTitle(title) {
  return String(title || '').split(/\s+(?:@|–|—|-|\|)\s+/)[0].replace(/[<>]/g, '').trim().toUpperCase().slice(0, 60);
}

// Events overlapping [fromMs, toMs], sorted by start, as { artist, title, start, end } (ms)
export async function venueEvents(redis, slug, fromMs, toMs) {
  const url = await redis.get(calendarKey(slug));
  if (!url) return [];
  return fetchEvents(url, fromMs, toMs);
}

// Downloads and parses the calendar; throws when the link isn't a calendar
export async function readCalendar(url) {
  const r = await fetch(url, { headers: { Accept: 'text/calendar, */*' }, cache: 'no-store', signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`Calendar link answered ${r.status}`);
  const text = await r.text();
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('The link is a web page, not an iCal calendar');
  return ical.sync.parseICS(text);
}

// SUMMARY;LANGUAGE=en:… arrives as { params, val }
const textOf = v => (v && typeof v === 'object' ? v.val : v) || '';

export function eventsBetween(data, fromMs, toMs) {
  const out = [];
  const from = new Date(fromMs), to = new Date(toMs);
  for (const ev of Object.values(data)) {
    if (!ev || ev.type !== 'VEVENT' || !ev.start || ev.status === 'CANCELLED') continue;
    const artist = artistFromTitle(textOf(ev.summary));
    if (!artist) continue;
    // Each occurrence in the window: repeating events, moved and removed dates included
    let list;
    try { list = ical.expandRecurringEvent(ev, { from, to, expandOngoing: true }); }
    catch { continue; }
    for (const it of list) {
      const start = new Date(it.start).getTime();
      let end = it.end ? new Date(it.end).getTime() : start + 3600e3;
      if (!(end > start)) end = start + 3600e3;
      if (end <= fromMs || start >= toMs) continue;
      out.push({ artist: artistFromTitle(textOf(it.summary)) || artist, title: String(textOf(it.summary)), start, end, allDay: !!it.isFullDay });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

export async function fetchEvents(url, fromMs, toMs) {
  return eventsBetween(await readCalendar(url), fromMs, toMs);
}
