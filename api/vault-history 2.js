// /api/vault-history.js
// Fetches all Mux assets and returns their embed URLs and metadata

const fetch = require('node-fetch');

const MUX_TOKEN_ID = process.env.MUX_TOKEN_ID;
const MUX_TOKEN_SECRET = process.env.MUX_TOKEN_SECRET;

export default async function handler(req, res) {
  if (!MUX_TOKEN_ID || !MUX_TOKEN_SECRET) {
    return res.status(500).json({ error: 'Missing Mux credentials' });
  }

  const muxApiUrl = 'https://api.mux.com/video/v1/assets';
  try {
    const muxRes = await fetch(muxApiUrl, {
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${MUX_TOKEN_ID}:${MUX_TOKEN_SECRET}`).toString('base64'),
        'Content-Type': 'application/json',
      },
    });
    if (!muxRes.ok) {
      return res.status(muxRes.status).json({ error: 'Failed to fetch Mux assets' });
    }
    const data = await muxRes.json();
    // Map to embed info
    const assets = (data.data || []).map(asset => {
      const playbackId = asset.playback_ids && asset.playback_ids[0] && asset.playback_ids[0].id;
      return playbackId ? {
        id: asset.id,
        created_at: asset.created_at,
        status: asset.status,
        playbackId,
        embedUrl: `https://player.mux.com/${playbackId}`,
        title: asset.passthrough || asset.id,
      } : null;
    }).filter(Boolean);
    res.status(200).json({ assets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
