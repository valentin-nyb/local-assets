import { createClient } from 'redis';
import { getWebSessionAuth } from './_venues.js';
import { calendarKey, fetchEvents } from './_calendar.js';

export const artKey = slug => `event_art:${slug}`;
// The Brand Kit artist an event is linked to (chosen in the event's details on the Calendar page): event key → artist-<slug>
export const linkKey = slug => `event_artist:${slug}`;
export async function readLinks(slug) {
  const redis = createClient({ url: (process.env.UPSTASH_REDIS_URL || process.env.REDIS_URL) });
  try { await redis.connect(); return (await redis.hGetAll(linkKey(slug))) || {}; }
  catch { return {}; } finally { await redis.quit().catch(() => {}); }
}
export const eventKey = ev => `${ev.start}|${String(ev.artist || ev.title || '').toUpperCase().trim()}`;
// event key → the artworks added to it (a list; an early version kept one URL)
const artList = v => { try { const a = JSON.parse(v); return Array.isArray(a) ? a : [String(a)]; } catch { return v ? [String(v)] : []; } };
export async function readArt(slug) {
  const redis = createClient({ url: (process.env.UPSTASH_REDIS_URL || process.env.REDIS_URL) });
  try { await redis.connect(); const raw = (await redis.hGetAll(artKey(slug))) || {}; return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, artList(v)])); }
  catch { return {}; } finally { await redis.quit().catch(() => {}); }
}

// The dashboard's Next event card: the next sets from the account's own calendar (connected on the Camera page).
// An account without one shows nothing: never another account's calendar.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const session = getWebSessionAuth(req);
  let calUrl = null;
  if (session?.venueSlug) {
    const redis = createClient({ url: (process.env.UPSTASH_REDIS_URL || process.env.REDIS_URL) });
    try { await redis.connect(); calUrl = await redis.get(calendarKey(session.venueSlug)); }
    catch (e) { console.error('[next-event] redis', e.message); }
    finally { await redis.quit().catch(() => {}); }
  }
  const source = 'venue';
  // Artwork for an event: a Brand Kit image chosen with "Add to event" (brand.html), kept per account by the
  // event's start and artist, since the calendar itself (Google, iCal) can only be read
  if (req.method === 'POST') {
    if (!session?.venueSlug) return res.status(401).json({ error: 'Not authenticated' });
    let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const key = String(body?.key || '').slice(0, 200), url = String(body?.url || '');
    if (!/^\d{12,14}\|/.test(key)) return res.status(400).json({ error: 'Unknown event' });
    // Link the event to an artist in Brand Kit ('' to unlink)
    if ('artistOwner' in (body || {})) {
      const owner = String(body.artistOwner || '');
      if (owner && !/^artist-[a-z0-9-]+$/.test(owner)) return res.status(400).json({ error: 'Choose an artist' });
      const redis = createClient({ url: (process.env.UPSTASH_REDIS_URL || process.env.REDIS_URL) });
      try { await redis.connect(); owner ? await redis.hSet(linkKey(session.venueSlug), key, owner) : await redis.hDel(linkKey(session.venueSlug), key); }
      finally { await redis.quit().catch(() => {}); }
      return res.status(200).json({ ok: true, key, artistOwner: owner || null });
    }
    let ok = false; try { const u = new URL(url); ok = /\.public\.blob\.vercel-storage\.com$/.test(u.hostname) && decodeURIComponent(u.pathname).startsWith(`/brand/${session.venueSlug}/`); } catch {}
    if (!ok) return res.status(403).json({ error: 'Not your file' });
    // Adds the artwork to the event, or with remove takes it off; an event can have several
    const redis = createClient({ url: (process.env.UPSTASH_REDIS_URL || process.env.REDIS_URL) });
    let list;
    try {
      await redis.connect();
      list = artList(await redis.hGet(artKey(session.venueSlug), key)).filter(u => u !== url);
      if (!body.remove) list.push(url);
      list.length ? await redis.hSet(artKey(session.venueSlug), key, JSON.stringify(list.slice(-20))) : await redis.hDel(artKey(session.venueSlug), key);
    } finally { await redis.quit().catch(() => {}); }
    return res.status(200).json({ ok: true, key, art: list });
  }
  if (!calUrl) return res.status(200).json({ events: [], connected: false });

  try {
    const now = Date.now();
    // ?all=1: every set in the next two months (to pick one for "Add to event"), else the next three
    const art = await readArt(session.venueSlug);
    const events = (await fetchEvents(calUrl, now, now + 60 * 86400e3))
      .filter(ev => ev.end > now)
      .slice(0, req.query?.all ? 200 : 3)
      .map(ev => ({
        key: eventKey(ev),
        art: art[eventKey(ev)] || [],
        title: ev.title || ev.artist,
        artist: ev.artist,
        location: ev.location || null,
        start: new Date(ev.start).toISOString(),
        end: new Date(ev.end).toISOString(),
        onNow: ev.start <= now,
      }));
    return res.status(200).json({ events, connected: true, source });
  } catch (e) {
    console.error('[next-event]', source, e.message);
    return res.status(200).json({ events: [], connected: true, source, error: e.message });
  }
}
