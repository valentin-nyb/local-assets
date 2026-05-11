import { put } from '@vercel/blob';
import { getClientSession, getMuxAuth } from './_client-auth.js';

export const config = {
  api: { bodyParser: false }
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://local-assets.com');
  res.setHeader('Access-Control-Allow-Methods', 'PUT,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Passthrough, Cookie');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const session = await getClientSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const { auth } = getMuxAuth(session.profile);

  const passthrough = (req.headers['x-passthrough'] || req.query.passthrough || 'THUMB').toUpperCase();
  const contentType = req.headers['content-type'] || 'image/png';
  const ext = contentType.includes('jpeg') || contentType.includes('jpg') ? 'jpg' : 'png';
  const filename = `thumb_${Date.now()}.${ext}`;

  try {
    const body = await new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });

    if (!body.length) return res.status(400).json({ error: 'Empty body' });

    const blob = await put(`thumbnails/${filename}`, body, { access: 'public', contentType });

    const muxRes = await fetch('https://api.mux.com/video/v1/assets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
      body: JSON.stringify({
        inputs: [
          { url: 'https://storage.googleapis.com/muxdemofiles/mux-video-intro.mp4' },
          { url: blob.url, overlay_settings: { vertical_align: 'top', horizontal_align: 'left', width: '100%', height: '100%' } }
        ],
        playback_policies: ['public'],
        passthrough,
        name: passthrough + ' — ' + new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase(),
        static_renditions: [{ resolution: 'highest' }]
      })
    });

    const muxData = await muxRes.json();
    if (!muxRes.ok) return res.status(muxRes.status).json({ error: muxData });

    return res.status(200).json({
      blobUrl: blob.url,
      assetId: muxData.data?.id,
      playbackId: muxData.data?.playback_ids?.[0]?.id
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
