import Mux from '@mux/mux-node';

const mux = new Mux({
  tokenId: process.env.MUX_TOKEN_ID,
  tokenSecret: process.env.MUX_TOKEN_SECRET,
});

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const upload = await mux.video.uploads.create({
      new_asset_settings: {
        playback_policy: ['public'],
        static_renditions: [{ name: 'low.mp4' }],
      },
      cors_origin: '*',
    });
    res.status(200).json({ url: upload.url, id: upload.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
