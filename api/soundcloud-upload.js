import { createClient } from 'redis';
import { getWebSessionAuth, getVenuesConfig } from './_venues.js';

// Large audio files need the full 300s window
export const config = { maxDuration: 300 };

async function refreshScToken(venueSlug, refreshToken) {
  const res = await fetch('https://secure.soundcloud.com/oauth/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     process.env.SOUNDCLOUD_CLIENT_ID,
      client_secret: process.env.SOUNDCLOUD_CLIENT_SECRET,
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.access_token) return null;

  const redis = createClient({ url: process.env.REDIS_URL });
  try {
    await redis.connect();
    await redis.set(`sc_tokens:${venueSlug}`, JSON.stringify({
      access_token:  data.access_token,
      refresh_token: data.refresh_token || refreshToken,
    }), { EX: 60 * 60 * 24 * 365 });
  } finally {
    await redis.quit().catch(() => {});
  }
  return data.access_token;
}

async function uploadToSoundCloud(accessToken, audioBuffer, audioPath, title) {
  const formData = new FormData();
  formData.append('track[title]',      title || 'Untitled Session');
  formData.append('track[sharing]',    'public');
  formData.append('track[asset_data]', new Blob([audioBuffer], { type: 'audio/mp4' }), audioPath);

  const scRes = await fetch('https://api.soundcloud.com/tracks', {
    method:  'POST',
    headers: {
      Accept:        'application/json; charset=utf-8',
      Authorization: `OAuth ${accessToken}`,
    },
    body:   formData,
    signal: AbortSignal.timeout(240000),
  });

  const rawText = await scRes.text();
  let scData;
  try { scData = JSON.parse(rawText); } catch(_) { scData = null; }
  return { scRes, scData, rawText };
}

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

  // Get venue name for filename
  const venues = getVenuesConfig();
  const venueConfig = venues[venueSlug] || {};
  const venueName = venueConfig.name || venueSlug;

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e) {} }
  const { playbackId, dlFile, title } = body || {};
  if (!playbackId) return res.status(400).json({ error: 'playbackId required' });

  const redis = createClient({ url: process.env.REDIS_URL });
  let accessToken, refreshToken;
  try {
    await redis.connect();
    const raw = await redis.get(`sc_tokens:${venueSlug}`);
    if (!raw) return res.status(400).json({ error: 'SoundCloud not connected — connect your account first' });
    ({ access_token: accessToken, refresh_token: refreshToken } = JSON.parse(raw));
  } catch (e) {
    return res.status(500).json({ error: 'Redis error: ' + e.message });
  } finally {
    await redis.quit().catch(() => {});
  }

  try {
    const audioPath = dlFile || 'audio.m4a';
    const audioUrl  = `https://stream.mux.com/${playbackId}/${audioPath}`;
    console.log(`[soundcloud-upload] fetching audio: ${audioUrl}`);

    const audioRes = await fetch(audioUrl, { signal: AbortSignal.timeout(120000) });
    if (!audioRes.ok) {
      return res.status(502).json({ error: `Could not fetch audio from Mux (${audioRes.status}) — static rendition may still be processing` });
    }

    const audioBuffer = Buffer.from(await audioRes.arrayBuffer());
    console.log(`[soundcloud-upload] uploading "${title}" — ${(audioBuffer.length / 1048576).toFixed(1)} MB`);

    let { scRes, scData, rawText } = await uploadToSoundCloud(accessToken, audioBuffer, audioPath, title);

    // On 401, try once with a refreshed token
    if (scRes.status === 401 && refreshToken) {
      console.log('[soundcloud-upload] 401 — attempting token refresh');
      const newToken = await refreshScToken(venueSlug, refreshToken);
      if (newToken) {
        console.log('[soundcloud-upload] token refreshed, retrying upload');
        ({ scRes, scData, rawText } = await uploadToSoundCloud(newToken, audioBuffer, audioPath, title));
      }
    }

    if (!scRes.ok) {
      const errBody = scData?.errors?.[0]?.error_message || scData?.error || rawText.trim().slice(0, 200);
      const msg = `SC ${scRes.status}${errBody ? ': ' + errBody : ' — token may need reconnecting'}`;
      console.error(`[soundcloud-upload] failed:`, msg);
      return res.status(scRes.status < 600 ? scRes.status : 502).json({ error: msg });
    }

    console.log(`[soundcloud-upload] uploaded: ${scData?.permalink_url}`);
    return res.status(200).json({
      trackId: scData?.id,
      url:     scData?.permalink_url,
      title:   scData?.title,
    });
  } catch (e) {
    console.error('[soundcloud-upload] unexpected error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
