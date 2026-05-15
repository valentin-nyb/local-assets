import { createClient } from 'redis';
import { getWebSessionAuth } from './_venues.js';

// Large video files need the full 300s window
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

async function streamToYouTube(uploadUrl, muxVideoUrl, contentLength) {
  const muxRes = await fetch(muxVideoUrl, { signal: AbortSignal.timeout(30000) });
  if (!muxRes.ok) return { ok: false, status: 502, error: `Mux returned ${muxRes.status}` };

  const putHeaders = { 'Content-Type': 'video/mp4' };
  if (contentLength) putHeaders['Content-Length'] = String(contentLength);

  const ytRes = await fetch(uploadUrl, {
    method:  'PUT',
    headers: putHeaders,
    body:    muxRes.body,
    duplex:  'half',
    signal:  AbortSignal.timeout(270000),
  });

  const rawText = await ytRes.text();
  let data;
  try { data = JSON.parse(rawText); } catch(_) { data = null; }
  return { ok: ytRes.ok, status: ytRes.status, data, rawText };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://local-assets.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-Email');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const session = getWebSessionAuth(req);
  if (!session?.email) return res.status(401).json({ error: 'Not authenticated' });

  const venueSlug = session.venueSlug;
  if (!venueSlug) return res.status(403).json({ error: 'No venue associated with this account' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e) {} }
  const { playbackId, dlFile, title } = body || {};
  if (!playbackId) return res.status(400).json({ error: 'playbackId required' });

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

  try {
    const videoFile   = dlFile || 'highest.mp4';
    const muxVideoUrl = `https://stream.mux.com/${playbackId}/${videoFile}`;
    console.log(`[youtube-upload] source: ${muxVideoUrl}`);

    // HEAD to get file size for YouTube's initiation request
    let contentLength = null;
    try {
      const headRes = await fetch(muxVideoUrl, { method: 'HEAD', signal: AbortSignal.timeout(15000) });
      if (headRes.ok) contentLength = headRes.headers.get('content-length');
    } catch(_) {}
    console.log(`[youtube-upload] content-length: ${contentLength ? (contentLength / 1e6).toFixed(0) + ' MB' : 'unknown'}`);

    // Initiate resumable upload
    let initResult = await initiateResumableUpload(stored.access_token, title, contentLength);

    // On 401, refresh and retry initiation
    if (!initResult.ok && initResult.status === 401) {
      console.log('[youtube-upload] 401 on initiation — refreshing token');
      const newToken = await refreshYtToken(venueSlug, stored);
      if (newToken) {
        stored.access_token = newToken;
        initResult = await initiateResumableUpload(newToken, title, contentLength);
      }
    }

    if (!initResult.ok) {
      console.error(`[youtube-upload] initiation failed: HTTP ${initResult.status}:`, initResult.error);
      return res.status(initResult.status < 600 ? initResult.status : 502).json({
        error: `YouTube upload initiation failed (${initResult.status}): ${initResult.error}`,
      });
    }

    console.log(`[youtube-upload] resumable upload initiated, streaming "${title}"…`);
    const result = await streamToYouTube(initResult.uploadUrl, muxVideoUrl, contentLength);

    if (!result.ok) {
      const errMsg = result.data?.error?.message
        || result.data?.error?.errors?.[0]?.message
        || result.rawText?.slice(0, 200)
        || 'Unknown error';
      console.error(`[youtube-upload] upload failed: HTTP ${result.status}:`, errMsg);
      return res.status(result.status < 600 ? result.status : 502).json({
        error: `YouTube ${result.status}: ${errMsg}`,
      });
    }

    const videoId  = result.data?.id;
    const videoUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : null;
    console.log(`[youtube-upload] uploaded: ${videoUrl}`);
    return res.status(200).json({
      videoId,
      url:   videoUrl,
      title: result.data?.snippet?.title,
    });
  } catch (e) {
    console.error('[youtube-upload] unexpected error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
