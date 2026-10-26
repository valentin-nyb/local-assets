import { videoQuality } from './_video-quality.js';
import { pausedBy, sendPaused } from './_suspend.js';
import { getWebSessionAuth } from './_venues.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://local-assets.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-Email');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const session = getWebSessionAuth(req);
  console.error('[get-upload-url] session:', JSON.stringify({
    email: session?.email ?? null,
    venueSlug: session?.venueSlug ?? null,
    hasMuxAuth: !!session?.muxAuth,
  }));
  if (!session?.muxAuth) {
    return res.status(401).json({ error: 'Not authenticated — no Cloud Storage access for this account' });
  }
  // An artist with access doesn't upload recordings or thumbnails (the account does)
  if (session.member) return res.status(403).json({ error: 'Only the account can do this' });
  if (req.method !== 'GET' && session?.venueSlug) { const _p = await pausedBy(session.venueSlug); if (_p) return sendPaused(res, _p); }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e) {} }

  // New format: {artist, date, camera} — stores structured JSON passthrough
  // Legacy format: {artistName} plain string — used by dashboard sub-asset uploads
  const artist     = (body?.artist || '').toString().trim().toUpperCase();
  const date       = (body?.date   || new Date().toISOString().slice(0, 10)).toString().trim();
  const camera     = (body?.camera || 'MASTER').toString().trim().toUpperCase();
  const legacyName = (req.query.artistName || body?.artistName || body?.passthrough || '').toString().trim().toUpperCase();

  let passthrough;
  if (artist) {
    passthrough = JSON.stringify({ artist, date, camera });
  } else {
    passthrough = legacyName || 'SESSION_ARCHIVE';
  }

  const isAudio    = camera === 'AUDIO' || passthrough.includes('// AUDIO') || passthrough.includes('/AUDIO');
  // The title in Cloud Storage, like every other recording: "STAN LODGE // MASTER — 17 OCT 2026"
  const d = new Date(date + 'T12:00:00Z');
  const dateStr = isNaN(d) ? date : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).toUpperCase();
  const videoTitle = (artist ? artist + ' // ' + camera : legacyName || 'SESSION') + ' — ' + dateStr;

  try {
    const muxRes = await fetch('https://api.mux.com/video/v1/uploads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: session.muxAuth },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        new_asset_settings: {
          playback_policy: ['public'],
          // Basic (free to encode) unless Premium is on for the account in Accounts
          video_quality: await videoQuality(session?.venueSlug),
          passthrough: passthrough,
          meta: { title: videoTitle.slice(0, 512) },
          static_renditions: [{ resolution: isAudio ? 'audio-only' : 'highest' }],
          // 4K uploads are kept in 4K (else Mux stores 1080p), so vertical clips cut from them stay sharp
          ...(isAudio ? {} : { max_resolution_tier: '2160p' }),
        },
        cors_origin: 'https://local-assets.com',
      }),
    });

    const result = await muxRes.json();
    if (!muxRes.ok) return res.status(muxRes.status).json({ error: result.error || result });

    return res.status(200).json({ url: result.data.url, id: result.data.id });
  } catch (e) {
    console.error('[get-upload-url]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
