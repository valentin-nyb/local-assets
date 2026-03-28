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
        playback_policy: ['public'],
        static_renditions: 'request' 
      },
      cors_origin: '*',
    });

    // We return exactly what the next-video JSON needs
    return res.status(200).json({ 
      uploadId: upload.id, 
      url: upload.url 
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}