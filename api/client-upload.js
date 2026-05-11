import { getClientSession, getMuxAuth } from './_client-auth.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://local-assets.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Cookie');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const session = await getClientSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const { auth } = getMuxAuth(session.profile);

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e) {} }

  const artistName = (body?.artistName || '').trim().toUpperCase();
  if (!artistName) return res.status(400).json({ error: 'artistName is required' });

  const isAudio = artistName.includes('// AUDIO');
  const dateStr = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase();
  const videoTitle = artistName + ' — ' + dateStr;

  try {
    const muxRes = await fetch('https://api.mux.com/video/v1/uploads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
      body: JSON.stringify({
        new_asset_settings: {
          playback_policies: ['public'],
          passthrough: artistName,
          name: videoTitle,
          static_renditions: [{ resolution: isAudio ? 'audio-only' : 'highest' }]
        },
        cors_origin: '*'
      })
    });

    const result = await muxRes.json();
    if (!muxRes.ok) return res.status(muxRes.status).json({ error: result.error || result });

    return res.status(200).json({ url: result.data.url, id: result.data.id });
  } catch (error) {
    console.error('Client upload error:', error);
    return res.status(500).json({ error: error.message });
  }
}
