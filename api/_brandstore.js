import * as blob from '@vercel/blob';

// Brand Kit files (brand/…): in the private Blob store once LA_PRIVATE_BRAND=1 (after Accounts → Video
// protection → Copy Brand Kit files), in the shared public store before.
// Every file keeps the address it always had (the public store's, by its path): watermarks, profile photos,
// colour looks and posts are saved by address, so they go on matching. The address only names the file:
// the bytes are read through readUrl(), a signed link of a few minutes, given to someone allowed to see it.
export const PUBLIC_BASE = 'https://puws5w9zdemfusjd.public.blob.vercel-storage.com';
const PRIVATE_TOKEN = () => process.env.LA_PRIVATE_READ_WRITE_TOKEN || '';
export const privateBrand = () => process.env.LA_PRIVATE_BRAND === '1' && !!PRIVATE_TOKEN();

export const canon = pathname => new URL(PUBLIC_BASE + '/' + String(pathname).replace(/^\/+/, '')).href;
export const pathOf = url => { try { const u = new URL(url); return /\.blob\.vercel-storage\.com$/.test(u.hostname) ? decodeURIComponent(u.pathname.slice(1)) : null; } catch { return /^brand\//.test(String(url)) ? String(url) : null; } };
const isBrand = p => typeof p === 'string' && p.startsWith('brand/');
const priv = (o = {}) => ({ ...o, access: 'private', token: PRIVATE_TOKEN() });
const asCanon = b => b && ({ ...b, url: canon(b.pathname), downloadUrl: canon(b.pathname) + '?download=1' });

export async function blist(opts) {
  if (!privateBrand() || !isBrand(opts?.prefix)) return blob.list(opts);
  const page = await blob.list(priv(opts));
  return { ...page, blobs: page.blobs.map(asCanon) };
}
export async function bput(pathname, body, opts = {}) {
  if (!privateBrand() || !isBrand(pathname)) return blob.put(pathname, body, opts);
  const r = await blob.put(pathname, body, priv(opts));
  return asCanon(r);
}
export async function bcopy(fromUrl, toPathname, opts = {}) {
  const from = pathOf(fromUrl);
  if (!privateBrand() || !isBrand(from)) return blob.copy(fromUrl, toPathname, opts);
  return asCanon(await blob.copy(from, toPathname, priv(opts)));
}
export async function bdel(urls) {
  const list = [].concat(urls);
  const mine = list.map(pathOf).filter(isBrand);
  if (!privateBrand() || !mine.length) return blob.del(urls);
  await blob.del(mine, { token: PRIVATE_TOKEN() });
  const rest = list.filter(u => !isBrand(pathOf(u)));
  if (rest.length) await blob.del(rest);
}
export async function bhead(urlOrPath) {
  const p = pathOf(urlOrPath) || urlOrPath;
  if (!privateBrand() || !isBrand(p)) return blob.head(urlOrPath);
  return asCanon(await blob.head(p, { token: PRIVATE_TOKEN() }));
}

// A Brand Kit file's bytes: a signed link (ttlSec, 5 minutes unless given) in the private store, the address as
// it is otherwise. Mux and the a™ renders read for longer (pass a day).
let _deleg = null;   // a read-everything delegation, renewed before it ends
export async function readUrl(url, ttlSec = 300) {
  const p = pathOf(url);
  if (!privateBrand() || !isBrand(p)) return url;
  const until = Date.now() + ttlSec * 1000;
  if (!_deleg || _deleg.until < until + 60e3) {
    const validUntil = Math.max(until, Date.now() + 3600e3) + 60e3;
    _deleg = { tok: await blob.issueSignedToken({ token: PRIVATE_TOKEN(), pathname: '*', operations: ['get', 'head'], validUntil }), until: validUntil };
  }
  // Each file's signed link is tried once (kept 10 minutes): a file the private store can't give (not copied
  // there, or the link refused) is read from the public store, which still has every file, and the reason logged
  let signed = null, why = '';
  try { signed = (await blob.presignUrl(_deleg.tok, { operation: 'get', pathname: p, access: 'private', validUntil: until })).presignedUrl; }
  catch (e) { why = 'sign: ' + e.message; }
  const seen = _readable.get(p);
  if (signed && seen && Date.now() - seen.at < 600e3) return seen.ok ? signed : canon(p);
  if (signed) {
    // A GET for its first byte (a link is signed for one operation: a HEAD on a GET link is always refused)
    const r = await fetch(signed, { headers: { Range: 'bytes=0-0', Origin: 'https://local-assets.com' }, signal: AbortSignal.timeout(5000) }).catch(e => ({ ok: false, status: e.message }));
    r.body?.cancel?.().catch?.(() => {});
    if (!r.ok) why = 'HTTP ' + r.status;
    // Pictures are shown with crossorigin: without this header the browser refuses them though the store gave them
    else if (!_corsNoted) { _corsNoted = true; console.log('[brandstore] private read OK, CORS', r.headers.get('access-control-allow-origin') || 'none'); }
    _readable.set(p, { ok: !!r.ok, at: Date.now() });
    if (r.ok) return signed;
  }
  // The first one an hour is an error (a Rollbar alert reaches us); the rest are warnings
  const say = Date.now() - _alertAt > 3600e3 ? (_alertAt = Date.now(), console.error) : console.warn;
  say('[brandstore] private store could not give', p.split('/').slice(0, 3).join('/') + '/…', why, '→ public copy');
  return canon(p);
}
let _alertAt = 0, _corsNoted = false;
const _readable = new Map();   // path → { ok, at }: whether its signed link worked
// fetch() for a Brand Kit file (or any address), through its signed link
export const brandFetch = async (url, init) => fetch(await readUrl(url), init);

// Copies the account's (or every) Brand Kit file from the public store into the private one (same paths),
// skipping files already there; about 4 minutes a call, { more, cursor } to go on
export async function copyToPrivate(prefix = 'brand/', cursor) {
  if (!PRIVATE_TOKEN()) throw new Error('The private store isn\'t connected (LA_PRIVATE_READ_WRITE_TOKEN)');
  const t0 = Date.now(); let copied = 0, skipped = 0, failed = 0;
  do {
    const at = cursor;   // stopped part-way through a page: that page again next time (done files are skipped)
    const page = await blob.list({ prefix, cursor, limit: 100 });
    for (const b of page.blobs) {
      try {
        const there = await blob.head(b.pathname, { token: PRIVATE_TOKEN() }).catch(() => null);
        if (there && there.size === b.size) { skipped++; continue; }
        const r = await fetch(b.url);
        if (!r.ok) throw new Error('read ' + r.status);
        await blob.put(b.pathname, r.body, priv({ addRandomSuffix: false, allowOverwrite: true, contentType: r.headers.get('content-type') || undefined, multipart: b.size > 50e6 }));
        copied++;
      } catch (e) { failed++; console.error('[brandstore] copy', b.pathname, e.message); }
      if (Date.now() - t0 > 240e3) return { copied, skipped, failed, more: true, cursor: at || null };
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return { copied, skipped, failed, more: false };
}

// System Health: one real Brand Kit file of the account (any, if it has none) read through its signed link,
// the way the pages read it. { ok, store, why }: a refused or broken read shows red before anyone sees it.
export async function brandHealth(slug) {
  if (!privateBrand()) return { ok: true, store: 'public' };
  try {
    let page = await blob.list(priv({ prefix: `brand/${slug}/`, limit: 1 }));
    if (!page.blobs.length) page = await blob.list(priv({ prefix: 'brand/', limit: 1 }));
    const f = page.blobs[0];
    if (!f) return { ok: true, store: 'private', why: 'no files yet' };
    _readable.delete(f.pathname);   // a fresh check, not the one kept from earlier
    const url = await readUrl(canon(f.pathname), 60);
    const ok = !!(_readable.get(f.pathname) || {}).ok;
    return { ok, store: 'private', why: ok ? '' : 'pictures are being shown from the public copy', fallback: url.startsWith(PUBLIC_BASE) };
  } catch (e) { return { ok: false, store: 'private', why: e.message }; }
}
