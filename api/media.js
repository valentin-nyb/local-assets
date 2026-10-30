import crypto from 'crypto';
import { createClient } from 'redis';
import { getWebSessionAuth, findVenueByEmail, freshVenues, getVenuesConfig, getMuxAuthForVenue, platformAdmins, isAdminVenue, artistOf, sameArtist } from './_venues.js';
import { signingFor, signUrl, playerTickets } from './_signing.js';
import { pathOf, readUrl, copyToPrivate, privateBrand } from './_brandstore.js';

// Every video, thumbnail and download goes through here once videos are signed (Mux signed playback):
// the address is only signed for someone signed in to the account the video belongs to, for 2 hours
// (downloads: 15 minutes, and noted). Addresses of videos still public are passed on as they are.
//   POST { action: 'key' }                 a media key (12 h) for addresses the page can't sign in with (<img>, links)
//   POST { action: 'tickets', pids: [] }   Mux Player's tickets for these playback IDs (null: still public)
//   POST { action: 'sign', urls: [] }      these Mux addresses, signed (scripts that fetch or play directly)
//   GET  ?u=<Mux address>&k=<media key>[&dl=<file name>]   → the signed address (a download when dl is given)
//   POST { action: 'check' }               (local / assets) each account's signing key and site-only rule
//   POST { action: 'share', pid, title, days }   a link to one video for anyone, ending after days (7, at most 30)
//   POST { action: 'unshare', share }      ends a link now
//   POST { action: 'switch', slug, step, page }   (local / assets) one account's existing videos and cameras:
//        step add: each gets a signed playback ID beside its public one (nothing changes for viewers);
//        lock: the public ones are removed, so only signed addresses play; undo: public ones are added again.
//        A page of 100 videos at a time; { more, page } says where to go on.
// Someone opening a shared link has no sign-in: the share id (s) stands in for the media key, for its video only.
const TTL = 2 * 3600, DL_TTL = 15 * 60;
const mediaSecret = () => (process.env.LOCAL_ASSETS_API_KEY || 'dev-secret-change-me') + ':media';
const hmac = d => crypto.createHmac('sha256', mediaSecret()).update(d).digest('base64url');
function makeKey(session) {
  const d = Buffer.from(JSON.stringify({ e: session.email, v: session.venueSlug, x: Date.now() + 12 * 3600e3 })).toString('base64url');
  return d + '.' + hmac(d);
}
function readKey(k) {
  const [d, sig] = String(k || '').split('.');
  if (!d || !sig || sig.length !== hmac(d).length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(hmac(d)))) return null;
  try { const p = JSON.parse(Buffer.from(d, 'base64url').toString()); return p.x > Date.now() ? p : null; } catch { return null; }
}

// Whose a playback ID is (account, artist, signed or public, video or live): found once, kept 30 days
async function ownerOf(redis, pid, slugs) {
  const key = `pid_owner:${pid}`;
  const c = JSON.parse(await redis.get(key).catch(() => null) || 'null');
  if (c) return slugs.includes(c.slug) ? c : null;
  for (const slug of slugs) {
    const cfg = getVenuesConfig()[slug]; const auth = cfg && getMuxAuthForVenue({ slug, ...cfg });
    if (!auth) continue;
    const r = await fetch(`https://api.mux.com/video/v1/playback-ids/${encodeURIComponent(pid)}`, { headers: { Authorization: auth }, signal: AbortSignal.timeout(10000) }).catch(() => null);
    if (!r || !r.ok) continue;
    const d = (await r.json()).data || {};
    let artist = '';
    if (d.object?.type === 'asset') {
      const a = await fetch(`https://api.mux.com/video/v1/assets/${encodeURIComponent(d.object.id)}`, { headers: { Authorization: auth }, signal: AbortSignal.timeout(10000) }).then(x => x.json()).catch(() => null);
      artist = artistOf(a?.data || {});
    }
    const o = { slug, artist, policy: d.policy || 'public', kind: d.object?.type || '' };
    await redis.set(key, JSON.stringify(o), { EX: 30 * 86400 }).catch(() => {});
    return o;
  }
  return null;
}

// The accounts a person may open: their own, or every account for local / assets
const reachOf = venue => venue && isAdminVenue(venue) ? Object.keys(getVenuesConfig()) : venue ? [venue.slug] : [];
const allowed = (o, member) => o && (!member || !o.artist || sameArtist(o.artist, member.name));
const authOf = slug => { const cfg = getVenuesConfig()[slug]; return cfg ? getMuxAuthForVenue({ slug, ...cfg }) : null; };

async function signAddress(redis, url, slugs, member, ttl, extra = {}) {
  const u = new URL(url);
  // A Brand Kit file (brand/<account>/…): the account's own; a signed link of a few minutes in the private store
  const bp = pathOf(url);
  if (bp && bp.startsWith('brand/')) {
    const slug = bp.split('/')[1];
    if (!slugs.includes(slug)) return null;
    return { url: await readUrl(url, Math.min(ttl, 900)), o: { slug } };
  }
  if (!/^(stream|image)\.mux\.com$/.test(u.hostname)) return null;
  const pid = (/^\/([A-Za-z0-9]+)/.exec(u.pathname) || [])[1];
  if (!pid) return null;
  const o = await ownerOf(redis, pid, slugs);
  if (!allowed(o, member)) return null;
  if (o.policy !== 'signed') return { url, o };   // still public: as it is
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  const s = await signingFor(redis, authOf(o.slug));
  return { url: signUrl(s, u.href, ttl), o };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  // Who's asking, before anything else: a media key in the address (GET), or the sign-in (POST)
  const shareId = String((req.method === 'GET' ? req.query?.s : (typeof req.body === 'string' ? (() => { try { return JSON.parse(req.body).share; } catch { return ''; } })() : req.body?.share)) || '');
  const shareMode = /^[A-Za-z0-9_-]{16,32}$/.test(shareId);
  const k = req.method === 'GET' && !shareMode ? readKey(req.query?.k) : null;
  if (req.method === 'GET' && !k && !shareMode) return res.status(401).send('Sign in again to see this.');
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();
  const session = req.method === 'POST' ? getWebSessionAuth(req) : null;
  if (req.method === 'POST' && !session?.email && !shareMode) return res.status(401).json({ error: 'Not signed in' });
  await freshVenues();
  const redis = createClient({ url: (process.env.UPSTASH_REDIS_URL || process.env.REDIS_URL) });
  await redis.connect();
  try {
    // <img>, video and download addresses: the media key in the address
    // A shared link: its one video, until the link ends
    const share = shareMode ? JSON.parse(await redis.get(`share:${shareId}`).catch(() => null) || 'null') : null;
    if (shareMode && (!share || share.exp < Date.now())) return req.method === 'GET' ? res.status(410).send('This link has ended. Ask for a new one.') : res.status(410).json({ error: 'This link has ended. Ask for a new one.' });
    if (share) {
      const pidOf = u => { try { return (/^\/([A-Za-z0-9]+)/.exec(new URL(u).pathname) || [])[1]; } catch { return null; } };
      const auth = authOf(share.slug);
      // The video's policy now (it may have been switched to signed since the link was made)
      const pol = (await ownerOf(redis, share.pid, [share.slug]).catch(() => null))?.policy || share.policy;
      if (req.method === 'GET') {
        const u = String(req.query.u || '');
        if (pidOf(u) !== share.pid || !/^https:\/\/(stream|image)\.mux\.com\//.test(u)) return res.status(403).send('This link opens one video only.');
        const dl = req.query.dl ? String(req.query.dl).replace(/[^\w.\- ]/g, '').slice(0, 120) : '';
        const x = new URL(u); if (dl) x.searchParams.set('download', dl);
        const out = pol === 'signed' ? signUrl(await signingFor(redis, auth), x.href, dl ? DL_TTL : TTL) : x.href;
        if (dl) { await redis.lPush(`downloads:${share.slug}`, JSON.stringify({ at: Date.now(), by: 'shared link ' + shareId.slice(0, 6), file: dl, url: u.split('?')[0] })).catch(() => {}); await redis.lTrim(`downloads:${share.slug}`, 0, 1999).catch(() => {}); }
        res.setHeader('Cache-Control', dl ? 'no-store' : 'private, max-age=3000');
        return res.redirect(302, out);
      }
      const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      if (b.action === 'tickets') return res.status(200).json({ tickets: { [share.pid]: pol === 'signed' ? playerTickets(await signingFor(redis, auth), share.pid, TTL) : null } });
      return res.status(403).json({ error: 'This link opens one video only.' });
    }

    if (req.method === 'GET') {
      const venue = findVenueByEmail(k.e, k.v);
      const dl = req.query.dl ? String(req.query.dl).replace(/[^\w.\- ]/g, '').slice(0, 120) : '';
      let out;
      try { out = await signAddress(redis, String(req.query.u || ''), reachOf(venue), venue?.member, dl ? DL_TTL : TTL, dl ? { download: dl } : {}); }
      catch (e) { console.error('[media]', e.message); return res.status(502).send('Could not open this right now.'); }
      if (!out) return res.status(403).send('This isn\'t yours to open.');
      if (dl) {
        await redis.lPush(`downloads:${out.o.slug}`, JSON.stringify({ at: Date.now(), by: k.e, file: dl, url: String(req.query.u).split('?')[0] })).catch(() => {});
        await redis.lTrim(`downloads:${out.o.slug}`, 0, 1999).catch(() => {});
      }
      res.setHeader('Cache-Control', dl ? 'no-store' : 'private, max-age=3000');
      res.setHeader('Referrer-Policy', 'origin');
      return res.redirect(302, out.url);
    }
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const slugs = reachOf(session.venue), member = session.member;

    if (body.action === 'key') return res.status(200).json({ key: makeKey(session), exp: Date.now() + 12 * 3600e3 });

    if (body.action === 'tickets') {
      const out = {};
      for (const pid of [...new Set((body.pids || []).map(String))].slice(0, 60)) {
        if (!/^[A-Za-z0-9]{10,80}$/.test(pid)) continue;
        const o = await ownerOf(redis, pid, slugs).catch(() => null);
        if (!allowed(o, member)) { out[pid] = { denied: true }; continue; }
        out[pid] = o.policy === 'signed' ? playerTickets(await signingFor(redis, authOf(o.slug)), pid, TTL) : null;
      }
      return res.status(200).json({ tickets: out });
    }

    if (body.action === 'sign') {
      const out = [];
      for (const url of (body.urls || []).slice(0, 60)) {
        try { const r = await signAddress(redis, String(url), slugs, member, TTL); out.push(r ? r.url : null); } catch { out.push(null); }
      }
      return res.status(200).json({ urls: out });
    }

    if (body.action === 'share') {
      const pid = String(body.pid || '');
      const o = /^[A-Za-z0-9]{10,80}$/.test(pid) ? await ownerOf(redis, pid, slugs).catch(() => null) : null;
      if (!allowed(o, member)) return res.status(403).json({ error: 'This isn\'t yours to share.' });
      const days = Math.min(30, Math.max(1, Math.round(Number(body.days) || 7)));
      const id = crypto.randomBytes(15).toString('base64url');
      const exp = Date.now() + days * 86400e3;
      await redis.set(`share:${id}`, JSON.stringify({ slug: o.slug, pid, policy: o.policy, title: String(body.title || '').slice(0, 120), by: session.email, exp }), { EX: days * 86400 });
      await redis.hSet(`shares:${o.slug}`, id, JSON.stringify({ pid, title: String(body.title || '').slice(0, 120), by: session.email, exp })).catch(() => {});
      const title = String(body.title || '');
      return res.status(200).json({ url: `https://local-assets.com/player.html?s=${id}&v=${encodeURIComponent(pid)}${title ? '&title=' + encodeURIComponent(title) : ''}`, exp, days });
    }
    if (body.action === 'shareFile') {
      // A Brand Kit file, for anyone with the link until it ends: local-assets.com/asset/…?s=…
      const path = pathOf(String(body.url || ''));
      const slug = path && path.startsWith('brand/') ? path.split('/')[1] : '';
      if (!slug || !slugs.includes(slug)) return res.status(403).json({ error: 'This isn\'t yours to share.' });
      const days = Math.min(30, Math.max(1, Math.round(Number(body.days) || 7)));
      const id = crypto.randomBytes(15).toString('base64url'), exp = Date.now() + days * 86400e3;
      await redis.set(`share:${id}`, JSON.stringify({ kind: 'file', slug, path, by: session.email, exp }), { EX: days * 86400 });
      return res.status(200).json({ url: 'https://local-assets.com/asset/' + path.slice('brand/'.length).split('/').map(encodeURIComponent).join('/') + '?s=' + id, exp, days });
    }
    if (body.action === 'unshare') {
      const sh = JSON.parse(await redis.get(`share:${String(body.share || '')}`).catch(() => null) || 'null');
      if (!sh || !slugs.includes(sh.slug)) return res.status(404).json({ error: 'No such link' });
      await redis.del(`share:${body.share}`); await redis.hDel(`shares:${sh.slug}`, String(body.share)).catch(() => {});
      return res.status(200).json({ ok: true });
    }

    if (body.action === 'switch') {
      if (!platformAdmins().includes(session.email) || !isAdminVenue(session.venue)) return res.status(403).json({ error: 'Only local / assets' });
      const slug = String(body.slug || ''), step = String(body.step || ''), auth = authOf(slug);
      if (!auth || !['add', 'lock', 'undo'].includes(step)) return res.status(400).json({ error: 'Which account and step?' });
      if (step === 'add' || step === 'lock') await signingFor(redis, auth);   // the key first: nothing is locked an account can't sign
      const mux = (p, init = {}) => fetch('https://api.mux.com' + p, { ...init, headers: { Authorization: auth, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000) })
        .then(async r => { const b = await r.json().catch(() => ({})); if (!r.ok && r.status !== 204) throw new Error(b?.error?.messages?.[0] || 'Mux ' + r.status); return b; });
      const t0 = Date.now(); let page = Math.max(1, Number(body.page) || 1), changed = 0, failed = 0, more = true;
      // One video or camera: what this step does to its playback IDs
      const fix = async (base, ids) => {
        const has = p => (ids || []).some(x => x.policy === p);
        try {
          if (step === 'add' && !has('signed')) { await mux(`${base}/playback-ids`, { method: 'POST', body: JSON.stringify({ policy: 'signed' }) }); changed++; }
          if (step === 'undo' && !has('public')) { await mux(`${base}/playback-ids`, { method: 'POST', body: JSON.stringify({ policy: 'public' }) }); changed++; }
          if (step === 'lock' && has('signed')) for (const x of ids.filter(x => x.policy === 'public')) { await mux(`${base}/playback-ids/${x.id}`, { method: 'DELETE' }); changed++; }
        } catch (e) { failed++; console.error('[media] switch', slug, step, base, e.message); }
      };
      // Cameras first (one page), then the videos page by page, until about 4 minutes have gone
      if (page === 1) for (const s of (await mux('/video/v1/live-streams?limit=100')).data || []) await fix(`/video/v1/live-streams/${s.id}`, s.playback_ids);
      while (Date.now() - t0 < 240e3) {
        const list = (await mux(`/video/v1/assets?limit=100&page=${page}`)).data || [];
        for (const a of list) await fix(`/video/v1/assets/${a.id}`, a.playback_ids);
        if (list.length < 100) { more = false; break; }
        page++;
      }
      if (!more && step === 'lock') {
        // Kept playback IDs that just stopped: Brand Kit videos' watermarked copies get their signed ID;
        // the long forms' sound checks are made again
        const wm = await redis.hGetAll(`brand_video_wm:${slug}`).catch(() => ({})) || {};
        for (const [path, v] of Object.entries(wm)) {
          try { const o = JSON.parse(v); if (!o.assetId) continue; const a = (await mux(`/video/v1/assets/${o.assetId}`)).data; const sp = (a?.playback_ids || []).find(x => x.policy === 'signed'); if (sp) await redis.hSet(`brand_video_wm:${slug}`, path, JSON.stringify({ ...o, pid: sp.id })); } catch {}
        }
        for await (const batch of redis.scanIterator({ MATCH: 'lf_sound2:*', COUNT: 200 })) { const ks = [].concat(batch); if (ks.length) await redis.del(ks); }
        await redis.hSet('signed_accounts', slug, String(Date.now()));
      }
      if (!more && step === 'undo') await redis.hDel('signed_accounts', slug).catch(() => {});
      console.log('[media] switch', slug, step, 'changed', changed, 'failed', failed, more ? 'page ' + page + ' next' : 'done');
      return res.status(200).json({ changed, failed, more, page: more ? page : null });
    }

    if (body.action === 'copyBrand') {
      // Brand Kit files into the private store (same paths; files already there are skipped), about 4 minutes a call
      if (!platformAdmins().includes(session.email) || !isAdminVenue(session.venue)) return res.status(403).json({ error: 'Only local / assets' });
      return res.status(200).json(await copyToPrivate('brand/', body.cursor || undefined));
    }

    if (body.action === 'check') {
      if (!platformAdmins().includes(session.email) || !isAdminVenue(session.venue)) return res.status(403).json({ error: 'Only local / assets' });
      const accounts = [], signedAt = await redis.hGetAll('signed_accounts').catch(() => ({})) || {};
      for (const slug of Object.keys(getVenuesConfig())) {
        const auth = authOf(slug);
        if (!auth) { accounts.push({ slug, ok: false, error: 'No Cloud Storage' }); continue; }
        try { const s = await signingFor(redis, auth); accounts.push({ slug, ok: true, siteOnly: !!s.restriction, locked: Number(signedAt[slug]) || null }); }
        catch (e) { accounts.push({ slug, ok: false, error: e.message }); }
      }
      return res.status(200).json({ accounts, brandPrivate: privateBrand(), privateStore: !!process.env.LA_PRIVATE_READ_WRITE_TOKEN });
    }
    return res.status(400).json({ error: 'Unknown action' });
  } finally { await redis.quit().catch(() => {}); }
}
