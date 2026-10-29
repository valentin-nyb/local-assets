import { pausedBy, sendPaused } from './_suspend.js';
import { createClient } from 'redis';
import { getWebSessionAuth, getVenuesConfig } from './_venues.js';
import { refreshScToken } from './_soundcloud.js';

// Large audio files need the full 300s window
export const config = { maxDuration: 300 };

// Publish details from the dashboard, cleaned to SoundCloud's fields: description, one genre, tags
// (multi-word tags quoted), record label, release date, visibility and artwork
function soundcloudDetails(meta, fallbackTitle) {
  const m = meta && typeof meta === 'object' ? meta : {};
  const clean = (v, max) => String(v ?? '').replace(/[<>]/g, '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, max);
  const tags = [...new Set((Array.isArray(m.tags) ? m.tags : []).map(t => clean(t, 40).replace(/"/g, '')).filter(Boolean))].slice(0, 30);
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(m.recordingDate || ''));
  return {
    title: clean(m.title || fallbackTitle || 'Untitled Session', 100) || 'Untitled Session',
    description: clean(m.description, 4000),
    genre: clean(m.genre, 40),
    tagList: tags.map(t => t.includes(' ') ? `"${t}"` : t).join(' '),
    label: clean(m.label, 60),
    date,
    sharing: m.privacy === 'private' ? 'private' : 'public',
    artwork: typeof m.artwork === 'string' && /^https:\/\/([a-z0-9]+\.public\.blob\.vercel-storage\.com|image\.mux\.com)\//i.test(m.artwork) ? m.artwork : null,
  };
}

async function uploadToSoundCloud(accessToken, audioBuffer, audioPath, d, artwork) {
  const formData = new FormData();
  formData.append('track[title]',      d.title);
  formData.append('track[sharing]',    d.sharing);
  if (d.description) formData.append('track[description]', d.description);
  if (d.genre) formData.append('track[genre]', d.genre);
  if (d.tagList) formData.append('track[tag_list]', d.tagList);
  if (d.label) formData.append('track[label_name]', d.label);
  if (d.date) { formData.append('track[release_year]', d.date[1]); formData.append('track[release_month]', String(Number(d.date[2]))); formData.append('track[release_day]', String(Number(d.date[3]))); }
  if (artwork) formData.append('track[artwork_data]', new Blob([artwork.buf], { type: artwork.type }), artwork.name);
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
  if (session.member) return res.status(403).json({ error: 'Only the account can do this' });
  if (req.method !== 'GET' && session?.venueSlug) { const _p = await pausedBy(session.venueSlug); if (_p) return sendPaused(res, _p); }

  const venueSlug = session.venueSlug;
  if (!venueSlug) return res.status(403).json({ error: 'No venue associated with this account' });

  // Get venue name for filename
  const venues = getVenuesConfig();
  const venueConfig = venues[venueSlug] || {};
  const venueName = venueConfig.name || venueSlug;

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e) {} }
  const { playbackId, dlFile, title, meta } = body || {};
  const details = soundcloudDetails(meta, title);
  if (!playbackId) return res.status(400).json({ error: 'playbackId required' });

  const redis = createClient({ url: (process.env.UPSTASH_REDIS_URL || process.env.REDIS_URL) });
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
      return res.status(502).json({ error: `Could not fetch the audio from Cloud Storage (${audioRes.status}) — it may still be processing` });
    }

    const audioBuffer = Buffer.from(await audioRes.arrayBuffer());
    console.log(`[soundcloud-upload] uploading "${details.title}" (${details.sharing}, ${details.genre || 'no genre'}) — ${(audioBuffer.length / 1048576).toFixed(1)} MB`);

    // The session's thumbnail as the track's artwork (from Brand Kit / Cloud Storage only)
    let artwork = null;
    if (details.artwork) {
      try {
        const ar = await fetch(details.artwork, { signal: AbortSignal.timeout(20000) });
        const type = ar.headers.get('content-type') || '';
        const buf = ar.ok && /^image\/(jpeg|png)/.test(type) ? Buffer.from(await ar.arrayBuffer()) : null;
        if (buf && buf.length < 8 * 1024 * 1024) artwork = { buf, type: type.split(';')[0], name: type.includes('png') ? 'artwork.png' : 'artwork.jpg' };
      } catch (e) { console.error('[soundcloud-upload] artwork skipped:', e.message); }
    }
    let { scRes, scData, rawText } = await uploadToSoundCloud(accessToken, audioBuffer, audioPath, details, artwork);

    // On 401, try once with a refreshed token
    if (scRes.status === 401 && refreshToken) {
      console.log('[soundcloud-upload] 401 — attempting token refresh');
      const newToken = await refreshScToken(venueSlug, refreshToken);
      if (newToken) {
        console.log('[soundcloud-upload] token refreshed, retrying upload');
        ({ scRes, scData, rawText } = await uploadToSoundCloud(newToken, audioBuffer, audioPath, details, artwork));
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
