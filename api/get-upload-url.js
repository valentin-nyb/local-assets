import Mux from '@mux/mux-node';

const mux = new Mux({
  tokenId: process.env.MUX_TOKEN_ID,
  tokenSecret: process.env.MUX_TOKEN_SECRET
});

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Use POST');

  try {
    const upload = await mux.video.uploads.create({
      new_asset_settings: {
        playback_policy: ['public'],
        // Let's remove video_quality, generated_subtitles, and static_renditions 
        // to isolate the 400 Bad Request error.
      },
      cors_origin: '*',
    });

    res.status(200).json({ url: upload.url, id: upload.id });
  } catch (error) {
    console.error('Mux Error:', error);
    res.status(500).json({ error: error.message || "Check Vercel Logs for Mux Auth Error" });
  }
}
