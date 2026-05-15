import { createClient } from 'redis';
import { getWebSessionAuth } from './_venues.js';

// Large audio files need the full 300s window
export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://local-assets.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-Email');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const session = getWebSessionAuth(req);
  if (!session?.email) return res.status(401).json({ error: 'Not authenticated' });

  const venueSlug = session.venueSlug;
  if (!venueSlug) return res.status(403).json({ error: 'No venue associated with this account' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e) {} }
  const { playbackId, dlFile, title } = body || {};
  if (!playbackId) return res.status(400).json({ error: 'playbackId required' });

  const redis = createClient({ url: process.env.REDIS_URL });
  await redis.connect();
  let accessToken;
  try {
    const raw = await redis.get(`sc_tokens:${venueSlug}`);
    if (!raw) return res.status(400).json({ error: 'SoundCloud not connected — connect your account first' });
    ({ access_token: accessToken } = JSON.parse(raw));
  } finally {
    await redis.quit();
  }

  // Fetch audio from Mux static rendition
  const audioPath = dlFile || 'audio.m4a';
  const audioUrl  = `https://stream.mux.com/${playbackId}/${audioPath}`;
  console.log(`[soundcloud-upload] fetching audio: ${audioUrl}`);
  const audioRes = await fetch(audioUrl, { signal: AbortSignal.timeout(120000) });
  if (!audioRes.ok) {
    return res.status(502).json({ error: `Could not fetch audio from Mux (${audioRes.status}) — static rendition may still be processing` });
  }

  const audioBuffer = Buffer.from(await audioRes.arrayBuffer());
  console.log(`[soundcloud-upload] uploading "${title}" — ${(audioBuffer.length / 1048576).toFixed(1)} MB`);

  const formData = new FormData();
  formData.append('track[title]',      title || 'Untitled Session');
  formData.append('track[sharing]',    'public');
  formData.append('track[asset_data]', new Blob([audioBuffer], { type: 'audio/x-m4a' }), audioPath);

  const scRes = await fetch('https://api.soundcloud.com/tracks.json', {
    method:  'POST',
    headers: { Authorization: `OAuth ${accessToken}` },
    body:    formData,
    signal:  AbortSignal.timeout(240000),
  });

  const scData = await scRes.json();
  if (!scRes.ok) {
    const msg = scData?.errors?.[0]?.error_message || scData?.error || JSON.stringify(scData);
    console.error(`[soundcloud-upload] failed (${scRes.status}):`, msg);
    return res.status(scRes.status).json({ error: msg });
  }

  console.log(`[soundcloud-upload] uploaded: ${scData.permalink_url}`);
  return res.status(200).json({
    trackId: scData.id,
    url:     scData.permalink_url,
    title:   scData.title,
  });
}
