import { createClient } from 'redis';
import { getVenuesConfig, getMuxAuthForVenue } from './_venues.js';
import { calendarKey, fetchEvents } from './_calendar.js';

// Cameras start and stop with the venue calendar (Vercel cron, every minute).
// A camera's Mux live stream is opened shortly before each set and closed shortly after it, so the
// camera (left streaming all night) is only recorded while a set is on, and every set ends as its own
// recording (api/_camera-recording.js then saves it for the DJ in the calendar).
// Cameras with "Start and stop with the calendar" turned off, or venues without a calendar, are left open.

const BEFORE_MS = 2 * 60e3;   // open 2 min before a set
const AFTER_MS = 2 * 60e3;    // close 2 min after it ends
const stateKey = streamId => `cam_sched:${streamId}`;

async function mux(auth, path, method = 'GET') {
  const r = await fetch('https://api.mux.com' + path, { method, headers: { Authorization: auth }, signal: AbortSignal.timeout(10000) });
  if (!r.ok && r.status !== 404) throw new Error(`Mux ${r.status} on ${path}`);
  return r.status === 404 ? null : r.json().catch(() => ({}));
}

// When the cameras of a venue open and close next (for Camera Control)
export function scheduleWindow(events, now = Date.now()) {
  const on = events.find(e => e.start - BEFORE_MS <= now && now < e.end + AFTER_MS);
  const next = events.find(e => e.start - BEFORE_MS > now);
  return { open: !!on, current: on || null, closesAt: on ? on.end + AFTER_MS : null, opensAt: next ? next.start - BEFORE_MS : null, next: next || null };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const secret = process.env.CRON_SECRET;
  const ok = secret ? req.headers.authorization === `Bearer ${secret}` : /vercel-cron/i.test(req.headers['user-agent'] || '');
  if (!ok) return res.status(401).json({ error: 'Cron only' });

  const redis = createClient({ url: process.env.REDIS_URL });
  await redis.connect();
  const changes = [];
  try {
    const now = Date.now();
    for (const [slug, cfg] of Object.entries(getVenuesConfig())) {
      let cams;
      try { cams = JSON.parse(await redis.get(`cameras:${slug}`) || '[]'); } catch { cams = []; }
      if (!cams.length) continue;
      const auth = getMuxAuthForVenue({ slug, ...cfg });
      if (!auth) continue;
      const url = await redis.get(calendarKey(slug));
      let win = null;
      if (url) {
        try { win = scheduleWindow(await fetchEvents(url, now - 24 * 3600e3, now + 24 * 3600e3), now); }
        catch (e) { console.error('[camera-schedule] calendar', slug, e.message); continue; }   // unreadable calendar: change nothing
      }
      for (const cam of cams) {
        if (!cam.streamId) continue;
        // Open unless this camera follows a connected calendar and no set is on
        const follow = cam.followCalendar !== false && !!win;
        const want = !follow || win.open ? 'enabled' : 'disabled';
        const have = await redis.get(stateKey(cam.streamId));
        if (have === want) continue;
        if (!have && want === 'enabled') { await redis.set(stateKey(cam.streamId), want); continue; }   // streams start open
        try {
          await mux(auth, `/video/v1/live-streams/${encodeURIComponent(cam.streamId)}/${want === 'enabled' ? 'enable' : 'disable'}`, 'PUT');
          await redis.set(stateKey(cam.streamId), want);
          changes.push(`${slug}/${cam.name}: ${want}${win?.current ? ' (' + win.current.artist + ')' : ''}`);
        } catch (e) { console.error('[camera-schedule]', slug, cam.name, e.message); }
      }
    }
    if (changes.length) console.log('[camera-schedule]', changes.join(' | '));
    return res.status(200).json({ changes });
  } finally {
    await redis.quit().catch(() => {});
  }
}
