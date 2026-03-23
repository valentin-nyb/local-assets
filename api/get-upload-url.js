import Mux from '@mux/mux-node';

const mux = new Mux({
  tokenId: process.env.MUX_TOKEN_ID,
  tokenSecret: process.env.MUX_TOKEN_SECRET
});

export default async function handler(req, res) {
  // 1. Mandatory CORS Headers for Vercel
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');

  // 2. Handle Browser Preflight
  if (req.method === 'OPTIONS') return res.status(200).end();
  
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const upload = await mux.video.uploads.create({
      new_asset_settings: { 
        playback_policy: ['public'],
        mp4_support: 'standard',
        master_access: 'temporary'
      },
      cors_origin: '*', // Allows your frontend to upload directly
    });

    // Return the single Mux Upload URL
    res.status(200).json({ url: upload.url, id: upload.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
