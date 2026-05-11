import { getClientSession, getMuxAuth } from './_client-auth.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://local-assets.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Cookie');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const session = await getClientSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const { auth } = getMuxAuth(session.profile);

  const { masterAssetId, duration } = req.body;
  if (!masterAssetId || !duration) return res.status(400).json({ error: 'Missing masterAssetId or duration' });

  const clipDuration = duration / 12;
  const clips = [];

  for (let i = 0; i < 12; i++) {
    const startTime = i * clipDuration;
    const r = await fetch('https://api.mux.com/video/v1/assets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
      body: JSON.stringify({
        input: [{ url: `mux://assets/${masterAssetId}`, start_time: startTime, duration: Math.min(60, clipDuration) }],
        new_asset_settings: { playback_policy: ['public'], video_quality: 'premium', master_access: 'temporary' }
      })
    });
    const data = await r.json();
    if (!r.ok || !data.data) return res.status(500).json({ error: data.error || 'Failed to create clip' });
    clips.push(data.data.id);
  }

  return res.status(200).json({ success: true, clipIds: clips });
}
