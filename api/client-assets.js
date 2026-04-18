import { kv } from '@vercel/kv';

const TOKEN_ID = (process.env.PROD_MUX_TOKEN_ID || process.env.MUX_TOKEN_ID || '').trim();
const TOKEN_SECRET = (process.env.PROD_MUX_TOKEN_SECRET || process.env.MUX_TOKEN_SECRET || '').trim();
const AUTH = Buffer.from(`${TOKEN_ID}:${TOKEN_SECRET}`).toString('base64');

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://local-assets.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Cookie');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Authenticate
  const cookie = parseCookie(req.headers.cookie || '');
  const sessionToken = cookie.la_session;
  if (!sessionToken) return res.status(401).json({ error: 'Not authenticated' });

  const clientId = await kv.get(`session:${sessionToken}`);
  if (!clientId) return res.status(401).json({ error: 'Session expired' });

  const profile = await kv.hgetall(`client:${clientId}`);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });

  // Get the client's passthrough prefix from their stored assets list
  // or use their email-based tag
  const clientTag = (profile.assetPrefix || profile.email.split('@')[0]).toUpperCase();

  try {
    // Fetch all assets from Mux
    const muxRes = await fetch('https://api.mux.com/video/v1/assets?limit=100', {
      headers: { Authorization: `Basic ${AUTH}` }
    });
    const result = await muxRes.json();
    if (!muxRes.ok) return res.status(500).json({ error: 'Failed to fetch assets' });

    const allAssets = result.data || [];

    // Filter assets belonging to this client
    // Match by passthrough prefix or by client's tagged assets
    let clientAssetIds = [];
    try {
      clientAssetIds = JSON.parse(profile.assets || '[]');
    } catch(e) {}

    const clientAssets = allAssets.filter(asset => {
      // Match by explicit asset ID list
      if (clientAssetIds.includes(asset.id)) return true;
      // Match by passthrough prefix
      const pt = (asset.passthrough || '').toUpperCase();
      if (pt && clientTag && pt.startsWith(clientTag)) return true;
      return false;
    });

    // Enrich with playback URLs and status
    const enriched = clientAssets.map(asset => {
      const playbackId = asset.playback_ids?.[0]?.id;
      const pt = (asset.passthrough || '').toUpperCase();
      let assetType = 'master';
      if (pt.includes('// AUDIO')) assetType = 'audio';
      else if (pt.includes('// SOCIAL')) assetType = 'social-clip';
      else if (pt.includes('// THUMB')) assetType = 'thumbnail';

      return {
        id: asset.id,
        name: asset.name || asset.passthrough || 'Untitled',
        passthrough: asset.passthrough,
        type: assetType,
        status: asset.status,
        duration: asset.duration,
        resolution: asset.resolution_tier,
        createdAt: asset.created_at,
        playbackId,
        thumbnail: playbackId ? `https://image.mux.com/${playbackId}/thumbnail.png?width=640&height=360&fit_mode=smartcrop` : null,
        streamUrl: playbackId ? `https://stream.mux.com/${playbackId}.m3u8` : null,
        downloadReady: asset.static_renditions?.status === 'ready',
      };
    });

    // Sort: masters first, then by date
    enriched.sort((a, b) => {
      const typeOrder = { master: 0, 'social-clip': 1, audio: 2, thumbnail: 3 };
      const diff = (typeOrder[a.type] || 9) - (typeOrder[b.type] || 9);
      if (diff !== 0) return diff;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

    return res.status(200).json({ assets: enriched, total: enriched.length });
  } catch (err) {
    console.error('Client assets error:', err);
    return res.status(500).json({ error: err.message });
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
