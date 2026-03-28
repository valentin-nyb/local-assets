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
        // NOTE: The comma above is vital. 
        // We add the AI quality here to enable your 12-clip requirement
        video_quality: 'plus' 
      },
      cors_origin: '*',
    });

    return res.status(200).json({ 
      url: upload.url, 
      id: upload.id 
    });
  } catch (error) {
    console.error('SERVER_ERROR:', error.message);
    return res.status(500).json({ error: error.message });
  }
}