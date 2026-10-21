import { pausedBy, sendPaused } from './_suspend.js';
import { list, del, copy } from '@vercel/blob';
import { createClient } from 'redis';
import { handleUpload } from '@vercel/blob/client';
import { getWebSessionAuth, MEMBERS_KEY, refreshRegistry, getVenuesConfig } from './_venues.js';
import { Resend } from 'resend';
import { accessInviteEmail } from './_emails.js';
import { cleanWatermark, readWatermark, watermarkKey } from './_watermark.js';
import { ownerLimit, accountTypeOf, readAssignments } from './_billing.js';

// Brand kit: logos, guidelines, fonts and other brand files for a venue and its artists.
// Files live in Vercel Blob under brand/<venueSlug>/<owner>/<category>/<file>, where
// <owner> is "venue", "venue-<slug>", "artist-<slug>" or "label-<slug>" (a record label linked to an artist). The browser uploads straight to Blob
// (large PDFs and font packs exceed the 4.5 MB function body limit); this route
// only hands out upload tokens for the signed-in venue's own folder.

// "posts" are Instagram posts: several images kept together as one, under posts/<post id>/<image>
const CATEGORIES = ['logos', 'covers', 'artwork', 'posts', 'photos', 'guidelines', 'fonts', 'looks', 'other'];
const POST_ID = /^[a-z0-9]{6,24}$/;
const newPostId = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36);
const MAX_BYTES  = 200 * 1024 * 1024;
// "venue" is the account itself; artist-<slug> and venue-<slug> are artists and venues it works with
const OWNER      = /^(venue|(?:artist|venue|label)-[a-z0-9]+(?:-[a-z0-9]+)*)$/;
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
const ORG_TYPES = ['venue', 'artist', 'label', 'management'];

async function withRedis(fn) {
  const redis = createClient({ url: process.env.REDIS_URL });
  await redis.connect();
  try { return await fn(redis); } finally { await redis.quit().catch(() => {}); }
}

function parsePath(pathname, slug) {
  const rest = pathname.slice(prefixFor(slug).length).split('/');
  if (rest.length < 3 || !OWNER.test(rest[0]) || !CATEGORIES.includes(rest[1])) return null;
  // An Instagram post's image: posts/<post id>/<image>
  const post = rest[1] === 'posts' ? rest[2] : null;
  if (rest[1] === 'posts' && (rest.length !== 4 || !POST_ID.test(post))) return null;
  const file = rest.slice(post ? 3 : 2).join('/');
  // addRandomSuffix turns "logo.png" into "logo-AbC123xyz.png"; show the original name
  const name = file.replace(/-[A-Za-z0-9]{20,40}(\.[^.]+)$/, '$1');
  return post ? { owner: rest[0], category: rest[1], post, name } : { owner: rest[0], category: rest[1], name };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const session = getWebSessionAuth(req);
  if (!session?.email) return res.status(401).json({ error: 'Not authenticated' });
  if (req.method !== 'GET' && session?.venueSlug) { const _p = await pausedBy(session.venueSlug); if (_p) return sendPaused(res, _p); }
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
      const [orgType, orgName, ownerNames, pinned, watermark, labelArtists, fileLabels, hiddenOwners, ownerGenres, ownerLinks] = await withRedis(r => Promise.all([
        r.get(`brand_org_type:${slug}`), r.get(`brand_org_name:${slug}`),
        r.hGetAll(`brand_owner_names:${slug}`), r.hGetAll(`brand_owner_photo:${slug}`),
        readWatermark(r, slug), r.hGetAll(`brand_label_artist:${slug}`), r.hGetAll(`brand_file_label:${slug}`),
        r.sMembers(`brand_hidden_owners:${slug}`),
        r.hGetAll(`brand_owner_genres:${slug}`), r.hGetAll(`brand_owner_links:${slug}`),
      ])).catch(() => [null, null, {}, {}, cleanWatermark(), {}, {}, [], {}, {}]);
      // "Other" files carry what they are, as typed when uploading ("Press kit", "Tech rider")
      for (const f of files) {
        const key = decodeURIComponent(new URL(f.url).pathname.slice(1));
        if (fileLabels?.[key]) f.label = fileLabels[key];
      }
      // Profile photo per owner: the one picked with "Use as artist photo", else the newest photo
      const ownerPhotos = {};
      for (const f of files) {
        if (f.category === 'photos' && !ownerPhotos[f.owner]) ownerPhotos[f.owner] = f.url;
      }
      const ownerPhotosPicked = [];   // owners whose profile picture was chosen (not just their newest photo)
      for (const [owner, url] of Object.entries(pinned || {})) {
        if (files.some(f => f.url === url)) { ownerPhotos[owner] = url; ownerPhotosPicked.push(owner); }
      }
      const lut = await withRedis(r => r.get(`brand_lut:${slug}`)).catch(() => null);
      // An artist with access: only their own folder, and the account's logos to download
      if (session.member) {
        const own = session.member.owner;
        // Their own folder (to change), the account's own (venue or label) and any record label linked to
        // them (to view and download)
        // Every record label in the account (and any linked to the artist)
        const labels = [...new Set([...files.map(f => f.owner), ...Object.keys(ownerNames || {}), ...Object.keys(labelArtists || {})].filter(o => /^label-/.test(o)))];
        const seen = [own, 'venue', ...labels];
        const mine = files.filter(f => seen.includes(f.owner));
        const pick = obj => Object.fromEntries(Object.entries(obj || {}).filter(([o]) => seen.includes(o)));
        // The account's own folder keeps the account's name (the page would otherwise show the artist's)
        return res.status(200).json({ lut: '', files: mine, orgType: ORG_TYPES.includes(orgType) ? orgType : 'venue', orgName: orgName || getVenuesConfig()[slug]?.name || '', member: { owner: own, name: session.member.name, readOnly: seen.filter(o => o !== own) },
          labelArtists: Object.fromEntries(labels.map(l => [l, (labelArtists || {})[l] === own ? own : 'venue'])),
          ownerNames: { ...pick(ownerNames), [own]: (ownerNames || {})[own] || session.member.name }, // their own photo, and the account's chosen logo so the dashboard shows the venue's or label's logo
          ownerPhotos: pick(ownerPhotos), ownerPhotosPicked: ownerPhotosPicked.filter(o => seen.includes(o)),
          ownerGenres: pick(ownerGenres), ownerLinks: pick(ownerLinks), watermark: watermark || cleanWatermark(), hiddenOwners: [] });   // the account's watermark, to see
      }
      // Who has been given access to each artist's folder (Give access)
      const access = await withRedis(r => r.hGetAll(`artist_access:${slug}`)).then(m => Object.fromEntries(Object.entries(m || {}).map(([k, v]) => { try { return [k, JSON.parse(v)]; } catch { return [k, []]; } }))).catch(() => ({}));
      return res.status(200).json({ access, lut: lut || '', files, orgType: ORG_TYPES.includes(orgType) ? orgType : 'venue', orgName: orgName || '', ownerNames: ownerNames || {}, ownerPhotos, ownerPhotosPicked, ownerGenres: ownerGenres || {}, ownerLinks: ownerLinks || {}, watermark, labelArtists: labelArtists || {}, hiddenOwners: hiddenOwners || [] });
    }

    if (req.method !== 'POST') return res.status(405).end();
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});

    // An artist with access changes only their own folder: its files, photo and details, and uploads into it
    if (session.member) {
      const own = session.member.owner;
      const ownFile = u => { try { const p = decodeURIComponent(new URL(String(u || '')).pathname.slice(1)); return parsePath(p, slug)?.owner === own; } catch { return false; } };
      const ok = !body.action ? true
        : ['setPhoto', 'move', 'setFileLabel', 'delete'].includes(body.action) ? ownFile(body.url)
        : body.action === 'setOwnerDetails' ? body.owner === own : false;
      if (!ok) return res.status(403).json({ error: 'Artists can change only their own Brand Kit folder' });
    }

    // Give an artist access to the account (venues and record labels): they sign in with Google using this email,
    // and see only their own sets, the calendar and their Brand Kit folder
    if (body.action === 'grantAccess' || body.action === 'revokeAccess') {
      const owner = String(body.owner || ''), email = String(body.email || '').trim().toLowerCase();
      if (!/^artist-[a-z0-9-]+$/.test(owner)) return res.status(400).json({ error: 'Choose an artist' });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter the artist\'s email' });
      const out = await withRedis(async r => {
        const type = (await r.get(`brand_org_type:${slug}`)) || (await r.get(`account_type:${slug}`)) || 'venue';
        if (type === 'artist') return { status: 400, error: 'An artist account is one artist: there is no one to give access to' };
        const name = (await r.hGet(`brand_owner_names:${slug}`, owner)) || owner.slice(7).replace(/-/g, ' ').toUpperCase();
        const acc = JSON.parse(await r.hGet(`artist_access:${slug}`, owner) || '[]').filter(e => e !== email);
        const mem = JSON.parse(await r.hGet(MEMBERS_KEY, email) || '[]').filter(m => !(m.slug === slug && m.owner === owner));
        if (body.action === 'grantAccess') { acc.push(email); mem.push({ slug, owner, name }); }
        acc.length ? await r.hSet(`artist_access:${slug}`, owner, JSON.stringify(acc)) : await r.hDel(`artist_access:${slug}`, owner);
        mem.length ? await r.hSet(MEMBERS_KEY, email, JSON.stringify(mem)) : await r.hDel(MEMBERS_KEY, email);
        await refreshRegistry(r);
        return { status: 200, access: acc, name };
      });
      if (out.status !== 200) return res.status(out.status).json({ error: out.error });
      // The invite, from the account (an email that can't be sent doesn't undo the access)
      let emailed = false;
      if (body.action === 'grantAccess') {
        const key = process.env.LA_RESEND_API_KEY || process.env.RESEND_API_KEY;
        if (key) {
          const m = accessInviteEmail({ artist: out.name, account: getVenuesConfig()[slug]?.name || slug, email });
          const r = await new Resend(key).emails.send({ from: 'local / assets <noreply@local-assets.com>', replyTo: session.email, to: email, subject: m.subject, html: m.html, text: m.text }).catch(e => ({ error: e }));
          emailed = !r?.error;
        }
      }
      return res.status(200).json({ access: out.access, emailed });
    }

    if (body.action === 'setOrg') {
      if (!ORG_TYPES.includes(body.orgType)) return res.status(400).json({ error: 'Unknown type' });
      const orgName = String(body.orgName ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60);
      await withRedis(r => Promise.all([
        r.set(`brand_org_type:${slug}`, body.orgType),
        orgName ? r.set(`brand_org_name:${slug}`, orgName) : r.del(`brand_org_name:${slug}`),
      ]));
      return res.status(200).json({ orgType: body.orgType, orgName });
    }

    if (body.action === 'setWatermark') {
      const watermark = cleanWatermark(body.watermark);
      await withRedis(r => r.set(watermarkKey(slug), JSON.stringify(watermark)));
      return res.status(200).json({ watermark });
    }

    // Genres and links of an artist (or venue / label): used for YouTube and SoundCloud publish details
    if (body.action === 'setOwnerDetails') {
      const owner = String(body.owner || '');
      if (!(owner === 'venue' || OWNER.test(owner))) return res.status(400).json({ error: 'Invalid brand kit' });
      const genres = String(body.genres ?? '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
      const links = String(body.links ?? '').split(/[\s,]+/).map(l => l.trim()).filter(l => /^https?:\/\/[^\s<>"]{3,200}$/i.test(l)).slice(0, 6).join('\n');
      await withRedis(r => Promise.all([
        genres ? r.hSet(`brand_owner_genres:${slug}`, owner, genres) : r.hDel(`brand_owner_genres:${slug}`, owner),
        links ? r.hSet(`brand_owner_links:${slug}`, owner, links) : r.hDel(`brand_owner_links:${slug}`, owner),
      ]));
      return res.status(200).json({ owner, genres, links });
    }

    if (body.action === 'setOwnerName') {
      // Display name for an artist or venue brand kit, kept exactly as typed ("Café 1001")
      const owner = String(body.owner || '');
      const name  = String(body.name ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60);
      if (owner === 'venue' || !OWNER.test(owner) || !name) return res.status(400).json({ error: 'Invalid name' });
      // A new artist, record label or venue counts against what the account's type and plan allow
      const refused = await withRedis(async r => {
        const names = await r.hGetAll(`brand_owner_names:${slug}`) || {};
        if (names[owner]) return null;
        const kind = owner.split('-')[0];
        const type = await accountTypeOf(r, slug), plan = (await readAssignments(r, slug)).venue?.plan || '';
        const limit = ownerLimit(type, plan, kind), have = Object.keys(names).filter(k => k.startsWith(kind + '-')).length;
        if (have < limit) return null;
        const what = { artist: 'artists', label: 'record labels', venue: 'venues' }[kind];
        return limit === 0
          ? (type === 'artist' && kind === 'artist' ? 'An artist account is for one artist: you. To manage several artists, use a record label or venue account.' : `This kind of account doesn't add other ${what}.`)
          : `Your plan includes up to ${limit} ${what}. Move to a bigger plan in Billing to add more.`;
      }).catch(() => null);
      if (refused) return res.status(403).json({ error: refused });
      // A record label's brand kit sits under the artist it belongs to
      const artist = String(body.artist || '');
      await withRedis(r => Promise.all([
        r.hSet(`brand_owner_names:${slug}`, owner, name),
        r.sRem(`brand_hidden_owners:${slug}`, owner),
        owner.startsWith('label-') && /^(venue|artist-[a-z0-9-]+)$/.test(artist) ? r.hSet(`brand_label_artist:${slug}`, owner, artist) : null,
      ]));
      return res.status(200).json({ owner, name });
    }

    if (body.action === 'deleteOwner') {
      // Remove an artist, venue or record label brand kit: every file in its folder, its saved name and photo
      const owner = String(body.owner || '');
      if (owner === 'venue' || !OWNER.test(owner)) return res.status(400).json({ error: 'This brand kit can\'t be deleted' });
      const prefix = `${prefixFor(slug)}${owner}/`;
      let cursor, removed = 0;
      do {
        const page = await list({ prefix, cursor, limit: 1000 });
        if (page.blobs.length) { await del(page.blobs.map(b => b.url)); removed += page.blobs.length; }
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
      await withRedis(r => Promise.all([r.hDel(`brand_owner_names:${slug}`, owner), r.hDel(`brand_owner_photo:${slug}`, owner), r.hDel(`brand_label_artist:${slug}`, owner),
        // Artists also come from sessions: keep a deleted one out of the brand kit until files are added again
        r.sAdd(`brand_hidden_owners:${slug}`, owner)]));
      return res.status(200).json({ ok: true, removed });
    }

    // The colour look (.cube) used on every vertical clip; an empty url turns it off
    if (body.action === 'setLut') {
      const url = String(body.url || '');
      if (!url) { await withRedis(r => r.del(`brand_lut:${slug}`)); return res.status(200).json({ lut: '' }); }
      let pathname = '';
      try { pathname = decodeURIComponent(new URL(url).pathname.slice(1)); } catch {}
      const meta = pathname.startsWith(prefixFor(slug)) ? parsePath(pathname, slug) : null;
      if (!meta || meta.category !== 'looks' || !/\.cube$/i.test(pathname)) return res.status(400).json({ error: 'Pick one of your colour looks (.cube)' });
      await withRedis(r => r.set(`brand_lut:${slug}`, url));
      return res.status(200).json({ lut: url });
    }
    if (body.action === 'setPhoto') {
      const url = String(body.url || '');
      let pathname = '';
      try { pathname = decodeURIComponent(new URL(url).pathname.slice(1)); } catch {}
      const meta = pathname.startsWith(prefixFor(slug)) ? parsePath(pathname, slug) : null;
      // A photo, or a logo image (a GIF logo moves wherever the profile picture shows)
      const ok = meta && (meta.category === 'photos' || (meta.category === 'logos' && /\.(png|jpe?g|webp|gif|svg)$/i.test(pathname)));
      if (!ok) return res.status(400).json({ error: 'Pick one of your photos or logos' });
      await withRedis(r => r.hSet(`brand_owner_photo:${slug}`, meta.owner, url));
      return res.status(200).json({ owner: meta.owner, url });
    }

    if (body.action === 'move') {
      // Change a file's type: copy it under the new category folder, then remove the original.
      // Into Instagram posts: a new post of its own, or { post } to add it to an existing one.
      const url = String(body.url || '');
      let pathname = '';
      try { pathname = decodeURIComponent(new URL(url).pathname.slice(1)); } catch {}
      const meta = pathname.startsWith(prefixFor(slug)) ? parsePath(pathname, slug) : null;
      if (!meta || !/\.public\.blob\.vercel-storage\.com$/.test(new URL(url).hostname)) return res.status(403).json({ error: 'Not your file' });
      if (!CATEGORIES.includes(body.category)) return res.status(400).json({ error: 'Unknown type' });
      const intoPost = body.category === 'posts' ? (POST_ID.test(String(body.post || '')) ? String(body.post) : newPostId()) : null;
      if (body.category === meta.category && (!intoPost || intoPost === meta.post)) return res.status(200).json({ ok: true, post: meta.post || null });
      const parts = pathname.slice(prefixFor(slug).length).split('/');
      const fileName = parts[parts.length - 1];
      const to = prefixFor(slug) + [parts[0], body.category].concat(intoPost ? [intoPost] : [], [fileName]).join('/');
      const moved = await copy(url, to, { access: 'public', addRandomSuffix: false });
      await del(url);
      return res.status(200).json({ ok: true, post: intoPost, url: moved.url });
    }

    if (body.action === 'setFileLabel') {
      const url = String(body.url || '');
      let pathname = '';
      try { pathname = decodeURIComponent(new URL(url).pathname.slice(1)); } catch {}
      if (!pathname.startsWith(prefixFor(slug)) || !parsePath(pathname, slug)) return res.status(403).json({ error: 'Not your file' });
      const label = String(body.label ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40);
      await withRedis(r => label ? r.hSet(`brand_file_label:${slug}`, pathname, label) : r.hDel(`brand_file_label:${slug}`, pathname));
      return res.status(200).json({ label });
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
      await withRedis(r => r.hDel(`brand_file_label:${slug}`, pathname)).catch(() => {});
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
        if (session.member && parsePath(pathname, slug).owner !== session.member.owner) throw new Error('Artists upload only to their own folder');
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
