import { createClient } from 'redis';
import { getVenuesConfig, getMuxAuthForVenue } from './_venues.js';
import { calendarKey, fetchEvents } from './_calendar.js';
import { pendingKey } from './_camera-recording.js';
import { sessionSources, startMulticam } from './multicam.js';
import { listAllAssets } from './_verticals.js';
import { inSession, openSession, closeSession, isManaged, managedKey } from './_cam-sessions.js';

// Cameras and the venue calendar (Vercel cron, every minute).
// A camera's Mux live stream is open while Camera Control is open somewhere (so it shows live; Mux bills
// every minute a stream is open) and during sessions, and closed otherwise. Sessions are what is kept: a set in the calendar (from shortly before it to shortly after) or one made
// with Create a session. When one starts or ends the broadcast is cut, so every session is its own
// recording (api/_camera-recording.js saves it for the DJ, and deletes what was streamed outside sessions).

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

  const redis = createClient({ url: (process.env.UPSTASH_REDIS_URL || process.env.REDIS_URL) });
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
      // Someone has Camera Control open (api/cameras.js "viewing", renewed every minute)
      const viewing = !!(await redis.exists(`cam_view:${slug}`));
      for (const cam of cams) {
        if (!cam.streamId) continue;
        // A session: a set in the connected calendar (when the camera follows it), or one started with
        // Create a session / Record now, until Stop
        const follow = cam.followCalendar !== false && !!win;
        const manual = await redis.exists(`cam_manual:${cam.streamId}`);
        // "Stop set": the set finished early, so nothing more is kept until the set's time is over
        const ended = follow && win.open && !manual && await redis.exists(`cam_ended:${cam.streamId}`);
        const session = !!(((follow && win.open) || manual) && !ended);
        try {
          // Open while someone watches in Camera Control, or for a session; closed otherwise
          const want = session || viewing ? 'enabled' : 'disabled';
          if (await redis.get(stateKey(cam.streamId)) !== want) {
            await mux(auth, `/video/v1/live-streams/${encodeURIComponent(cam.streamId)}/${want === 'enabled' ? 'enable' : 'disable'}`, 'PUT');
            await redis.set(stateKey(cam.streamId), want);
            changes.push(`${slug}/${cam.name}: ${want === 'enabled' ? 'live' : 'closed'}`);
          }
          const was = await inSession(redis, cam.streamId);
          // A session already recording when cameras first ran this way: kept whole, from its start
          const since = session && !was && !(await isManaged(redis, cam.streamId))
            ? (Number(await redis.get(`cam_manual:${cam.streamId}`)) || (win?.current ? win.current.start - BEFORE_MS : now)) : 0;
          if (session && !was) { await openSession(redis, auth, cam.streamId, since); changes.push(`${slug}/${cam.name}: session started${win?.current ? ' (' + win.current.artist + ')' : ''}`); }
          else if (!session && was) { await closeSession(redis, auth, cam.streamId); changes.push(`${slug}/${cam.name}: session ended`); }
          // From now on, what this camera streams outside sessions isn't kept
          await redis.set(managedKey(cam.streamId), '1');
        } catch (e) { console.error('[camera-schedule]', slug, cam.name, e.message); }
      }
    }
    // Sets filmed by several cameras: once every camera's recording is saved (from 15 min after the set,
    // at the latest an hour after), queue the multi-camera edit on the venue's Mac mini
    for (const [slug, cfg] of Object.entries(getVenuesConfig())) {
      const pending = await redis.hGetAll(pendingKey(slug));
      const due = Object.entries(pending || {}).map(([k, v]) => { try { return [k, JSON.parse(v)]; } catch { return null; } }).filter(x => x && now > x[1].end + 15 * 60e3);
      if (!due.length) continue;
      const auth = getMuxAuthForVenue({ slug, ...cfg });
      if (!auth) continue;
      try {
        const assets = await listAllAssets(auth);
        const expected = JSON.parse(await redis.get(`cameras:${slug}`) || '[]').filter(c => c.streamId && c.kind !== 'audio').length;
        for (const [key, p] of due) {
          const [artist, date] = key.split('|');
          const src = sessionSources(assets, artist, date);
          const waiting = assets.some(a => a.status === 'preparing' && String(a.passthrough || '').includes(`"artist":"${artist}"`));
          if ((src.cams.length < expected || waiting) && now < p.end + 60 * 60e3) continue;   // more recordings still on their way
          await redis.hDel(pendingKey(slug), key);
          if (src.cams.length < 2) { console.log('[multicam] only', src.cams.length, 'camera for', slug, key); continue; }
          const started = await startMulticam(redis, slug, auth, artist, date, src, { auto: true });
          changes.push(`${slug}/${artist}: multi-camera edit ${started.error ? 'not started (' + started.error + ')' : 'queued'}`);
        }
      } catch (e) { console.error('[camera-schedule] multicam', slug, e.message); }
    }
    if (changes.length) console.log('[camera-schedule]', changes.join(' | '));
    return res.status(200).json({ changes });
  } finally {
    await redis.quit().catch(() => {});
  }
}
