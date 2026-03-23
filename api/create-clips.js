// Function to trigger 12-part clipping

import { muxProxyFetch } from '../mux-proxy-client.js';

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
  if (!process.env.MUX_PROXY_BASE_URL) {
    res.status(500).json({ error: 'MUX_PROXY_BASE_URL not set' });
    return;
  }
  const clipDuration = duration / 12; // Split into 12 parts
  const clips = [];
  for (let i = 0; i < 12; i++) {
    const startTime = i * clipDuration;
    const clipRequest = await muxProxyFetch('/video/v1/assets', {
      method: 'POST',
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
