import Mux from '@mux/mux-node';

// Initialize SDK with Vercel Environment Variables
const mux = new Mux({
  tokenId: process.env.MUX_TOKEN_ID,
  tokenSecret: process.env.MUX_TOKEN_SECRET
});

export default async function handler(req, res) {
  // 1. Mandatory CORS Headers for Vercel
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');

  // 2. Handle Browser Preflight
  if (req.method === 'OPTIONS') return res.status(200).end();

  // 3. Infrastructure Key Validation
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== process.env.LOCAL_ASSETS_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized Infrastructure' });
  }

  try {
    // 4. Create Direct Upload URL via Official SDK
    const upload = await mux.video.uploads.create({
      new_asset_settings: {
        playback_policy: ['public'],
        mp4_support: 'standard', // For HQ Audio extraction
        master_access: 'temporary' // Required for your 12-part social clips
      },
      cors_origin: '*' // Essential for direct browser-to-mux streaming
    });

    return res.status(200).json(upload);
  } catch (error) {
    // Enhanced error logging for debugging
    console.error("MUX_SDK_CRASH:", error);
    console.error("MUX_ENV", {
      MUX_TOKEN_ID: process.env.MUX_TOKEN_ID,
      MUX_TOKEN_SECRET: process.env.MUX_TOKEN_SECRET,
      LOCAL_ASSETS_API_KEY: process.env.LOCAL_ASSETS_API_KEY ? 'set' : 'missing'
    });
    return res.status(500).json({ 
      error: 'Mux Communication Failed', 
      message: error.message,
      stack: error.stack,
      mux_env: {
        MUX_TOKEN_ID: process.env.MUX_TOKEN_ID,
        MUX_TOKEN_SECRET: process.env.MUX_TOKEN_SECRET ? 'set' : 'missing',
        LOCAL_ASSETS_API_KEY: process.env.LOCAL_ASSETS_API_KEY ? 'set' : 'missing'
      }
    });
  }
}
