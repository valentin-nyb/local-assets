import Mux from '@mux/mux-node';

export default async function handler(req, res) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // DIAGNOSTIC: Check if keys exist
    const tokenId = process.env.assets_MUX_TOKEN_ID;
    const tokenSecret = process.env.assets_MUX_TOKEN_SECRET;

    if (!tokenId || !tokenSecret) {
      throw new Error("MISSING_KEYS: Vercel cannot see your Mux tokens. Check Env Vars.");
    }

    const mux = new Mux({
      tokenId: tokenId.trim(),
      tokenSecret: tokenSecret.trim()
    });

    const upload = await mux.video.uploads.create({
      new_asset_settings: { 
        playback_policy: ['public'],
        video_quality: 'plus', // Required for AI Reframing
        static_renditions: 'request' 
      },
      cors_origin: '*',
    });

    return res.status(200).json({ url: upload.url, id: upload.id });

  } catch (error) {
    // This sends the ACTUAL error message to your browser
    console.error("SERVER_CRASH:", error.message);
    return res.status(500).json({ 
      error: error.message,
      stack: error.stack,
      hint: "Check if @mux/mux-node is in package.json"
    });
  }
}