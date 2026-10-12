import crypto from 'crypto';
import { put } from '@vercel/blob';
import { createClient } from 'redis';
import { getWebSessionAuth } from './_venues.js';
import { resolveWatermark } from './_watermark.js';
import { renderWatermarkPng, VERTICAL, HORIZONTAL } from './_watermark-render.js';

// Puts the Brand Kit watermark on a session's vertical clips, and takes it off again.
// A clip is clean when Mux cut it straight from the full recording; a watermarked clip is a copy of
// another clip with the watermark on top (Mux's source_asset_id tells them apart).
// Applying always starts from a clean clip, so a watermark is never stamped twice: the clean clip is kept
// hidden (tag "… // SOCIALRAW // NN") while the watermarked copy takes its place.
// Removing brings the clean clips back; when a clean clip no longer exists it is cut again from the
// full recording at the same times the upload pipeline used.
//   POST { action: 'apply', artist, date, clipIds: [...] }
//   POST { action: 'remove', artist, date }   (also 'restore')
//   POST { action: 'sweep' }   finishes pending swaps and reports which clips carry a watermark

const muxReq = (auth, path, init = {}) => fetch('https://api.mux.com' + path, {
  ...init,
  headers: { Authorization: auth, 'Content-Type': 'application/json', ...(init.headers || {}) },
  signal: AbortSignal.timeout(15000),
}).then(async r => {
  const body = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(body?.error?.messages?.[0] || `Mux ${r.status}`); e.status = r.status; throw e; }
  return body.data;
});
const del = (auth, id) => muxReq(auth, `/video/v1/assets/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(e => { if (e.status !== 404) throw e; });
const setTag = (auth, id, passthrough) => muxReq(auth, `/video/v1/assets/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ passthrough }) });

const swapsKey = slug => `wm_swaps:${slug}`;   // hash newId → JSON { old: clip it replaces }
const markedKey = slug => `wm_marked:${slug}`;   // set of the watermarked copies this app made
// Copies made by the earlier version were listed in wm_raw (watermarked clip → its original)
const markedSet = async (redis, slug) => new Set([...await redis.sMembers(markedKey(slug)), ...await redis.hKeys(`wm_raw:${slug}`)]);
const parseSwap = v => { try { const o = JSON.parse(v); if (o && o.old) return o; } catch {} return { old: v }; };
const SUB = /^(.+?) \/\/ (SOCIAL|SOCIALRAW) \/\/ (\d+)$/i;
const tagFor = (artist, n, hidden) => `${artist} // ${hidden ? 'SOCIALRAW' : 'SOCIAL'} // ${String(n).padStart(2, '0')}`;

// The vertical clips the upload pipeline cuts from a full recording (same times as api/mux-webhook.js)
function clipTimes(duration) {
  const count = Math.min(Math.floor(duration / 30), 5);
  if (count < 1) return [];
  const seg = Math.min(45, duration / count);
  const gap = (duration - seg * count) / (count + 1);
  return Array.from({ length: count }, (_, i) => { const start = gap * (i + 1) + seg * i; return { n: i + 1, start, end: Math.min(start + seg, duration) }; });
}

async function listAllAssets(auth) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const batch = await muxReq(auth, `/video/v1/assets?limit=100&page=${page}`);
    out.push(...(batch || []));
    if (!batch || batch.length < 100) break;
  }
  return out;
}

// Clean = cut straight from a recording (or uploaded), not copied from another clip
function cleanCheck(assets, marked = new Set()) {
  const byId = new Map(assets.map(a => [a.id, a]));
  return a => {
    if (marked.has(a.id)) return false;
    const src = a.source_asset_id;
    if (!src) return true;
    const s = byId.get(src);
    if (!s) return false;   // its source is gone: only clips are ever deleted, so it was copied from a clip
    return !SUB.test(String(s.passthrough || '').trim()) && !/ \/\/ SOCIAL/i.test(String(s.passthrough || ''));
  };
}

// The session's full recording and its clips by number: { master, shown: Map(n → asset), hidden: Map(n → [assets]) }
function sessionClips(assets, artist, date) {
  const masterOf = a => {
    const pt = String(a.passthrough || '').trim();
    if (pt.toUpperCase() === artist) return true;
    try { const o = JSON.parse(pt); return o && String(o.artist || '').toUpperCase().trim() === artist && !['AUDIO', 'SOCIAL', 'THUMB'].includes(String(o.camera || '').toUpperCase()); } catch { return false; }
  };
  const day = a => new Date(Number(a.created_at) * 1000).toISOString().slice(0, 10);
  const masters = assets.filter(a => a.status === 'ready' && masterOf(a) && Number(a.duration) > 10)
    .sort((a, b) => Number(b.created_at) - Number(a.created_at));
  const master = masters.find(a => day(a) === date) || masters[0] || null;
  const shown = new Map(), hidden = new Map();
  if (!master) return { master, shown, hidden };
  // Clips of this session: made after this recording and before the artist's next one
  const next = masters.filter(a => Number(a.created_at) > Number(master.created_at)).pop();
  for (const a of assets) {
    const m = SUB.exec(String(a.passthrough || '').trim());
    if (!m || m[1].toUpperCase() !== artist) continue;
    if (Number(a.created_at) < Number(master.created_at) || (next && Number(a.created_at) >= Number(next.created_at))) continue;
    const n = Number(m[3]);
    if (m[2].toUpperCase() === 'SOCIAL') shown.set(n, a);
    else hidden.set(n, [...(hidden.get(n) || []), a]);
  }
  return { master, shown, hidden };
}

// Takes the watermark off a session: every clip back to a clean one, missing clips cut again
async function removeWatermark(redis, slug, auth, artist, date) {
  const assets = await listAllAssets(auth);
  const isClean = cleanCheck(assets, await markedSet(redis, slug));
  const { master, shown, hidden } = sessionClips(assets, artist, date);
  if (!master) return { restored: 0, recreated: 0, error: 'The full recording of this session is not in Cloud Storage, so the clean clips cannot be made again.' };
  const pendingOld = new Set(Object.values(await redis.hGetAll(swapsKey(slug))).map(v => parseSwap(v).old));
  let restored = 0, recreated = 0;
  const numbers = new Set([...clipTimes(Number(master.duration)).map(t => t.n), ...shown.keys()]);
  const times = new Map(clipTimes(Number(master.duration)).map(t => [t.n, t]));
  for (const n of [...numbers].sort((a, b) => a - b)) {
    const cur = shown.get(n);
    if (cur && (isClean(cur) || pendingOld.has(cur.id))) continue;
    const spare = hidden.get(n) || [];
    const clean = spare.find(a => isClean(a) && a.status === 'ready');
    if (clean) {
      await setTag(auth, clean.id, tagFor(artist, n));
      restored++;
    } else if (times.has(n)) {
      const t = times.get(n);
      await muxReq(auth, '/video/v1/assets', {
        method: 'POST',
        body: JSON.stringify({
          input: [{ url: `mux://assets/${master.id}`, start_time: t.start, end_time: t.end }],
          playback_policy: ['public'], passthrough: tagFor(artist, n), static_renditions: [{ resolution: 'highest' }],
        }),
      });
      recreated++;
    } else continue;
    // The watermarked clip and any other leftover versions of this clip go
    if (cur) { await del(auth, cur.id); await redis.sRem(markedKey(slug), cur.id); }
    for (const a of spare) if (a !== clean) { await del(auth, a.id); await redis.sRem(markedKey(slug), a.id); }
  }
  return { restored, recreated };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();
  const session = getWebSessionAuth(req);
  if (!session?.email) return res.status(401).json({ error: 'Not authenticated' });
  if (!session.venueSlug || !session.muxAuth) return res.status(403).json({ error: 'No Cloud Storage for this account' });
  const slug = session.venueSlug, auth = session.muxAuth;
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});

  const redis = createClient({ url: process.env.REDIS_URL });
  await redis.connect();
  try {
    if (body.action === 'sweep') {
      const swaps = await redis.hGetAll(swapsKey(slug));
      let done = 0, pending = 0;
      for (const [newId, val] of Object.entries(swaps)) {
        const { old: oldId } = parseSwap(val);
        let status;
        try { status = (await muxReq(auth, `/video/v1/assets/${encodeURIComponent(newId)}`)).status; }
        catch (e) { status = e.status === 404 ? 'gone' : 'unknown'; }
        if (status === 'ready') {
          // The watermarked copy is in place: a clean clip it replaced is kept hidden, a watermarked one goes
          const old = await muxReq(auth, `/video/v1/assets/${encodeURIComponent(oldId)}`).catch(() => null);
          if (old) {
            const all = old.source_asset_id ? [old, await muxReq(auth, `/video/v1/assets/${encodeURIComponent(old.source_asset_id)}`).catch(() => null)].filter(Boolean) : [old];
            if (cleanCheck(all, await markedSet(redis, slug))(old)) await setTag(auth, oldId, String(old.passthrough || '').replace(/ \/\/ SOCIAL(?= \/\/|$)/i, ' // SOCIALRAW'));
            else { await del(auth, oldId); await redis.sRem(markedKey(slug), oldId); }
          }
          await redis.hDel(swapsKey(slug), newId); done++;
        } else if (status === 'errored' || status === 'gone') {
          // The copy failed: keep the clip, drop the copy
          if (status === 'errored') await del(auth, newId).catch(() => {});
          await redis.sRem(markedKey(slug), newId);
          await redis.hDel(swapsKey(slug), newId);
        } else pending++;
      }
      // Which shown clips carry a watermark
      const assets = await listAllAssets(auth);
      const isClean = cleanCheck(assets, await markedSet(redis, slug));
      const watermarked = assets.filter(a => /^.+ \/\/ SOCIAL \/\/ \d+$/i.test(String(a.passthrough || '').trim()) && !isClean(a)).map(a => a.id);
      const pendingIds = Object.values(await redis.hGetAll(swapsKey(slug))).map(v => parseSwap(v).old);
      return res.status(200).json({ done, pending, watermarked, pendingIds });
    }

    if (body.action === 'remove' || body.action === 'restore') {
      const artist = String(body.artist || '').toUpperCase().trim();
      if (!artist) return res.status(400).json({ error: 'Choose a session' });
      const out = await removeWatermark(redis, slug, auth, artist, String(body.date || ''));
      if (out.error) return res.status(400).json(out);
      return res.status(200).json(out);
    }

    if (body.action !== 'apply') return res.status(400).json({ error: 'Unknown action' });
    const artist = String(body.artist || '').toUpperCase().trim();
    const ids = Array.isArray(body.clipIds) ? body.clipIds.map(String).slice(0, 30) : [];
    if (!artist || !ids.length) return res.status(400).json({ error: 'Choose a session with vertical clips' });

    const wm = await resolveWatermark(redis, slug, artist);
    if (!wm) return res.status(400).json({ error: 'The watermark is off, or there is no logo or text to apply. Set it up in Brand Kit.' });

    // One overlay per clip shape and size, drawn at the clip's own resolution so it stays sharp
    const overlays = new Map();
    const overlayFor = async (w, h) => {
      const L = w > h ? HORIZONTAL : VERTICAL;
      const width = Math.max(L.W, Math.round(w) || L.W);
      const key = `${L.W}x${L.H}@${width}`;
      if (!overlays.has(key)) {
        overlays.set(key, (async () => {
          const png = await renderWatermarkPng(wm, L, width);
          if (!png) throw new Error('The watermark could not be drawn. Check the logo and font in Brand Kit.');
          return (await put(`watermarks/${slug}/${crypto.randomBytes(6).toString('hex')}.png`, png, { access: 'public', contentType: 'image/png', addRandomSuffix: false })).url;
        })());
      }
      return overlays.get(key);
    };
    const videoSize = a => { const t = (a.tracks || []).find(x => x.type === 'video'); return t ? [Number(t.max_width) || 0, Number(t.max_height) || 0] : [0, 0]; };

    const assets = await listAllAssets(auth);
    const byId = new Map(assets.map(a => [a.id, a]));
    const isClean = cleanCheck(assets, await markedSet(redis, slug));
    const { master, hidden } = sessionClips(assets, artist, String(body.date || ''));
    const times = master ? new Map(clipTimes(Number(master.duration)).map(t => [t.n, t])) : new Map();
    const pendingOld = new Set(Object.values(await redis.hGetAll(swapsKey(slug))).map(v => parseSwap(v).old));
    let started = 0;
    const errors = [];
    for (const id of ids) {
      if (pendingOld.has(id)) continue;
      try {
        const clip = byId.get(id) || await muxReq(auth, `/video/v1/assets/${encodeURIComponent(id)}`);
        const pt = String(clip.passthrough || '').trim();
        const m = SUB.exec(pt);
        // Only this session's vertical clips, from this venue's own Cloud Storage
        if (!m || m[1].toUpperCase() !== artist) { errors.push(`One clip isn't a vertical clip of ${artist}`); continue; }
        const n = Number(m[3]);
        // Always from a clean clip: this one, its kept original, or a fresh cut of the full recording
        let input, size;
        const kept = (hidden.get(n) || []).find(a => isClean(a) && a.status === 'ready');
        if (isClean(clip)) { input = { url: `mux://assets/${clip.id}` }; size = videoSize(clip); }
        else if (kept) { input = { url: `mux://assets/${kept.id}` }; size = videoSize(kept); }
        else if (times.has(n)) { const t = times.get(n); input = { url: `mux://assets/${master.id}`, start_time: t.start, end_time: t.end }; size = videoSize(master); }
        else { errors.push(`Clip ${String(n).padStart(2, '0')} has no clean version to start from`); continue; }
        const overlayUrl = await overlayFor(size[0] || 1080, size[1] || 1920);
        const copy = await muxReq(auth, '/video/v1/assets', {
          method: 'POST',
          body: JSON.stringify({
            input: [input, { url: overlayUrl, overlay_settings: { vertical_align: 'top', horizontal_align: 'left', width: '100%', opacity: '100%' } }],
            playback_policy: ['public'],
            passthrough: tagFor(artist, n),
            static_renditions: [{ resolution: 'highest' }],
          }),
        });
        await redis.hSet(swapsKey(slug), copy.id, JSON.stringify({ old: id }));
        await redis.sAdd(markedKey(slug), copy.id);
        started++;
      } catch (e) {
        errors.push(e.message);
      }
    }
    if (errors.length) console.error('[watermark-clips]', slug, errors.join(' | '));
    if (!started && errors.length) return res.status(502).json({ error: errors[0] });
    return res.status(200).json({ started, skipped: ids.length - started - errors.length, failed: errors.length });
  } catch (e) {
    console.error('[watermark-clips]', e.message);
    return res.status(500).json({ error: e.message });
  } finally {
    await redis.quit().catch(() => {});
  }
}
