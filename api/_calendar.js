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

const toDate = d => (d instanceof Date ? d : new Date(d?.toISOString ? d.toISOString() : d));

// Events overlapping [fromMs, toMs], sorted by start, as { artist, title, start, end } (ms)
export async function venueEvents(redis, slug, fromMs, toMs) {
  const url = await redis.get(calendarKey(slug));
  if (!url) return [];
  return fetchEvents(url, fromMs, toMs);
}

export async function fetchEvents(url, fromMs, toMs) {
  const data = await ical.async.fromURL(url);
  const out = [];
  const from = new Date(fromMs), to = new Date(toMs);
  for (const ev of Object.values(data)) {
    if (ev.type !== 'VEVENT' || !ev.start) continue;
    const length = ev.end ? toDate(ev.end) - toDate(ev.start) : 60 * 60 * 1000;
    // Repeating events: each occurrence in the window
    const starts = ev.rrule ? ev.rrule.between(new Date(fromMs - length), to, true) : [toDate(ev.start)];
    for (const st of starts) {
      const start = st.getTime(), end = start + length;
      if (end <= from.getTime() || start >= to.getTime()) continue;
      const artist = artistFromTitle(ev.summary);
      if (artist) out.push({ artist, title: String(ev.summary || ''), start, end });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
