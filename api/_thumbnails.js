import { list } from '@vercel/blob';

// Uploaded marketing thumbnails live in Vercel Blob as plain PNG/JPEG files:
//   thumbnails/<venue>/<base64url(passthrough)>__<timestamp>-<random>.<png|jpg>

export function thumbnailPrefix(venueSlug) {
  const safe = String(venueSlug || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  return `thumbnails/${safe}/`;
}

export function encodeThumbPassthrough(passthrough) {
  return Buffer.from(passthrough, 'utf8').toString('base64url');
}

function decodeThumbPassthrough(pathname, prefix) {
  const encoded = pathname.slice(prefix.length).split('__')[0];
  try { return Buffer.from(encoded, 'base64url').toString('utf8'); } catch { return null; }
}

// Returns the venue's thumbnails shaped like Mux assets, so the dashboard's
// passthrough/date matching works on them unchanged.
export async function listThumbnailAssets(venueSlug) {
  const prefix = thumbnailPrefix(venueSlug);
  const assets = [];
  let cursor;
  do {
    const page = await list({ prefix, cursor, limit: 1000 });
    for (const b of page.blobs) {
      const passthrough = decodeThumbPassthrough(b.pathname, prefix);
      if (!passthrough || !passthrough.includes('// THUMB')) continue;
      assets.push({
        id:           'blob:' + b.pathname,
        source:       'blob',
        status:       'ready',
        passthrough,
        name:         passthrough,
        created_at:   String(Math.floor(new Date(b.uploadedAt).getTime() / 1000)),
        playback_ids: [],
        meta:         { thumbnail_url: b.url },
        size:         b.size,
      });
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return assets;
}
