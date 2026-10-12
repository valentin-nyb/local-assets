import ical from 'node-ical';

// Each venue's own calendar of sets (an iCal link from Google Calendar or Apple Calendar),
// saved from the Camera page. Every event is one set: the title is the artist,
// start and end are the exact minutes the recording is cut at.

export const calendarKey = slug => `calendar_url:${slug}`;

// Google Calendar share/embed links (…?cid=… or …/embed?src=…) → the calendar's iCal address
function googleIcal(u) {
  if (u.hostname !== 'calendar.google.com' || /\.ics$/i.test(u.pathname)) return null;
  let id = u.searchParams.get('src');
  const cid = u.searchParams.get('cid');
  if (!id && cid) {
    try { const d = Buffer.from(cid.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); id = /^[\w.+-]+@[\w.-]+$/.test(d) ? d : cid; } catch { id = cid; }
  }
  if (!id || !/@/.test(id)) return null;
  return `https://calendar.google.com/calendar/ical/${encodeURIComponent(id)}/public/basic.ics`;
}

// Accepts webcal:// and https:// iCal links; returns the https URL or null
export function cleanCalendarUrl(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  if (/^webcal:\/\//i.test(s)) s = 'https://' + s.slice(9);
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:') return null;
    return googleIcal(u) || u.toString();
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
  url = cleanCalendarUrl(url) || url;   // links saved before Google share links were converted
  const r = await fetch(url, { headers: { Accept: 'text/calendar, text/plain;q=0.9, */*;q=0.8', 'User-Agent': 'Mozilla/5.0 (compatible; local-assets-calendar/1.0; +https://local-assets.com)' }, redirect: 'follow', cache: 'no-store', signal: AbortSignal.timeout(15000) });
  if (!r.ok) {
    if (/calendar\.google\.com/.test(url) && (r.status === 404 || r.status === 403))
      throw new Error('Google Calendar won\'t share this calendar from that link (it isn\'t public). In Google Calendar open Settings, choose the calendar, and copy "Secret address in iCal format".');
    throw new Error(`The calendar link answered ${r.status}. Check the link is still shared.`);
  }
  const text = await r.text();
  if (!/BEGIN:VCALENDAR/i.test(text)) {
    // What came back instead, without the secret parts of the link
    const shape = u => { try { const x = new URL(u); return x.hostname + x.pathname.replace(/[^/]{12,}/g, '…') + (x.search ? ' ?' + [...x.searchParams.keys()].join('&') : ''); } catch { return '?'; } };
    console.error('[calendar] not iCal:', shape(url), '→', r.status, r.headers.get('content-type'), shape(r.url), JSON.stringify(text.slice(0, 160).replace(/\s+/g, ' ')));
    if (/calendar\.google\.com/.test(url)) throw new Error('This Google Calendar link opens the calendar page, not its iCal file. In Google Calendar open Settings, choose the calendar, and copy "Secret address in iCal format".');
    if (/icloud\.com/.test(url)) throw new Error('This iCloud link opens the calendar page. In the Calendar app, share the calendar as Public Calendar and copy the webcal:// link.');
    throw new Error('This link opens a web page, not an iCal calendar file (.ics).');
  }
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
      out.push({ artist: artistFromTitle(textOf(it.summary)) || artist, title: String(textOf(it.summary)), location: String(textOf(ev.location)) || null, start, end, allDay: !!it.isFullDay });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

export async function fetchEvents(url, fromMs, toMs) {
  return eventsBetween(await readCalendar(url), fromMs, toMs);
}
