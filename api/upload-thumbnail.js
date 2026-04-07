import { put } from '@vercel/blob';

const TOKEN_ID = (process.env.PROD_MUX_TOKEN_ID || process.env.MUX_TOKEN_ID || '').trim();
const TOKEN_SECRET = (process.env.PROD_MUX_TOKEN_SECRET || process.env.MUX_TOKEN_SECRET || '').trim();
const AUTH = Buffer.from(`${TOKEN_ID}:${TOKEN_SECRET}`).toString('base64');

export const config = {
  api: { bodyParser: false }
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'PUT,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Passthrough');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const passthrough = (req.headers['x-passthrough'] || req.query.passthrough || 'THUMB').toUpperCase();
  const contentType = req.headers['content-type'] || 'image/png';
  const ext = contentType.includes('jpeg') || contentType.includes('jpg') ? 'jpg' : 'png';
  const filename = `thumb_${Date.now()}.${ext}`;

  try {
    // Collect raw body via event-based reading (more reliable on Vercel)
    const body = await new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });

    if (!body.length) {
      return res.status(400).json({ error: 'Empty body — no image data received' });
    }

    // 1. Upload image to Vercel Blob (Mux needs a public URL to fetch)
    const blob = await put(`thumbnails/${filename}`, body, {
      access: 'public',
      contentType,
    });

    // 2. Create Mux asset with image as full-screen overlay on 1s placeholder video
    const muxRes = await fetch('https://api.mux.com/video/v1/assets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${AUTH}` },
      body: JSON.stringify({
        inputs: [
          {
            url: 'https://storage.googleapis.com/muxdemofiles/mux-video-intro.mp4',
            start_time: 0,
            end_time: 1
          },
          {
            url: blob.url,
            overlay_settings: {
              vertical_align: 'top',
              horizontal_align: 'left',
              width: '100%',
              height: '100%'
            }
          }
        ],
        playback_policies: ['public'],
        passthrough,
        name: passthrough + ' \u2014 ' + new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase(),
        static_renditions: [{ resolution: 'highest' }]
      })
    });

    const muxData = await muxRes.json();

    if (!muxRes.ok) {
      return res.status(muxRes.status).json({ error: muxData });
    }

    return res.status(200).json({
      blobUrl: blob.url,
      assetId: muxData.data?.id,
      playbackId: muxData.data?.playback_ids?.[0]?.id
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
