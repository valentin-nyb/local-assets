import { put } from '@vercel/blob';
import { getWebSessionAuth } from './_venues.js';
import { thumbnailPrefix, encodeThumbPassthrough } from './_thumbnails.js';

export const config = { api: { bodyParser: false } };

// Detect the real image type from the file's magic bytes — never trust the client's Content-Type.
function detectImageType(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47 &&
      buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A) {
    return { ext: 'png', contentType: 'image/png' };
  }
  if (buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) {
    return { ext: 'jpg', contentType: 'image/jpeg' };
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://local-assets.com');
  res.setHeader('Access-Control-Allow-Methods', 'PUT,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Passthrough, Authorization, X-User-Email');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const session = getWebSessionAuth(req);
  if (!session?.muxAuth || !session.venueSlug) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const passthrough = (req.headers['x-passthrough'] || req.query.passthrough || 'THUMB').toUpperCase();

  try {
    // Read raw body
    const body = await new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end',  () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
    if (!body.length) return res.status(400).json({ error: 'Empty body' });

    const type = detectImageType(body);
    if (!type) return res.status(415).json({ error: 'Only PNG or JPEG images are supported' });

    // Store the image itself in Vercel Blob. The passthrough tag is encoded into the
    // pathname so list-assets can match it to its session without a database.
    const pathname = `${thumbnailPrefix(session.venueSlug)}${encodeThumbPassthrough(passthrough)}__${Date.now()}.${type.ext}`;
    const blob = await put(pathname, body, {
      access: 'public',
      contentType: type.contentType,
      addRandomSuffix: true,
    });

    return res.status(200).json({
      url:         blob.url,
      pathname:    blob.pathname,
      contentType: type.contentType,
      passthrough,
    });
  } catch (e) {
    console.error('[upload-thumbnail]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
