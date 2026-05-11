import { getClientSession, getMuxAuth } from './_client-auth.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://local-assets.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Cookie');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const session = await getClientSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const { auth } = getMuxAuth(session.profile);

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e) {} }

  const artistName = req.query.artistName || body?.artistName || body?.passthrough || 'SESSION_ARCHIVE';
  const isAudio = String(artistName).toUpperCase().includes('// AUDIO');
  const dateStr = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase();
  const videoTitle = String(artistName).toUpperCase() + ' — ' + dateStr;

  try {
    const muxRes = await fetch('https://api.mux.com/video/v1/uploads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
      body: JSON.stringify({
        new_asset_settings: {
          playback_policies: ['public'],
          passthrough: String(artistName).toUpperCase().trim(),
          name: videoTitle,
          static_renditions: [{ resolution: isAudio ? 'audio-only' : 'highest' }]
        },
        cors_origin: 'https://local-assets.com'
      })
    });

    const result = await muxRes.json();
    if (!muxRes.ok) return res.status(muxRes.status).json({ error: result.error || result });

    return res.status(200).json({ url: result.data.url, id: result.data.id });
  } catch (error) {
    console.error('get-upload-url error:', error);
    return res.status(500).json({ error: error.message });
  }
}
