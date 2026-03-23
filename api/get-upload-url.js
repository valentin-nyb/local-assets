import { muxProxyFetch } from '../mux-proxy-client.js';

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
    const muxResponse = await muxProxyFetch('/video/v1/uploads', {
      method: 'POST',
      body: JSON.stringify({
        new_asset_settings: {
          playback_policy: ['public'],
          mp4_support: 'standard',
          master_access: 'temporary'
        },
        cors_origin: '*'
      })
    });

    const upload = await muxResponse.json();

    if (!muxResponse.ok) {
      return res.status(muxResponse.status).json({
        error: 'Mux proxy request failed',
        message: upload.error?.message || upload.error || 'Unknown Mux proxy error'
      });
    }

    return res.status(200).json(upload);
  } catch (error) {
    console.error("MUX_SDK_CRASH:", error);
    console.error("MUX_ENV", {
      MUX_PROXY_BASE_URL: process.env.MUX_PROXY_BASE_URL,
      LOCAL_ASSETS_API_KEY: process.env.LOCAL_ASSETS_API_KEY ? 'set' : 'missing'
    });
    return res.status(500).json({ 
      error: 'Mux Communication Failed', 
      message: error.message,
      stack: error.stack,
      mux_env: {
        MUX_PROXY_BASE_URL: process.env.MUX_PROXY_BASE_URL || 'missing',
        LOCAL_ASSETS_API_KEY: process.env.LOCAL_ASSETS_API_KEY ? 'set' : 'missing'
      }
    });
  }
}
