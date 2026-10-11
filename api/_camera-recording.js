import crypto from 'crypto';
import { createClient } from 'redis';
import { getVenuesConfig, getMuxAuthForVenue } from './_venues.js';
import { getPipelineDb } from './_pipeline-db.js';
import { resolveWatermark } from './_watermark.js';
import { venueEvents } from './_calendar.js';

// When a camera's broadcast ends, Mux has saved it as an asset. This turns that recording
// into dashboard sessions: one per artist who was "on stage" (set on the Camera page),
// each tagged like an upload and queued for vertical clips.

const MIN_SET_SEC = 60;   // artist changes closer together than this are merged

const muxReq = (auth, path, init = {}) => fetch('https://api.mux.com' + path, {
  ...init,
  headers: { Authorization: auth, 'Content-Type': 'application/json', ...(init.headers || {}) },
  signal: AbortSignal.timeout(15000),
}).then(async r => {
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.error?.messages?.[0] || `Mux ${r.status}`);
  return body.data;
});

const londonDate = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Europe/London' }); // YYYY-MM-DD
// start/end: the set's exact times from the venue calendar (UTC, to the minute)
const minute = ms => new Date(ms).toISOString().slice(0, 16) + 'Z';
const tag = (artist, date, set) => JSON.stringify(set ? { artist, date, camera: 'MASTER', start: minute(set.from), end: minute(set.to) } : { artist, date, camera: 'MASTER' });

// Splits the recording at each artist change. Times are seconds from the start of the recording.
export function buildSets(defaultArtist, markers, startMs, duration) {
  const inside = markers
    .map(m => ({ t: (m.at - startMs) / 1000, from: m.from, to: m.to }))
    .filter(m => m.t > 0 && m.t < duration)
    .sort((a, b) => a.t - b.t);
  // Before the first change, the artist is whoever was set when it happened
  let artist = inside.length ? inside[0].from : defaultArtist;
  let start = 0;
  const sets = [];
  for (const m of inside) {
    sets.push({ artist, start, end: m.t });
    artist = m.to; start = m.t;
  }
  sets.push({ artist, start, end: duration });

  // Fold very short sets into a neighbour, then join neighbours with the same artist
  const out = [];
  for (const s of sets) {
    const prev = out[out.length - 1];
    if (s.end - s.start < MIN_SET_SEC && prev) { prev.end = s.end; continue; }
    if (prev && prev.end - prev.start < MIN_SET_SEC) { s.start = prev.start; out.pop(); }
    out.push({ ...s });
  }
  const joined = [];
  for (const s of out) {
    const prev = joined[joined.length - 1];
    if (prev && (prev.artist || '').toUpperCase() === (s.artist || '').toUpperCase()) prev.end = s.end;
    else joined.push(s);
  }
  return joined;
}

export async function processCameraRecording(event) {
  const streamId = event?.live_stream_id;
  const assetId  = event?.id;
  if (!streamId || !assetId) return;

  const redis = createClient({ url: process.env.REDIS_URL });
  await redis.connect();
  try {
    const slug = await redis.hGet('camera_streams', streamId);
    if (!slug) { console.log(`[camera-rec] stream ${streamId} is not a registered camera`); return; }
    // Mux may send the event more than once
    if (!(await redis.set(`camrec:${assetId}`, '1', { NX: true, EX: 60 * 60 * 24 * 30 }))) return;

    const cfg  = getVenuesConfig()[slug];
    const auth = cfg && getMuxAuthForVenue({ slug, ...cfg });
    if (!auth) { console.error(`[camera-rec] no Cloud Storage credentials for ${slug}`); return; }

    // Load from Mux with the venue's own token: proves the recording is this venue's
    const asset = await muxReq(auth, `/video/v1/assets/${encodeURIComponent(assetId)}`);
    if (asset.live_stream_id !== streamId) { console.error('[camera-rec] asset/stream mismatch', assetId); return; }
    const duration = Number(asset.duration) || 0;
    if (duration < MIN_SET_SEC) { console.log(`[camera-rec] ${assetId} only ${Math.round(duration)}s, left as is`); return; }

    const cams = JSON.parse(await redis.get(`cameras:${slug}`) || '[]');
    const cam  = cams.find(c => c.streamId === streamId) || {};
    const camName = (cam.name || 'Camera').toUpperCase();
    const startMs = Number(asset.created_at) * 1000;
    const date    = londonDate(startMs);
    const markers = (await redis.lRange(`cam_markers:${streamId}`, 0, -1)).map(m => { try { return JSON.parse(m); } catch { return null; } }).filter(Boolean);

    // The venue calendar decides who played when: each set is cut at its exact start and end.
    // Without calendar sets, the On stage changes made on the Camera page split the recording.
    const endMs = startMs + duration * 1000;
    const events = await venueEvents(redis, slug, startMs, endMs).catch(e => { console.error('[camera-rec] calendar:', e.message); return []; });
    const calSets = events.map(ev => ({
      artist: ev.artist,
      start: Math.max(0, (ev.start - startMs) / 1000),
      end: Math.min(duration, (ev.end - startMs) / 1000),
      from: Math.max(ev.start, startMs), to: Math.min(ev.end, endMs),
    })).filter(x => x.end - x.start >= MIN_SET_SEC);

    const sets = calSets.length ? calSets : buildSets(cam.artist || '', markers, startMs, duration)
      .map(s => ({ ...s, artist: (s.artist || camName).toUpperCase().trim() }));

    let sessions;
    if (!calSets.length && sets.length === 1) {
      await muxReq(auth, `/video/v1/assets/${assetId}`, { method: 'PATCH', body: JSON.stringify({ passthrough: tag(sets[0].artist, date) }) });
      sessions = [{ assetId, artist: sets[0].artist }];
    } else {
      // One clip per artist, cut from the full recording. The full recording stays as its own session.
      sessions = [];
      for (const s of sets) {
        const clip = await muxReq(auth, '/video/v1/assets', {
          method: 'POST',
          body: JSON.stringify({
            input: [{ url: `mux://assets/${assetId}`, start_time: Math.floor(s.start), end_time: Math.ceil(s.end) }],
            playback_policy: ['public'],
            passthrough: tag(s.artist, date, calSets.length ? s : null),
            static_renditions: [{ resolution: 'highest' }],
          }),
        });
        sessions.push({ assetId: clip.id, artist: s.artist });
      }
      await muxReq(auth, `/video/v1/assets/${assetId}`, { method: 'PATCH', body: JSON.stringify({ passthrough: tag(camName + ' FULL RECORDING', date) }) });
    }
    console.log(`[camera-rec] ${slug} ${camName}${calSets.length ? ' (calendar)' : ''}: ${sessions.map(s => s.artist).join(', ')}`);

    // Markers up to the end of this recording are used up
    await redis.del(`cam_markers:${streamId}`);

    if (cam.autoClips === false) return;
    const db = getPipelineDb();
    for (const s of sessions) {
      const watermark = await resolveWatermark(redis, slug, s.artist).catch(() => null);
      // "asset:<id>" tells the clip worker the asset already exists (uploads pass a Mux upload id)
      await db.query(
        `INSERT INTO pipeline_jobs (id, upload_id, artist_name, venue_slug, watermark) VALUES ($1, $2, $3, $4, $5)`,
        [crypto.randomBytes(8).toString('hex'), 'asset:' + s.assetId, s.artist, slug, watermark && JSON.stringify(watermark)]
      );
    }
  } finally {
    await redis.quit().catch(() => {});
  }
}
