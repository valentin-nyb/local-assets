import Mux from '@mux/mux-node';

// Initialize Mux with the DEFINITIVE keys
const mux = new Mux({
  tokenId: process.env.MUX_TOKEN_ID,
  tokenSecret: process.env.MUX_TOKEN_SECRET
});

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  try {
    console.log("Attempting to create Mux upload...");

    const upload = await mux.video.uploads.create({
      new_asset_settings: {
        playback_policy: 'public',
        static_renditions: 'request'
      },
      cors_origin: '*',
    });

    console.log("Mux Upload Created:", upload.id);
    return res.status(200).json({ url: upload.url, id: upload.id });

  } catch (error) {
    console.error('CRITICAL MUX ERROR:', error.message);
    return res.status(500).json({ error: "Check Vercel Logs for Mux Auth Error" });
  }
}
