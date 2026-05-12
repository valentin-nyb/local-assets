import { put } from '@vercel/blob';

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://local-assets.com');
  res.setHeader('Access-Control-Allow-Methods', 'PUT,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Passthrough');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const tokenId     = process.env.PROD_MUX_TOKEN_ID     || process.env.MUX_TOKEN_ID;
  const tokenSecret = process.env.PROD_MUX_TOKEN_SECRET || process.env.MUX_TOKEN_SECRET;
  if (!tokenId || !tokenSecret) {
    return res.status(500).json({ error: 'Mux credentials not configured' });
  }
  const auth = 'Basic ' + Buffer.from(`${tokenId}:${tokenSecret}`).toString('base64');

  const passthrough  = (req.headers['x-passthrough'] || req.query.passthrough || 'THUMB').toUpperCase();
  const contentType  = req.headers['content-type'] || 'image/png';
  const ext          = (contentType.includes('jpeg') || contentType.includes('jpg')) ? 'jpg' : 'png';
  const filename     = `thumb_${Date.now()}.${ext}`;

  try {
    // Read raw body
    const body = await new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end',  () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
    if (!body.length) return res.status(400).json({ error: 'Empty body' });

    // Store image in Vercel Blob
    const blob = await put(`thumbnails/${filename}`, body, { access: 'public', contentType });

    // Create Mux asset with thumbnail overlay
    const muxRes = await fetch('https://api.mux.com/video/v1/assets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: JSON.stringify({
        inputs: [
          { url: 'https://storage.googleapis.com/muxdemofiles/mux-video-intro.mp4' },
          {
            url: blob.url,
            overlay_settings: {
              vertical_align: 'top', horizontal_align: 'left',
              width: '100%', height: '100%',
            },
          },
        ],
        playback_policy: ['public'],
        passthrough,
        name: passthrough + ' — ' + new Date().toLocaleDateString('en-GB', {
          day: '2-digit', month: 'short', year: 'numeric'
        }).toUpperCase(),
        static_renditions: [{ resolution: 'highest' }],
      }),
    });

    const muxData = await muxRes.json();
    if (!muxRes.ok) return res.status(muxRes.status).json({ error: muxData });

    return res.status(200).json({
      blobUrl:    blob.url,
      assetId:    muxData.data?.id,
      playbackId: muxData.data?.playback_ids?.[0]?.id,
    });
  } catch (e) {
    console.error('[upload-thumbnail]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
