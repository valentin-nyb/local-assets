import { list, del, copy } from '@vercel/blob';
import { createClient } from 'redis';
import { handleUpload } from '@vercel/blob/client';
import { getWebSessionAuth } from './_venues.js';

// Brand kit: logos, guidelines, fonts and other brand files for a venue and its artists.
// Files live in Vercel Blob under brand/<venueSlug>/<owner>/<category>/<file>, where
// <owner> is "venue" or "artist-<slug>". The browser uploads straight to Blob
// (large PDFs and font packs exceed the 4.5 MB function body limit); this route
// only hands out upload tokens for the signed-in venue's own folder.

const CATEGORIES = ['logos', 'covers', 'artwork', 'photos', 'guidelines', 'fonts', 'other'];
const MAX_BYTES  = 200 * 1024 * 1024;
// "venue" is the account itself; artist-<slug> and venue-<slug> are artists and venues it works with
const OWNER      = /^(venue|(?:artist|venue)-[a-z0-9]+(?:-[a-z0-9]+)*)$/;
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
      const [orgType, orgName, ownerNames, pinned] = await withRedis(r => Promise.all([
        r.get(`brand_org_type:${slug}`), r.get(`brand_org_name:${slug}`),
        r.hGetAll(`brand_owner_names:${slug}`), r.hGetAll(`brand_owner_photo:${slug}`),
      ])).catch(() => [null, null, {}, {}]);
      // Profile photo per owner: the one picked with "Use as artist photo", else the newest photo
      const ownerPhotos = {};
      for (const f of files) {
        if (f.category === 'photos' && !ownerPhotos[f.owner]) ownerPhotos[f.owner] = f.url;
      }
      for (const [owner, url] of Object.entries(pinned || {})) {
        if (files.some(f => f.url === url)) ownerPhotos[owner] = url;
      }
      return res.status(200).json({ files, orgType: ORG_TYPES.includes(orgType) ? orgType : 'venue', orgName: orgName || '', ownerNames: ownerNames || {}, ownerPhotos });
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

    if (body.action === 'setOwnerName') {
      // Display name for an artist or venue brand kit, kept exactly as typed ("Café 1001")
      const owner = String(body.owner || '');
      const name  = String(body.name ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60);
      if (owner === 'venue' || !OWNER.test(owner) || !name) return res.status(400).json({ error: 'Invalid name' });
      await withRedis(r => r.hSet(`brand_owner_names:${slug}`, owner, name));
      return res.status(200).json({ owner, name });
    }

    if (body.action === 'setPhoto') {
      const url = String(body.url || '');
      let pathname = '';
      try { pathname = decodeURIComponent(new URL(url).pathname.slice(1)); } catch {}
      const meta = pathname.startsWith(prefixFor(slug)) ? parsePath(pathname, slug) : null;
      if (!meta || meta.category !== 'photos') return res.status(400).json({ error: 'Pick one of your photos' });
      await withRedis(r => r.hSet(`brand_owner_photo:${slug}`, meta.owner, url));
      return res.status(200).json({ owner: meta.owner, url });
    }

    if (body.action === 'move') {
      // Change a file's type: copy it under the new category folder, then remove the original
      const url = String(body.url || '');
      let pathname = '';
      try { pathname = decodeURIComponent(new URL(url).pathname.slice(1)); } catch {}
      const meta = pathname.startsWith(prefixFor(slug)) ? parsePath(pathname, slug) : null;
      if (!meta || !/\.public\.blob\.vercel-storage\.com$/.test(new URL(url).hostname)) return res.status(403).json({ error: 'Not your file' });
      if (!CATEGORIES.includes(body.category)) return res.status(400).json({ error: 'Unknown type' });
      if (body.category === meta.category) return res.status(200).json({ ok: true });
      const parts = pathname.slice(prefixFor(slug).length).split('/');
      const to = prefixFor(slug) + [parts[0], body.category].concat(parts.slice(2)).join('/');
      await copy(url, to, { access: 'public', addRandomSuffix: false });
      await del(url);
      return res.status(200).json({ ok: true });
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
