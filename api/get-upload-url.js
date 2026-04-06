import Mux from '@mux/mux-node';

const mux = new Mux({
  tokenId: (process.env.PROD_MUX_TOKEN_ID || process.env.MUX_TOKEN_ID || '').trim(),
  tokenSecret: (process.env.PROD_MUX_TOKEN_SECRET || process.env.MUX_TOKEN_SECRET || '').trim()
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Try to find the name in query params OR the request body
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch(e) {}
  }
  const artistName = req.query.artistName || (body && body.artistName) || (body && body.passthrough) || 'SESSION_ARCHIVE';

  try {
    const upload = await mux.video.uploads.create({
      new_asset_settings: { 
        playback_policy: ['public'],
        passthrough: String(artistName).toUpperCase(),
        static_renditions: [{ resolution: 'highest' }]
      },
      cors_origin: '*',
    });
    return res.status(200).json({ url: upload.url, id: upload.id });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}