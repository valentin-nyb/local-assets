import Mux from '@mux/mux-node';

export default async function handler(req, res) {
  // Add CORS headers to allow cross-origin requests
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') return res.status(405).send('Use POST');

  if (!process.env.MUX_TOKEN_ID || !process.env.MUX_TOKEN_SECRET) {
    return res.status(500).json({ error: 'Missing MUX_TOKEN_ID or MUX_TOKEN_SECRET environment variables on the Vercel server.' });
  }

  try {
    const mux = new Mux({
      tokenId: process.env.MUX_TOKEN_ID,
      tokenSecret: process.env.MUX_TOKEN_SECRET
    });

    const upload = await mux.video.uploads.create({
      new_asset_settings: {
        playback_policy: ['public']
      },
      cors_origin: '*',
    });

    res.status(200).json({ url: upload.url, id: upload.id });
  } catch (error) {
    console.error('Mux Error full:', error);
    res.status(500).json({ error: error.message || 'Unknown Mux Error', stack: error.stack, full: JSON.stringify(error) });
  }
}