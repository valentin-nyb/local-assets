import { list, del } from '@vercel/blob';
import { createClient } from 'redis';
import { handleUpload } from '@vercel/blob/client';
import { getWebSessionAuth } from './_venues.js';

// Brand kit: logos, guidelines, fonts and other brand files for a venue and its artists.
// Files live in Vercel Blob under brand/<venueSlug>/<owner>/<category>/<file>, where
// <owner> is "venue" or "artist-<slug>". The browser uploads straight to Blob
// (large PDFs and font packs exceed the 4.5 MB function body limit); this route
// only hands out upload tokens for the signed-in venue's own folder.

const CATEGORIES = ['logos', 'guidelines', 'fonts', 'other'];
const MAX_BYTES  = 200 * 1024 * 1024;
const OWNER      = /^(venue|artist-[a-z0-9]+(?:-[a-z0-9]+)*)$/;
const ALLOWED_TYPES = [
  'image/png', 'image/jpeg', 'image/svg+xml', 'image/webp', 'image/gif',
  'image/vnd.adobe.photoshop', 'application/pdf', 'application/zip', 'application/x-zip-compressed',
  'application/postscript', 'application/illustrator',
  'font/ttf', 'font/otf', 'font/woff', 'font/woff2', 'application/font-woff',
  'application/x-font-ttf', 'application/x-font-otf', 'application/vnd.ms-opentype',
  'text/plain', 'application/octet-stream',
];

const prefixFor = slug => `brand/${slug}/`;
// What kind of organisation the account is; only changes the label of its own brand kit.
const ORG_TYPES = ['venue', 'label', 'management'];

async function withRedis(fn) {
  const redis = createClient({ url: process.env.REDIS_URL });
  await redis.connect();
  try { return await fn(redis); } finally { await redis.quit().catch(() => {}); }
}

function parsePath(pathname, slug) {
  const rest = pathname.slice(prefixFor(slug).length).split('/');
  if (rest.length < 3 || !OWNER.test(rest[0]) || !CATEGORIES.includes(rest[1])) return null;
  const file = rest.slice(2).join('/');
  // addRandomSuffix turns "logo.png" into "logo-AbC123xyz.png"; show the original name
  const name = file.replace(/-[A-Za-z0-9]{20,40}(\.[^.]+)$/, '$1');
  return { owner: rest[0], category: rest[1], name };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const session = getWebSessionAuth(req);
  if (!session?.email) return res.status(401).json({ error: 'Not authenticated' });
  const slug = session.venueSlug;
  if (!slug) return res.status(403).json({ error: 'No venue for this account' });

  try {
    if (req.method === 'GET') {
      const files = [];
      let cursor;
      do {
        const page = await list({ prefix: prefixFor(slug), cursor, limit: 1000 });
        for (const b of page.blobs) {
          const meta = parsePath(b.pathname, slug);
          if (meta) files.push({ ...meta, url: b.url, downloadUrl: b.downloadUrl, link: 'https://local-assets.com/asset/' + b.pathname.slice('brand/'.length), size: b.size, uploadedAt: b.uploadedAt });
        }
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
      files.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
      const [orgType, orgName] = await withRedis(r => Promise.all([r.get(`brand_org_type:${slug}`), r.get(`brand_org_name:${slug}`)]))
        .catch(() => [null, null]);
      return res.status(200).json({ files, orgType: ORG_TYPES.includes(orgType) ? orgType : 'venue', orgName: orgName || '' });
    }

    if (req.method !== 'POST') return res.status(405).end();
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});

    if (body.action === 'setOrg') {
      if (!ORG_TYPES.includes(body.orgType)) return res.status(400).json({ error: 'Unknown type' });
      const orgName = String(body.orgName ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60);
      await withRedis(r => Promise.all([
        r.set(`brand_org_type:${slug}`, body.orgType),
        orgName ? r.set(`brand_org_name:${slug}`, orgName) : r.del(`brand_org_name:${slug}`),
      ]));
      return res.status(200).json({ orgType: body.orgType, orgName });
    }

    if (body.action === 'delete') {
      const url = String(body.url || '');
      let pathname;
      try { pathname = decodeURIComponent(new URL(url).pathname.slice(1)); } catch { pathname = ''; }
      if (!pathname.startsWith(prefixFor(slug)) || !parsePath(pathname, slug) ||
          !/\.public\.blob\.vercel-storage\.com$/.test(new URL(url).hostname)) {
        return res.status(403).json({ error: 'Not your file' });
      }
      await del(url);
      return res.status(200).json({ ok: true });
    }

    // Client upload handshake (token request from @vercel/blob/client upload()).
    const result = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async pathname => {
        if (!pathname.startsWith(prefixFor(slug)) || !parsePath(pathname, slug)) {
          throw new Error('Invalid upload location');
        }
        return {
          allowedContentTypes: ALLOWED_TYPES,
          maximumSizeInBytes: MAX_BYTES,
          addRandomSuffix: true,
        };
      },
    });
    return res.status(200).json(result);
  } catch (e) {
    console.error('[brand]', e.message);
    return res.status(400).json({ error: e.message });
  }
}
