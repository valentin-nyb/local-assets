import { pausedBy, sendPaused } from './_suspend.js';
import crypto from 'crypto';
import { put } from '@vercel/blob';
import { createClient } from 'redis';
import { getWebSessionAuth } from './_venues.js';
import { resolveWatermark } from './_watermark.js';
import { renderWatermarkPng, VERTICAL, HORIZONTAL } from './_watermark-render.js';
import { muxReq, SUB, socialInfo, tagFor, clipTimes, listAllAssets, sessionClips, videoSize, finishVerticals, originalsKey, clipOwner, artistMasters } from './_verticals.js';

// Puts the Brand Kit watermark on a session's vertical clips, and takes it off again.
// The vertical originals are cut once from the full recording (api/_verticals.js). Applying makes a
// watermarked copy of each original, shown in its place while the original is kept hidden
// ("… // SOCIALRAW // NN"). Removing deletes the copies and shows the originals again. Nothing is re-cut here.
//   POST { action: 'apply', artist, date, clipIds: [...] }
//   POST { action: 'remove', artist, date }
//   POST { action: 'sweep' }   finishes pending work and reports which clips are watermarked or not vertical yet

const del = (auth, id) => muxReq(auth, `/video/v1/assets/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(e => { if (e.status !== 404) throw e; });
const setTag = (auth, id, passthrough) => muxReq(auth, `/video/v1/assets/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ passthrough }) });

const swapsKey = slug => `wm_swaps:${slug}`;   // hash newId → JSON { old: clip it replaces }
const markedKey = slug => `wm_marked:${slug}`;   // set of the watermarked copies this app made
// Copies made by the earlier version were listed in wm_raw (watermarked clip → its original)
const markedSet = async (redis, slug) => new Set([...await redis.sMembers(markedKey(slug)), ...await redis.hKeys(`wm_raw:${slug}`)]);
const parseSwap = v => { try { const o = JSON.parse(v); if (o && o.old) return o; } catch {} return { old: v }; };
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

// Takes the watermark off a session: every clip back to a clean one, missing clips cut again
async function removeWatermark(redis, slug, auth, artist, date) {
  const assets = await listAllAssets(auth);
  const isClean = cleanCheck(assets, await markedSet(redis, slug));
  const originals = new Set(await redis.sMembers(originalsKey(slug)));
  const vertical = a => { const [w, h] = videoSize(a); return h > w; };
  const { master, shown, hidden } = sessionClips(assets, artist, date);
  if (!master) return { restored: 0, recreated: 0, error: 'The full recording of this session is not in Cloud Storage, so the clean clips cannot be made again.' };
  const pendingOld = new Set(Object.values(await redis.hGetAll(swapsKey(slug))).map(v => parseSwap(v).old));
  let restored = 0, recreated = 0, missing = 0;
  const numbers = new Set([...clipTimes(Number(master.duration)).map(t => t.n), ...shown.keys()]);
  for (const n of [...numbers].sort((a, b) => a - b)) {
    const cur = shown.get(n);
    if (cur && (isClean(cur) || pendingOld.has(cur.id))) continue;
    const spare = hidden.get(n) || [];
    // The kept vertical original (cut once from the full recording)
    const clean = spare.find(a => isClean(a) && a.status === 'ready' && vertical(a));
    if (clean) {
      await setTag(auth, clean.id, tagFor(artist, n));
      restored++;
    } else {
      // No original kept for this clip: it comes from the vertical originals cut (never re-cut here)
      missing++;
      continue;
    }
    // The watermarked clip and any other leftover versions of this clip go
    if (cur) { await del(auth, cur.id); await redis.sRem(markedKey(slug), cur.id); }
    for (const a of spare) if (a !== clean && !originals.has(a.id)) { await del(auth, a.id); await redis.sRem(markedKey(slug), a.id); }
  }
  return { restored, recreated, missing };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();
  const session = getWebSessionAuth(req);
  if (!session?.email) return res.status(401).json({ error: 'Not authenticated' });
  if (!session.venueSlug || !session.muxAuth) return res.status(403).json({ error: 'No Cloud Storage for this account' });
  const slug = session.venueSlug, auth = session.muxAuth;
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  if (body.action === 'apply') { const _p = await pausedBy(slug, body.artist ? `artist:${String(body.artist).toUpperCase()}` : null); if (_p) return sendPaused(res, _p); }

  const redis = createClient({ url: process.env.REDIS_URL });
  await redis.connect();
  try {
    if (body.action === 'sweep') {
      const swaps = await redis.hGetAll(swapsKey(slug));
      let done = 0, pending = 0;
      for (const [newId, val] of Object.entries(swaps)) {
        const { old: oldId, n: swapN } = parseSwap(val);
        let status;
        try { status = (await muxReq(auth, `/video/v1/assets/${encodeURIComponent(newId)}`)).status; }
        catch (e) { status = e.status === 404 ? 'gone' : 'unknown'; }
        if (status === 'ready') {
          // The watermarked copy is in place: a clean clip it replaced is kept hidden, a watermarked one goes
          const old = await muxReq(auth, `/video/v1/assets/${encodeURIComponent(oldId)}`).catch(() => null);
          if (old) {
            const all = old.source_asset_id ? [old, await muxReq(auth, `/video/v1/assets/${encodeURIComponent(old.source_asset_id)}`).catch(() => null)].filter(Boolean) : [old];
            if (cleanCheck(all, await markedSet(redis, slug))(old)) { const oi = socialInfo(old); await setTag(auth, oldId, oi ? tagFor(oi.artist, oi.n || swapN || 1, true) : String(old.passthrough || '').replace(/ \/\/ SOCIAL(?= \/\/|$)/i, ' // SOCIALRAW')); }
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
      // Which shown clips carry a watermark, and which aren't vertical yet
      let assets = await listAllAssets(auth);
      const v = await finishVerticals(redis, slug, auth, assets);
      if (v.done) assets = await listAllAssets(auth);
      const isClean = cleanCheck(assets, await markedSet(redis, slug));
      const watermarked = assets.filter(a => /^.+ \/\/ SOCIAL \/\/ \d+$/i.test(String(a.passthrough || '').trim()) && !isClean(a)).map(a => a.id);
      const pendingIds = Object.values(await redis.hGetAll(swapsKey(slug))).map(v => parseSwap(v).old);
      // Shown clips that aren't vertical originals yet (or watermarked copies of them): these get cut once
      const originals = new Set(await redis.sMembers(originalsKey(slug)));
      const horizontal = assets.filter(a => {
        const info = socialInfo(a);
        if (!info || info.hidden) return false;
        return !originals.has(a.id) && !originals.has(a.source_asset_id);
      }).map(a => a.id);
      return res.status(200).json({ done: done + v.done, pending: pending + v.pending, verticalsPending: v.pending, watermarked, horizontal, pendingIds });
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

    const assets = await listAllAssets(auth);
    const byId = new Map(assets.map(a => [a.id, a]));
    const isClean = cleanCheck(assets, await markedSet(redis, slug));
    const { hidden, master: sessionMaster } = sessionClips(assets, artist, String(body.date || ''));
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
        // Clips in older tag formats are numbered by their place in the session
        const info = socialInfo(clip);
        if (!info || info.artist !== artist) { errors.push(`One clip isn't a clip of ${artist}`); continue; }
        // Only clips of this session (never another session's clips)
        if (sessionMaster && clipOwner(clip, byId, artistMasters(assets, artist)) !== sessionMaster.id) { errors.push(`One clip belongs to another session of ${artist}`); continue; }
        const n = info.n || (ids.indexOf(id) + 1);
        // Always from the clean vertical original: this clip, or the original kept hidden behind it
        let input, size;
        const kept = (hidden.get(n) || []).find(a => isClean(a) && a.status === 'ready');
        if (isClean(clip)) { input = { url: `mux://assets/${clip.id}` }; size = videoSize(clip); }
        else if (kept) { input = { url: `mux://assets/${kept.id}` }; size = videoSize(kept); }
        else { errors.push(`Clip ${String(n).padStart(2, '0')} has no clean version to start from.`); continue; }
        const overlayUrl = await overlayFor(size[0] || 1080, size[1] || 1920);
        const copy = await muxReq(auth, '/video/v1/assets', {
          method: 'POST',
          body: JSON.stringify({
            input: [input, { url: overlayUrl, overlay_settings: { vertical_align: 'top', horizontal_align: 'left', width: '100%', opacity: '100%' } }],
            playback_policy: ['public'],
            passthrough: tagFor(artist, n),
            ...(sessionMaster ? { meta: { external_id: sessionMaster.id } } : {}),
            static_renditions: [{ resolution: 'highest' }],
          }),
        });
        await redis.hSet(swapsKey(slug), copy.id, JSON.stringify({ old: id, n }));
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
