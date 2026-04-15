const TOKEN_ID = (process.env.PROD_MUX_TOKEN_ID || process.env.MUX_TOKEN_ID || '').trim();
const TOKEN_SECRET = (process.env.PROD_MUX_TOKEN_SECRET || process.env.MUX_TOKEN_SECRET || '').trim();
const AUTH = Buffer.from(`${TOKEN_ID}:${TOKEN_SECRET}`).toString('base64');

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch(e) {}
  }
  const artistName = req.query.artistName || (body && body.artistName) || (body && body.passthrough) || 'SESSION_ARCHIVE';

  const isAudio = String(artistName).toUpperCase().includes('// AUDIO');
  const srResolution = isAudio ? 'audio-only' : 'highest';
  const dateStr = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase();
  const videoTitle = String(artistName).toUpperCase() + ' \u2014 ' + dateStr;

  try {
    const muxRes = await fetch('https://api.mux.com/video/v1/uploads', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${AUTH}`
      },
      body: JSON.stringify({
        new_asset_settings: {
          playback_policies: ['public'],
          passthrough: String(artistName).toUpperCase().trim(),
          name: videoTitle,
          static_renditions: [{ resolution: srResolution }]
        },
        cors_origin: '*'
      })
    });

    const result = await muxRes.json();
    if (!muxRes.ok) {
      console.error('Mux upload creation failed:', JSON.stringify(result));
      return res.status(muxRes.status).json({ error: result.error || result });
    }

    const upload = result.data;
    return res.status(200).json({ url: upload.url, id: upload.id });
  } catch (error) {
    console.error('get-upload-url error:', error);
    return res.status(500).json({ error: error.message });
  }
}