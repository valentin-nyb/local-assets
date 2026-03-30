import Mux from '@mux/mux-node';

const mux = new Mux({
  tokenId: (process.env.PROD_MUX_TOKEN_ID || '').trim(),
  tokenSecret: (process.env.PROD_MUX_TOKEN_SECRET || '').trim()
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Get the artist name from the web request
  const { artistName } = req.query;

  try {
    const upload = await mux.video.uploads.create({
      new_asset_settings: { 
        playback_policy: ['public'],
        video_quality: 'plus',
        master_access: 'preview',
        // This labels the video in Mux with the Artist Name
        passthrough: artistName || 'UNKNOWN_SESSION'
      },
      cors_origin: '*',
    });
    return res.status(200).json({ url: upload.url, id: upload.id });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}