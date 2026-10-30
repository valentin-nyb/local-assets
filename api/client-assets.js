import { getClientSession, getMuxAuth } from './_client-auth.js';
import { muxUrlAuto } from './_signing.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://local-assets.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Cookie');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const session = await getClientSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const { auth } = getMuxAuth(session.profile);

  try {
    const muxRes = await fetch('https://api.mux.com/video/v1/assets?limit=100', {
      headers: { Authorization: `Basic ${auth}` }
    });
    const result = await muxRes.json();
    if (!muxRes.ok) return res.status(500).json({ error: 'Failed to fetch assets' });

    const allAssets = result.data || [];

    // Clean originals kept behind watermarked clips ("… // SOCIALRAW // NN") are not shown
    // Signed videos: their addresses carry a ticket (2 hours), made with this storage's key
    const muxAuth = `Basic ${auth}`;
    const sign = u => muxUrlAuto(muxAuth, u);
    const enriched = await Promise.all(allAssets.filter(a => !String(a.passthrough || '').toUpperCase().includes('// SOCIALRAW')).map(async asset => {
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
        thumbnail: playbackId ? await sign(`https://image.mux.com/${playbackId}/thumbnail.png?width=640&height=360&fit_mode=smartcrop`) : null,
        streamUrl: playbackId ? await sign(`https://stream.mux.com/${playbackId}.m3u8`) : null,
        downloadUrl: playbackId ? await sign(`https://stream.mux.com/${playbackId}/high.mp4?download=1`) : null,
        downloadReady: asset.static_renditions?.status === 'ready',
      };
    }));

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
