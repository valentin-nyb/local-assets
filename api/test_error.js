import Mux from '@mux/mux-node';

const mux = new Mux({
  tokenId: process.env.MUX_TOKEN_ID,
  tokenSecret: process.env.MUX_TOKEN_SECRET
});

export default async function handler(req, res) {
  try {
    const upload = await mux.video.uploads.create({
      new_asset_settings: {
        playback_policy: ['public'],
        video_quality: 'plus',
        generated_subtitles: [{ language_code: 'en', name: 'Internal_AI' }]
      },
      cors_origin: '*',
    });
    res.status(200).json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.messages || error.message || error });
  }
}
