import crypto from 'crypto';
import { sealSecret, openSecret } from './_venues.js';

// Signed playback (Mux): every video, thumbnail and MP4 needs a short-lived ticket (a JWT signed with the
// Mux storage's own signing key), which /api/media gives only to someone signed in to that account.
// Each Mux storage (one per account) gets its signing key and a "site only" playback rule the first time
// they're needed; both are kept in Redis (the key sealed): hash mux_signing, field = the storage's token id.
//   ticket claims: sub = playback ID, aud = v (video, MP4), t (thumbnail), g (GIF), s (storyboard), exp,
//   and the playback modifiers (time, width, asset_start_time, max_resolution…), which a signed URL must
//   carry inside the ticket instead of in its query.
const SIGNING = 'mux_signing';
const muxApi = (auth, p, init = {}) => fetch('https://api.mux.com' + p, {
  ...init, headers: { Authorization: auth, 'Content-Type': 'application/json', ...(init.headers || {}) }, signal: AbortSignal.timeout(15000),
}).then(async r => { const b = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(b?.error?.messages?.[0] || `Mux ${r.status}`), { status: r.status }); return b; });

// Which Mux storage an auth header opens (its access token id)
export const storageOf = auth => { try { return Buffer.from(String(auth).replace(/^Basic /, ''), 'base64').toString().split(':')[0]; } catch { return ''; } };

const _mem = new Map();   // storage → { kid, pem, restriction } for this function instance
export async function signingFor(redis, auth) {
  const env = storageOf(auth);
  if (!env) throw new Error('No Cloud Storage');
  if (_mem.has(env)) return _mem.get(env);
  let s = null;
  try { const v = await redis.hGet(SIGNING, env); if (v) s = JSON.parse(openSecret(v) || 'null'); } catch {}
  if (!s?.kid || !s?.pem) {
    // A signing key for this storage (needs an access token with System write; else the error says so)
    const k = await muxApi(auth, '/system/v1/signing-keys', { method: 'POST' }).catch(e => {
      throw new Error(e.status === 401 || e.status === 403 ? 'This account\'s Cloud Storage token can\'t make signing keys (it needs System read/write in Mux)' : 'Signing key: ' + e.message);
    });
    s = { kid: k.data.id, pem: Buffer.from(k.data.private_key, 'base64').toString('utf8') };
  }
  if (!s.restriction) {
    // Plays only on local-assets.com (and the apps and our own servers, which send no referrer)
    const r = await muxApi(auth, '/video/v1/playback-restrictions', { method: 'POST', body: JSON.stringify({
      referrer: { allowed_domains: ['local-assets.com', '*.local-assets.com'], allow_no_referrer: true },
    }) }).catch(e => { console.error('[signing] playback restriction', env, e.message); return null; });
    if (r?.data?.id) s.restriction = r.data.id;
  }
  await redis.hSet(SIGNING, env, sealSecret(JSON.stringify(s)));
  _mem.set(env, s);
  return s;
}

const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
export function ticket(s, pid, aud, claims = {}, ttlSec = 2 * 3600) {
  const head = b64({ alg: 'RS256', typ: 'JWT', kid: s.kid });
  const body = b64({ sub: pid, aud, exp: Math.floor(Date.now() / 1000) + ttlSec, kid: s.kid,
    ...(s.restriction ? { playback_restriction_id: s.restriction } : {}), ...claims });
  const sig = crypto.createSign('RSA-SHA256').update(head + '.' + body).sign(s.pem).toString('base64url');
  return head + '.' + body + '.' + sig;
}

// A stream.mux.com or image.mux.com address, signed: its query becomes the ticket's claims.
// Numbers stay numbers (Mux reads time=12.5, width=640 as numbers).
export function signUrl(s, url, ttlSec) {
  const u = new URL(url);
  const m = /^\/([A-Za-z0-9]+)(\/.*|\.[a-z0-9]+)?$/.exec(u.pathname);
  if (!m) throw new Error('Not a playback address');
  const pid = m[1], rest = m[2] || '';
  const aud = u.hostname === 'image.mux.com' ? (/^\/animated\./.test(rest) ? 'g' : /^\/storyboard\./.test(rest) ? 's' : 't') : 'v';
  const claims = {};
  for (const [k, v] of u.searchParams) if (k !== 'token') claims[k] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
  return `${u.origin}/${pid}${rest}?token=${ticket(s, pid, aud, claims, ttlSec)}`;
}

// The tickets Mux Player takes (playback, thumbnail, storyboard) for one playback ID
export function playerTickets(s, pid, ttlSec) {
  return { playback: ticket(s, pid, 'v', {}, ttlSec), thumbnail: ticket(s, pid, 't', {}, ttlSec), storyboard: ticket(s, pid, 's', {}, ttlSec) };
}

// Our own servers reading a video (clips, watermarks, uploads to YouTube and SoundCloud, the a™ renders):
// the address signed when the video is signed (its policy looked up once, kept 30 days), as it is when public.
// ttlSec: as long as the job may read it (a Mac render reads for hours).
export async function muxUrl(redis, auth, url, ttlSec = 6 * 3600) {
  let u; try { u = new URL(url); } catch { return url; }
  if (!/^(stream|image)\.mux\.com$/.test(u.hostname)) return url;
  const pid = (/^\/([A-Za-z0-9]+)/.exec(u.pathname) || [])[1];
  if (!pid || !auth) return url;
  const key = `pid_policy:${pid}`;
  let policy = _policy.get(pid) || await redis.get(key).catch(() => null);
  if (!policy) {
    const r = await fetch(`https://api.mux.com/video/v1/playback-ids/${encodeURIComponent(pid)}`, { headers: { Authorization: auth }, signal: AbortSignal.timeout(10000) }).catch(() => null);
    if (!r || !r.ok) return url;
    policy = (await r.json()).data?.policy || 'public';
    await redis.set(key, policy, { EX: 30 * 86400 }).catch(() => {});
  }
  _policy.set(pid, policy);
  if (policy !== 'signed') return url;
  return signUrl(await signingFor(redis, auth), url, ttlSec);
}
const _policy = new Map();

// The same, for code without a Redis connection of its own: one is opened only when the key or the
// video's policy isn't known in this function yet
export async function muxUrlAuto(auth, url, ttlSec) {
  let pid = ''; try { pid = (/^\/([A-Za-z0-9]+)/.exec(new URL(url).pathname) || [])[1] || ''; } catch { return url; }
  const env = storageOf(auth);
  if (_policy.get(pid) === 'public') return url;
  if (_policy.get(pid) === 'signed' && _mem.has(env)) return signUrl(_mem.get(env), url, ttlSec);
  const { createClient } = await import('redis');
  const redis = createClient({ url: (process.env.UPSTASH_REDIS_URL || process.env.REDIS_URL) });
  await redis.connect();
  try { return await muxUrl(redis, auth, url, ttlSec); } finally { await redis.quit().catch(() => {}); }
}
