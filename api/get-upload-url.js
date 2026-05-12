import { getWebSessionAuth } from './_venues.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://local-assets.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const session = getWebSessionAuth(req);
  if (!session?.muxAuth) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e) {} }

  const artistName = req.query.artistName || body?.artistName || body?.passthrough || 'SESSION_ARCHIVE';
  const isAudio    = String(artistName).toUpperCase().includes('// AUDIO');
  const dateStr    = new Date().toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric'
  }).toUpperCase();
  const videoTitle = String(artistName).toUpperCase() + ' — ' + dateStr;

  try {
    const muxRes = await fetch('https://api.mux.com/video/v1/uploads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: session.muxAuth },
      body: JSON.stringify({
        new_asset_settings: {
          playback_policy: ['public'],
          passthrough: String(artistName).toUpperCase().trim(),
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
