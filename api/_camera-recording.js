import { videoQuality } from './_video-quality.js';
import { createClient } from 'redis';
import { getVenuesConfig, getMuxAuthForVenue } from './_venues.js';
import { venueEvents } from './_calendar.js';
import { startAudioOnly } from './_verticals.js';
import { sessionSeconds } from './_cam-sessions.js';

// When a camera's broadcast ends, Mux has saved it as an asset. This turns that recording
// into dashboard sessions: one per artist who was "on stage" (set on the Camera page),
// each tagged like an upload and queued for vertical clips.

const MIN_SET_SEC = 60;   // artist changes closer together than this are merged
// Shortest recording that becomes a session: anything shorter is a reconnect fragment (mux-webhook.js
// deletes those under 15 s). A session made with Create a session can be short.
const MIN_RECORDING_SEC = 15;

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
// camera: MASTER for the venue's main (first) camera, else the camera's own name, so a set filmed by several
// cameras keeps them apart; multi: the set is filmed by several cameras and becomes one multi-camera edit
// at: when the recording's first second was filmed (ms), so the decks' sound and a camera's picture,
// recorded separately, can be lined up (vertical clips take the decks' sound)
const tag = (artist, date, set, camera = 'MASTER', multi = false, at = null) => JSON.stringify({
  ...(set ? { artist, date, camera, start: minute(set.from), end: minute(set.to), ...(multi ? { multi: true } : {}) } : { artist, date, camera }),
  ...(at ? { at: Math.round(at) } : {}) });
export const pendingKey = slug => `mc_pending:${slug}`;   // hash "ARTIST|DATE" → { end }: sets waiting for every camera's recording

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

  const redis = createClient({ url: (process.env.UPSTASH_REDIS_URL || process.env.REDIS_URL) });
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
    if (duration < MIN_RECORDING_SEC) { console.log(`[camera-rec] ${assetId} only ${Math.round(duration)}s, left as is`); return; }

    const cams = JSON.parse(await redis.get(`cameras:${slug}`) || '[]');
    const cam  = cams.find(c => c.streamId === streamId) || {};
    const camName = (cam.name || 'Camera').toUpperCase();
    // The decks' sound is saved as each session's HQ AUDIO; it isn't one of the cameras
    const isAudio = cam.kind === 'audio';
    const recording = cams.filter(c => c.streamId && c.kind !== 'audio');
    const camLabel = isAudio ? 'AUDIO' : recording[0]?.streamId === streamId ? 'MASTER' : camName.replace(/\s*\/\/\s*/g, ' - ').replace(/[^A-Z0-9 \-]/g, '').trim().slice(0, 30) || 'CAMERA';
    const multi = !isAudio && recording.length >= 2;
    const startMs = Number(asset.created_at) * 1000;
    // The moment the first frame came in (Mux's recording times), more exact than when the asset was made
    const filmedMs = Date.parse(asset.recording_times?.[0]?.started_at || '') || startMs;
    // Cameras stay live between sessions: what was streamed outside every session isn't kept
    const inSess = await sessionSeconds(redis, streamId, startMs, startMs + duration * 1000);
    if (inSess !== null && inSess < MIN_RECORDING_SEC) {
      await muxReq(auth, `/video/v1/assets/${encodeURIComponent(assetId)}`, { method: 'DELETE' }).catch(() => {});
      console.log(`[camera-rec] ${slug} ${camName}: ${Math.round(duration)}s streamed outside a session, not kept`);
      return;
    }
    // The date set in "On stage" (no calendar), else the day it was recorded
    const date    = cam.stageDate || londonDate(startMs);
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
    })).filter(x => x.end - x.start >= MIN_RECORDING_SEC);

    // No artist set: the session goes under the account's name (an artist account's own name), never the camera's
    const fallbackArtist = String(cfg?.name || 'Untitled set').replace(/\s+TEAM$/i, '');
    const sets = calSets.length ? calSets : buildSets(cam.artist || '', markers, startMs, duration)
      .map(s => ({ ...s, artist: (s.artist || fallbackArtist).toUpperCase().trim() }));

    let sessions;
    if (!calSets.length && sets.length === 1) {
      await muxReq(auth, `/video/v1/assets/${assetId}`, { method: 'PATCH', body: JSON.stringify({ passthrough: tag(sets[0].artist, date, null, camLabel, false, filmedMs) }) });
      sessions = [{ assetId, artist: sets[0].artist }];
    } else {
      // One clip per artist, cut from the full recording. The full recording stays as its own session.
      sessions = [];
      for (const s of sets) {
        const clip = await muxReq(auth, '/video/v1/assets', {
          method: 'POST',
          body: JSON.stringify({
            input: [{ url: `mux://assets/${assetId}`, start_time: Math.floor(s.start), end_time: Math.ceil(s.end) }],
            playback_policy: ['public'], video_quality: await videoQuality(slug),
            passthrough: tag(s.artist, date, calSets.length ? s : null, camLabel, multi && calSets.length > 0, filmedMs + Math.floor(s.start) * 1000),
            // The decks: a downloadable audio file; cameras: the full-quality MP4
            static_renditions: [{ resolution: isAudio ? 'audio-only' : 'highest' }],
          }),
        });
        sessions.push({ assetId: clip.id, artist: s.artist });
      }
      await muxReq(auth, `/video/v1/assets/${assetId}`, { method: 'PATCH', body: JSON.stringify({ passthrough: tag(camName + ' FULL RECORDING', date, null, isAudio ? 'AUDIO' : 'MASTER') }) });
    }
    console.log(`[camera-rec] ${slug} ${camName}${calSets.length ? ' (calendar)' : ''}: ${sessions.map(s => s.artist).join(', ')}`);

    // No Decks slot: the main camera's sound is the decks' (a mic or transmitter on the mixer, into the camera),
    // so a single set's recording also gives its HQ AUDIO. Sets cut by the calendar get theirs when Mux has
    // each one ready (api/mux-webhook.js).
    if (!isAudio && camLabel === 'MASTER' && !calSets.length && sets.length === 1 && !cams.some(c => c.kind === 'audio' && c.streamId)
        && (asset.tracks || []).some(t => t.type === 'audio')) {
      await muxReq(auth, '/video/v1/assets', { method: 'POST', body: JSON.stringify({
        input: [{ url: `mux://assets/${assetId}` }], playback_policy: ['public'], video_quality: 'basic',
        passthrough: tag(sets[0].artist, date, null, 'AUDIO', false, filmedMs), static_renditions: [{ resolution: 'audio-only' }],
      }) }).then(a => console.log(`[camera-rec] ${slug} HQ audio from ${camName}: ${a.id}`))
        .catch(e => console.error('[camera-rec] HQ audio', assetId, e.message));
    }
    // A single decks recording (no split): saved as audio only (the sets cut by the calendar are handled
    // when Mux has them ready, in api/mux-webhook.js)
    if (isAudio && !calSets.length && sets.length === 1) {
      const passthrough = tag(sets[0].artist, date, null, camLabel, false, filmedMs);
      await startAudioOnly(slug, { ...asset, passthrough }).catch(e => console.error('[camera-rec] audio only', assetId, e.message));
    }
    // Markers up to the end of this recording are used up
    await redis.del(`cam_markers:${streamId}`);
    // "On stage" session details (no calendar): name and venue go on each session; the name and date are used once
    if (!calSets.length && (cam.stageTitle || cam.stageVenue || cam.stageLabel)) {
      for (const s of sessions) {
        const field = `${String(s.artist).toUpperCase().trim()}|${date}`;
        let prev = {};
        try { prev = JSON.parse(await redis.hGet(`session_meta:${slug}`, field) || '{}'); } catch {}
        await redis.hSet(`session_meta:${slug}`, field, JSON.stringify({ ...prev, title: cam.stageTitle || prev.title || '', venue: cam.stageVenue || prev.venue || '', label: cam.stageLabel || prev.label || '' }));
      }
      const fresh = JSON.parse(await redis.get(`cameras:${slug}`) || '[]');
      const me = fresh.find(c => c.streamId === streamId);
      if (me) { me.stageTitle = ''; me.stageDate = ''; me.stageLabel = ''; await redis.set(`cameras:${slug}`, JSON.stringify(fresh)); }
    } else if (!calSets.length && cam.stageDate) {
      const fresh = JSON.parse(await redis.get(`cameras:${slug}`) || '[]');
      const me = fresh.find(c => c.streamId === streamId);
      if (me) { me.stageDate = ''; await redis.set(`cameras:${slug}`, JSON.stringify(fresh)); }
    }

    // Several cameras on the same calendar set: once every camera's recording is in, they become one
    // multi-camera edit (api/camera-schedule.js starts it); its clips come from the edit. With one camera,
    // each set's clip makes its own vertical clips when Mux has it ready (api/mux-webhook.js).
    if (multi && calSets.length) {
      for (const s of calSets) await redis.hSet(pendingKey(slug), `${s.artist.toUpperCase().trim()}|${date}`, JSON.stringify({ end: s.to, at: Date.now() }));
    }
  } finally {
    await redis.quit().catch(() => {});
  }
}
