import crypto from 'crypto';
import { createClient } from 'redis';
import { getWebSessionAuth } from './_venues.js';

// Each call uploads as many chunks as fit in ~240s; long files continue over several calls
export const config = { maxDuration: 300 };

async function refreshYtToken(venueSlug, stored) {
  if (!stored.refresh_token) return null;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: stored.refresh_token,
      grant_type:    'refresh_token',
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.access_token) return null;

  const updated = {
    access_token:  data.access_token,
    refresh_token: data.refresh_token || stored.refresh_token,
    expires_at:    Date.now() + (data.expires_in || 3600) * 1000,
  };
  const redis = createClient({ url: process.env.REDIS_URL });
  try {
    await redis.connect();
    await redis.set(`youtube_token:${venueSlug}`, JSON.stringify(updated), { EX: 60 * 60 * 24 * 365 });
  } finally {
    await redis.quit().catch(() => {});
  }
  return updated.access_token;
}

async function initiateResumableUpload(accessToken, title, contentLength) {
  const initHeaders = {
    Authorization:  `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'X-Upload-Content-Type': 'video/mp4',
  };
  if (contentLength) initHeaders['X-Upload-Content-Length'] = String(contentLength);

  const res = await fetch(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      method:  'POST',
      headers: initHeaders,
      body: JSON.stringify({
        snippet: { title: title || 'Untitled Session', description: '' },
        status:  { privacyStatus: 'unlisted' },
      }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    let msg;
    try { msg = JSON.parse(text)?.error?.message; } catch(_) {}
    return { ok: false, status: res.status, error: msg || text.slice(0, 200) };
  }

  const uploadUrl = res.headers.get('Location');
  if (!uploadUrl) return { ok: false, status: 500, error: 'No upload URL returned by YouTube' };
  return { ok: true, uploadUrl };
}

// Chunks must be multiples of 256 KiB for YouTube resumable uploads.
const CHUNK_BYTES = 64 * 1024 * 1024;
// Stop starting new chunks when less than this much of the function's time is left.
// Kept short so the dashboard gets progress updates every ~25s.
const TIME_BUDGET_MS = 25_000;

// Upload one chunk [start, end] (inclusive) from Mux to the YouTube session.
// Returns { done, next, data } — next is the first byte YouTube still needs.
async function putChunk(uploadUrl, accessToken, muxVideoUrl, start, end, total) {
  const muxRes = await fetch(muxVideoUrl, { headers: { Range: `bytes=${start}-${end}` } });
  if (muxRes.status !== 206 && !(muxRes.status === 200 && start === 0 && end === total - 1)) {
    throw new Error(`Mux returned ${muxRes.status} for bytes ${start}-${end}`);
  }
  const chunk = Buffer.from(await muxRes.arrayBuffer());
  if (chunk.length !== end - start + 1) throw new Error(`Short read from Mux (${chunk.length} of ${end - start + 1} bytes)`);

  const ytRes = await fetch(uploadUrl, {
    method:  'PUT',
    headers: {
      Authorization:   `Bearer ${accessToken}`,
      'Content-Type':  'video/mp4',
      'Content-Length': String(chunk.length),
      'Content-Range': `bytes ${start}-${end}/${total}`,
    },
    body: chunk,
  });
  if (ytRes.status === 308) {
    const range = ytRes.headers.get('range');           // e.g. "bytes=0-67108863"
    const next = range ? Number(range.split('-')[1]) + 1 : start;
    return { done: false, next };
  }
  const text = await ytRes.text();
  let data = null;
  try { data = JSON.parse(text); } catch (_) {}
  if (!ytRes.ok) {
    const msg = data?.error?.message || data?.error?.errors?.[0]?.message || text.slice(0, 200);
    const err = new Error(`YouTube ${ytRes.status}: ${msg}`);
    err.status = ytRes.status;
    throw err;
  }
  return { done: true, data };
}

async function withRedis(fn) {
  const redis = createClient({ url: process.env.REDIS_URL });
  try { await redis.connect(); return await fn(redis); }
  finally { await redis.quit().catch(() => {}); }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://local-assets.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-Email');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e) {} }
  const { playbackId, dlFile, title, uploadId, action, videoId, image } = body || {};
  const isThumbnail = action === 'thumbnail';
  if (isThumbnail) {
    if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) return res.status(400).json({ error: 'valid videoId required' });
    if (typeof image !== 'string' || !image) return res.status(400).json({ error: 'image required' });
  } else if (!playbackId || !/^[A-Za-z0-9]+$/.test(playbackId)) {
    return res.status(400).json({ error: 'valid playbackId required' });
  }
  if (dlFile && !/^[A-Za-z0-9_.-]+$/.test(dlFile)) return res.status(400).json({ error: 'invalid file name' });
  if (uploadId && !/^[a-f0-9]{24}$/.test(uploadId)) return res.status(400).json({ error: 'invalid uploadId' });
  const startedAt = Date.now();

  // A new upload needs a signed-in session. Continuing one (and setting its cover) is
  // authorised by its uploadId — an unguessable id stored server-side with the venue —
  // so long uploads keep going after the 10-minute dashboard token expires.
  const session = getWebSessionAuth(req);
  let upload = null;
  if (uploadId) {
    upload = await withRedis(r => r.get(`yt_upload:${uploadId}`)).then(v => v && JSON.parse(v)).catch(() => null);
    if (!upload) return res.status(404).json({ error: 'Upload session expired — click YouTube again to restart' });
    if (session?.venueSlug && session.venueSlug !== upload.venueSlug) return res.status(403).json({ error: 'Forbidden' });
  } else if (!session?.email) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const venueSlug = upload ? upload.venueSlug : session.venueSlug;
  if (!venueSlug) return res.status(403).json({ error: 'No venue associated with this account' });
  if (isThumbnail && (!upload || upload.videoId !== videoId)) return res.status(403).json({ error: 'Cover can only be set right after uploading' });

  const redis = createClient({ url: process.env.REDIS_URL });
  let stored;
  try {
    await redis.connect();
    const raw = await redis.get(`youtube_token:${venueSlug}`);
    if (!raw) return res.status(400).json({ error: 'YouTube not connected — connect your account first' });
    stored = JSON.parse(raw);
  } catch (e) {
    return res.status(500).json({ error: 'Redis error: ' + e.message });
  } finally {
    await redis.quit().catch(() => {});
  }

  // Refresh token if expired or expiring within 60s
  if (stored.expires_at && Date.now() > stored.expires_at - 60000) {
    console.log('[youtube-upload] Token expired — refreshing');
    const newToken = await refreshYtToken(venueSlug, stored);
    if (!newToken) return res.status(401).json({ error: 'YouTube token expired — please reconnect your account' });
    stored.access_token = newToken;
    console.log('[youtube-upload] Token refreshed');
  }

  // Set the session's marketing thumbnail as the uploaded video's cover.
  if (isThumbnail) {
    const img = Buffer.from(image, 'base64');
    if (!img.length || img.length > 2 * 1024 * 1024) return res.status(400).json({ error: 'Thumbnail must be under 2 MB' });
    const isJpeg = img[0] === 0xff && img[1] === 0xd8;
    const isPng  = img[0] === 0x89 && img[1] === 0x50;
    if (!isJpeg && !isPng) return res.status(400).json({ error: 'Thumbnail must be JPEG or PNG' });
    const tRes = await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${videoId}&uploadType=media`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${stored.access_token}`, 'Content-Type': isJpeg ? 'image/jpeg' : 'image/png' },
      body:    img,
    });
    if (!tRes.ok) {
      const err = await tRes.json().catch(() => ({}));
      const msg = err?.error?.message || `HTTP ${tRes.status}`;
      console.error('[youtube-upload] thumbnail failed:', tRes.status, msg);
      return res.status(tRes.status < 600 ? tRes.status : 502).json({ error: msg });
    }
    console.log(`[youtube-upload] thumbnail set for ${videoId}`);
    return res.status(200).json({ ok: true });
  }

  try {
    const videoFile   = dlFile || 'highest.mp4';
    const muxVideoUrl = `https://stream.mux.com/${playbackId}/${videoFile}`;
    const stateKey    = id => `yt_upload:${id}`;

    // Start a new YouTube upload session, or continue one from a previous call.
    let state;
    if (upload) {
      state = upload;
      if (state.source !== muxVideoUrl) return res.status(400).json({ error: 'Upload session does not match this video' });
      if (state.videoId) return res.status(200).json({ done: true, uploadId: state.id, videoId: state.videoId, url: `https://www.youtube.com/watch?v=${state.videoId}` });
    } else {
      console.log(`[youtube-upload] source: ${muxVideoUrl}`);
      const headRes = await fetch(muxVideoUrl, { method: 'HEAD', signal: AbortSignal.timeout(15000) });
      const total = Number(headRes.headers.get('content-length')) || 0;
      if (!headRes.ok || !total) return res.status(502).json({ error: `Could not read the video from Cloud Storage (${headRes.status})` });
      console.log(`[youtube-upload] content-length: ${(total / 1e6).toFixed(0)} MB`);

      let initResult = await initiateResumableUpload(stored.access_token, title, total);
      if (!initResult.ok && initResult.status === 401) {
        console.log('[youtube-upload] 401 on initiation — refreshing token');
        const newToken = await refreshYtToken(venueSlug, stored);
        if (newToken) {
          stored.access_token = newToken;
          initResult = await initiateResumableUpload(newToken, title, total);
        }
      }
      if (!initResult.ok) {
        console.error(`[youtube-upload] initiation failed: HTTP ${initResult.status}:`, initResult.error);
        return res.status(initResult.status < 600 ? initResult.status : 502).json({
          error: `YouTube upload initiation failed (${initResult.status}): ${initResult.error}`,
        });
      }
      state = { id: crypto.randomBytes(12).toString('hex'), venueSlug, uploadUrl: initResult.uploadUrl, source: muxVideoUrl, total, offset: 0 };
      console.log(`[youtube-upload] resumable upload initiated for "${title}" (${state.id})`);
    }

    // Send 64 MB chunks until finished or the time budget runs out.
    while (state.offset < state.total && Date.now() - startedAt < TIME_BUDGET_MS) {
      const end = Math.min(state.offset + CHUNK_BYTES, state.total) - 1;
      const r = await putChunk(state.uploadUrl, stored.access_token, muxVideoUrl, state.offset, end, state.total);
      if (r.done) {
        const newVideoId = r.data?.id;
        const videoUrl = newVideoId ? `https://www.youtube.com/watch?v=${newVideoId}` : null;
        // Keep a short-lived record so the cover can be set with this uploadId.
        await withRedis(rd => rd.set(stateKey(state.id), JSON.stringify({ id: state.id, venueSlug, source: state.source, videoId: newVideoId }), { EX: 60 * 30 })).catch(() => {});
        console.log(`[youtube-upload] uploaded: ${videoUrl}`);
        return res.status(200).json({ done: true, uploadId: state.id, videoId: newVideoId, url: videoUrl, title: r.data?.snippet?.title });
      }
      state.offset = r.next;
    }

    // Out of time for this call — save progress; the dashboard calls again with uploadId.
    await withRedis(rd => rd.set(stateKey(state.id), JSON.stringify(state), { EX: 60 * 60 * 24 }));
    console.log(`[youtube-upload] ${state.id}: ${(state.offset / 1e6).toFixed(0)} / ${(state.total / 1e6).toFixed(0)} MB — continuing in next call`);
    return res.status(202).json({ done: false, uploadId: state.id, sent: state.offset, total: state.total });
  } catch (e) {
    console.error('[youtube-upload] error:', e.message);
    return res.status(e.status && e.status < 600 ? e.status : 500).json({ error: e.message });
  }
}
