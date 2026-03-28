import Mux from '@mux/mux-node';

const mux = new Mux({
  tokenId: (process.env.assets_MUX_TOKEN_ID || '').trim(),
  tokenSecret: (process.env.assets_MUX_TOKEN_SECRET || '').trim()
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const upload = await mux.video.uploads.create({
      new_asset_settings: { 
        playback_policy: ['public'], // <-- THE COMMA MUST BE HERE
        video_quality: 'plus',       // This line was causing the error
        static_renditions: 'request' 
      },
      cors_origin: '*',
    });
    return res.status(200).json({ url: upload.url, id: upload.id });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}