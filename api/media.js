import crypto from 'crypto';
import { createClient } from 'redis';
import { getWebSessionAuth, findVenueByEmail, freshVenues, getVenuesConfig, getMuxAuthForVenue, platformAdmins, isAdminVenue, artistOf, sameArtist } from './_venues.js';
import { signingFor, signUrl, playerTickets } from './_signing.js';

// Every video, thumbnail and download goes through here once videos are signed (Mux signed playback):
// the address is only signed for someone signed in to the account the video belongs to, for 2 hours
// (downloads: 15 minutes, and noted). Addresses of videos still public are passed on as they are.
//   POST { action: 'key' }                 a media key (12 h) for addresses the page can't sign in with (<img>, links)
//   POST { action: 'tickets', pids: [] }   Mux Player's tickets for these playback IDs (null: still public)
//   POST { action: 'sign', urls: [] }      these Mux addresses, signed (scripts that fetch or play directly)
//   GET  ?u=<Mux address>&k=<media key>[&dl=<file name>]   → the signed address (a download when dl is given)
//   POST { action: 'check' }               (local / assets) each account's signing key and site-only rule
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
  const k = req.method === 'GET' ? readKey(req.query?.k) : null;
  if (req.method === 'GET' && !k) return res.status(401).send('Sign in again to see this.');
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();
  const session = req.method === 'POST' ? getWebSessionAuth(req) : null;
  if (req.method === 'POST' && !session?.email) return res.status(401).json({ error: 'Not signed in' });
  await freshVenues();
  const redis = createClient({ url: (process.env.UPSTASH_REDIS_URL || process.env.REDIS_URL) });
  await redis.connect();
  try {
    // <img>, video and download addresses: the media key in the address
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

    if (body.action === 'check') {
      if (!platformAdmins().includes(session.email) || !isAdminVenue(session.venue)) return res.status(403).json({ error: 'Only local / assets' });
      const accounts = [];
      for (const slug of Object.keys(getVenuesConfig())) {
        const auth = authOf(slug);
        if (!auth) { accounts.push({ slug, ok: false, error: 'No Cloud Storage' }); continue; }
        try { const s = await signingFor(redis, auth); accounts.push({ slug, ok: true, siteOnly: !!s.restriction }); }
        catch (e) { accounts.push({ slug, ok: false, error: e.message }); }
      }
      return res.status(200).json({ accounts });
    }
    return res.status(400).json({ error: 'Unknown action' });
  } finally { await redis.quit().catch(() => {}); }
}
