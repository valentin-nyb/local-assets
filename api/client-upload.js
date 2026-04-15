import { kv } from '@vercel/kv';

const TOKEN_ID = (process.env.PROD_MUX_TOKEN_ID || process.env.MUX_TOKEN_ID || '').trim();
const TOKEN_SECRET = (process.env.PROD_MUX_TOKEN_SECRET || process.env.MUX_TOKEN_SECRET || '').trim();
const AUTH = Buffer.from(`${TOKEN_ID}:${TOKEN_SECRET}`).toString('base64');

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Cookie');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  // Authenticate
  const cookie = parseCookie(req.headers.cookie || '');
  const sessionToken = cookie.la_session;
  if (!sessionToken) return res.status(401).json({ error: 'Not authenticated' });

  const clientId = await kv.get(`session:${sessionToken}`);
  if (!clientId) return res.status(401).json({ error: 'Session expired' });

  const profile = await kv.hgetall(`client:${clientId}`);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e) {} }

  const artistName = (body?.artistName || '').trim().toUpperCase();
  if (!artistName) return res.status(400).json({ error: 'artistName is required' });

  const isAudio = artistName.includes('// AUDIO');
  const srResolution = isAudio ? 'audio-only' : 'highest';
  const dateStr = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase();
  const videoTitle = artistName + ' — ' + dateStr;

  try {
    const muxRes = await fetch('https://api.mux.com/video/v1/uploads', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${AUTH}`
      },
      body: JSON.stringify({
        new_asset_settings: {
          playback_policies: ['public'],
          passthrough: artistName,
          name: videoTitle,
          static_renditions: [{ resolution: srResolution }]
        },
        cors_origin: '*'
      })
    });

    const result = await muxRes.json();
    if (!muxRes.ok) {
      console.error('Client upload creation failed:', JSON.stringify(result));
      return res.status(muxRes.status).json({ error: result.error || result });
    }

    const upload = result.data;

    // Track this asset ID in the client's profile
    let assetIds = [];
    try { assetIds = JSON.parse(profile.assets || '[]'); } catch(e) {}
    if (upload.asset_id) {
      assetIds.push(upload.asset_id);
      await kv.hset(`client:${clientId}`, { assets: JSON.stringify(assetIds) });
    }

    // Also store the asset prefix for this client (for matching future assets)
    const prefix = artistName.split('//')[0].trim();
    if (prefix && !profile.assetPrefix) {
      await kv.hset(`client:${clientId}`, { assetPrefix: prefix });
    }

    return res.status(200).json({ url: upload.url, id: upload.id });
  } catch (error) {
    console.error('Client upload error:', error);
    return res.status(500).json({ error: error.message });
  }
}

function parseCookie(str) {
  const obj = {};
  if (!str) return obj;
  str.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx < 0) return;
    const key = pair.substring(0, idx).trim();
    const val = pair.substring(idx + 1).trim();
    obj[key] = decodeURIComponent(val);
  });
  return obj;
}
