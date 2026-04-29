import { kv } from '@vercel/kv';

// Large audio files need the full 300s window
export const config = { maxDuration: 300 };

function parseCookie(str) {
  const obj = {};
  if (!str) return obj;
  str.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx < 0) return;
    obj[pair.substring(0, idx).trim()] = decodeURIComponent(pair.substring(idx + 1).trim());
  });
  return obj;
}

async function tryRefresh(clientId, refreshToken) {
  if (!refreshToken) return null;
  const res = await fetch('https://api.soundcloud.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      client_id: process.env.SOUNDCLOUD_CLIENT_ID,
      client_secret: process.env.SOUNDCLOUD_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.access_token) return null;
  await kv.hset(`client:${clientId}`, {
    soundcloudToken: data.access_token,
    soundcloudRefreshToken: data.refresh_token || refreshToken,
  });
  return data.access_token;
}

async function uploadToSoundCloud(token, audioBuffer, title) {
  const formData = new FormData();
  formData.append('track[title]', title);
  formData.append('track[sharing]', 'public');
  formData.append('track[asset_data]', new Blob([audioBuffer], { type: 'audio/mp4' }), 'audio.m4a');

  return fetch('https://api.soundcloud.com/tracks.json', {
    method: 'POST',
    headers: { Authorization: `OAuth ${token}` },
    body: formData,
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://local-assets.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Cookie');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const cookie = parseCookie(req.headers.cookie || '');
  const sessionToken = cookie.la_session;
  if (!sessionToken) return res.status(401).json({ error: 'Not authenticated' });

  const clientId = await kv.get(`session:${sessionToken}`);
  if (!clientId) return res.status(401).json({ error: 'Session expired' });

  const profile = await kv.hgetall(`client:${clientId}`);
  if (!profile?.soundcloudToken) {
    return res.status(400).json({ error: 'SoundCloud not connected — connect your account first' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e) {} }

  const { playbackId, title } = body || {};
  if (!playbackId) return res.status(400).json({ error: 'playbackId required' });

  // Fetch audio from Mux static rendition
  const audioUrl = `https://stream.mux.com/${playbackId}/audio.m4a`;
  const audioRes = await fetch(audioUrl);
  if (!audioRes.ok) {
    return res.status(502).json({ error: `Could not fetch audio from Mux (${audioRes.status}) — static rendition may still be processing` });
  }

  const audioBuffer = Buffer.from(await audioRes.arrayBuffer());
  console.log(`[SoundCloud] Uploading "${title}" — ${(audioBuffer.length / 1048576).toFixed(1)}MB`);

  let token = profile.soundcloudToken;
  let scRes = await uploadToSoundCloud(token, audioBuffer, title || 'Untitled Session');

  // Token expired — try refreshing once
  if (scRes.status === 401 && profile.soundcloudRefreshToken) {
    const newToken = await tryRefresh(clientId, profile.soundcloudRefreshToken);
    if (newToken) {
      token = newToken;
      scRes = await uploadToSoundCloud(token, audioBuffer, title || 'Untitled Session');
    }
  }

  const scData = await scRes.json();

  if (!scRes.ok) {
    const msg = scData?.errors?.[0]?.error_message || scData?.error || JSON.stringify(scData);
    console.error(`[SoundCloud] Upload failed (${scRes.status}):`, msg);
    return res.status(scRes.status).json({ error: msg });
  }

  console.log(`[SoundCloud] Uploaded: ${scData.permalink_url}`);
  return res.status(200).json({
    trackId: scData.id,
    url: scData.permalink_url,
    title: scData.title,
  });
}
