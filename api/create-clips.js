// Function to trigger 12-part clipping
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const { masterAssetId, duration } = req.body;
  if (!masterAssetId || !duration) {
    res.status(400).json({ error: 'Missing masterAssetId or duration' });
    return;
  }
  const muxTokenId = process.env.MUX_TOKEN_ID;
  const muxTokenSecret = process.env.MUX_TOKEN_SECRET;
  if (!muxTokenId || !muxTokenSecret) {
    res.status(500).json({ error: 'Mux credentials not set' });
    return;
  }
  const clipDuration = duration / 12; // Split into 12 parts
  const clips = [];
  for (let i = 0; i < 12; i++) {
    const startTime = i * clipDuration;
    const clipRequest = await fetch('https://api.mux.com/video/v1/assets', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(muxTokenId + ':' + muxTokenSecret).toString('base64'),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: [{ 
          url: `mux://assets/${masterAssetId}`,
          start_time: startTime,
          duration: Math.min(60, clipDuration) // Max 60s for social
        }],
        new_asset_settings: {
          playback_policy: ['public'],
          video_quality: 'premium',
          master_access: 'temporary'
        }
      })
    });
    const data = await clipRequest.json();
    if (!clipRequest.ok || !data.data) {
      res.status(500).json({ error: data.error || 'Failed to create clip' });
      return;
    }
    clips.push(data.data.id);
  }
  res.status(200).json({ success: true, clipIds: clips });
}
