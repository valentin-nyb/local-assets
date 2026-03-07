// Vercel Serverless Function: /api/get-upload-url
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Optional: API key check
  if (process.env.API_KEY && req.headers['x-api-key'] !== process.env.API_KEY) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const muxTokenId = process.env.MUX_TOKEN_ID;
  const muxTokenSecret = process.env.MUX_TOKEN_SECRET;
  if (!muxTokenId || !muxTokenSecret) {
    res.status(500).json({ error: 'Mux credentials not set' });
    return;
  }

  try {
    const muxRes = await fetch('https://api.mux.com/video/v1/uploads', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(muxTokenId + ':' + muxTokenSecret).toString('base64'),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        new_asset_settings: { playback_policy: ['public'], mp4_support: 'standard' },
        cors_origin: '*'
      })
    });
    const data = await muxRes.json();
    res.status(200).json(data.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
