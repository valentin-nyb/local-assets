import { createClient } from 'redis';
import { getWebSessionAuth } from './_venues.js';
import { calendarKey, fetchEvents } from './_calendar.js';

// The dashboard's Next event card: the next sets from the account's own calendar (connected on the Camera page).
// An account without one shows nothing: never another account's calendar.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const session = getWebSessionAuth(req);
  let calUrl = null;
  if (session?.venueSlug) {
    const redis = createClient({ url: process.env.REDIS_URL });
    try { await redis.connect(); calUrl = await redis.get(calendarKey(session.venueSlug)); }
    catch (e) { console.error('[next-event] redis', e.message); }
    finally { await redis.quit().catch(() => {}); }
  }
  const source = 'venue';
  if (!calUrl) return res.status(200).json({ events: [], connected: false });

  try {
    const now = Date.now();
    const events = (await fetchEvents(calUrl, now, now + 60 * 86400e3))
      .filter(ev => ev.end > now)
      .slice(0, 3)
      .map(ev => ({
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
