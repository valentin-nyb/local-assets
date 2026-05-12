export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://local-assets.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const tokenId     = process.env.PROD_MUX_TOKEN_ID     || process.env.MUX_TOKEN_ID;
  const tokenSecret = process.env.PROD_MUX_TOKEN_SECRET || process.env.MUX_TOKEN_SECRET;
  if (!tokenId || !tokenSecret) {
    return res.status(500).json({ error: 'Mux credentials not configured' });
  }
  const auth = 'Basic ' + Buffer.from(`${tokenId}:${tokenSecret}`).toString('base64');

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
      headers: { 'Content-Type': 'application/json', Authorization: auth },
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
