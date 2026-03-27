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
        // 'plus' or 'high_definition' is required for AI Reframing features
        video_quality: 'plus', 
        generated_subtitles: [{ language_code: 'en', name: 'Internal_AI' }],
        // This enables the AI to scan for highlights
        static_renditions: 'request'
      },
      cors_origin: '*',
    });

    res.status(200).json({ url: upload.url, id: upload.id });
  } catch (error) {
    console.error('Mux Error:', error);
    res.status(500).json({ error: error.message || "Check Vercel Logs for Mux Auth Error" });
  }
}
