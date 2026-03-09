// Helper to create a Mux asset from a remote URL
async function createMuxAssetFromUrl(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.headers['x-api-key'] !== process.env.LOCAL_ASSETS_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized Infrastructure' });
  }
  let url;
  try {
    url = req.body.url;
    if (!url) throw new Error('Missing url');
  } catch (e) {
    return res.status(400).json({ error: 'Invalid or missing url in body' });
  }
  try {
    const response = await fetch('https://api.mux.com/video/v1/assets', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${Buffer.from(`${process.env.MUX_TOKEN_ID}:${process.env.MUX_TOKEN_SECRET}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        inputs: [{ url }],
        playback_policies: ['public'],
        video_quality: 'basic',
      }),
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

// Unified handler for all logic
export default async function handler(req, res) {
  // CORS & Security
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');

  // Handle browser Preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Auth check
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== process.env.LOCAL_ASSETS_API_KEY) {
    console.error("Auth Failure: Received", apiKey);
    return res.status(401).json({ error: 'Unauthorized Infrastructure' });
  }

  // If directAsset=1, use the new direct asset creation endpoint
  if (req.method === 'POST' && req.query.directAsset === '1') {
    return await createMuxAssetFromUrl(req, res);
  }

  // Default: create upload URL
  try {
    const response = await fetch('https://api.mux.com/video/v1/uploads', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${Buffer.from(`${process.env.MUX_TOKEN_ID}:${process.env.MUX_TOKEN_SECRET}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        new_asset_settings: { 
          playback_policy: ['public'],
          mp4_support: 'standard',
          video_quality: 'premium',
          generated_subtitles: [{ name: "English", language_code: "en" }]
        },
        cors_origin: '*'
      }),
    });

    let data = null;
    let text = null;
    try {
      text = await response.text();
      data = JSON.parse(text);
    } catch (err) {
      return res.status(500).json({ error: 'Mux API returned invalid JSON', raw: text });
    }
    if (!response.ok || !data || !data.data) {
      return res.status(response.status || 500).json({ error: (data && data.error) || 'Failed to get upload URL from Mux', raw: data });
    }
    return res.status(200).json(data.data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
// New endpoint: POST /api/get-upload-url?directAsset=1 with JSON { url }
// Creates a Mux asset directly from a remote video URL
export async function createMuxAssetFromUrl(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.headers['x-api-key'] !== process.env.LOCAL_ASSETS_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized Infrastructure' });
  }
  let url;
  try {
    url = req.body.url;
    if (!url) throw new Error('Missing url');
  } catch (e) {
    return res.status(400).json({ error: 'Invalid or missing url in body' });
  }
  try {
    const response = await fetch('https://api.mux.com/video/v1/assets', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${Buffer.from(`${process.env.MUX_TOKEN_ID}:${process.env.MUX_TOKEN_SECRET}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        inputs: [{ url }],
        playback_policies: ['public'],
        video_quality: 'basic',
      }),
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
export default async function handler(req, res) {
  // CORS & Security
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.headers['x-api-key'] !== process.env.LOCAL_ASSETS_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized Infrastructure' });
  }

  // If directAsset=1, use the new direct asset creation endpoint
  if (req.method === 'POST' && req.query.directAsset === '1') {
    return await createMuxAssetFromUrl(req, res);
  }

  try {
    const response = await fetch('https://api.mux.com/video/v1/uploads', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${Buffer.from(`${process.env.MUX_TOKEN_ID}:${process.env.MUX_TOKEN_SECRET}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        new_asset_settings: { 
          playback_policy: ['public'],
          mp4_support: 'standard',
          video_quality: 'premium',
          generated_subtitles: [{ name: "English", language_code: "en" }]
        },
        cors_origin: '*'
      }),
    });

    let data = null;
    let text = null;
    try {
      text = await response.text();
      data = JSON.parse(text);
    } catch (err) {
      return res.status(500).json({ error: 'Mux API returned invalid JSON', raw: text });
    }
    if (!response.ok || !data || !data.data) {
      return res.status(response.status || 500).json({ error: (data && data.error) || 'Failed to get upload URL from Mux', raw: data });
    }
    return res.status(200).json(data.data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
