export default async function handler(req, res) {
  // CORS & Security
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.headers['x-api-key'] !== process.env.LOCAL_ASSETS_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized Infrastructure' }); // Fixed the 401
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
          mp4_support: 'standard', // For HQ Audio/Master
          video_quality: 'premium', 
          generated_subtitles: [{ name: "English", language_code: "en" }] // Bonus: For Social
        },
        cors_origin: '*' 
      }),
    });

    const data = await response.json();
    return res.status(200).json(data.data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
