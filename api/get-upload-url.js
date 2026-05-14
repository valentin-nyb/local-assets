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
    return res.status(401).json({ error: 'Not authenticated — no Mux credentials for this account' });
  }

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
  const videoTitle = (artist || legacyName || 'SESSION') + ' — ' + date;

  try {
    const muxRes = await fetch('https://api.mux.com/video/v1/uploads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: session.muxAuth },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        new_asset_settings: {
          playback_policy: ['public'],
          passthrough: passthrough,
          name: videoTitle,
          static_renditions: [{ resolution: isAudio ? 'audio-only' : 'highest' }],
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
