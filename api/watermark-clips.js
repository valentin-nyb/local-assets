import { pausedBy, sendPaused } from './_suspend.js';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { waitUntil } from '@vercel/functions';
import { put } from '@vercel/blob';
import { createClient } from 'redis';
import { getWebSessionAuth } from './_venues.js';
import { resolveWatermark } from './_watermark.js';
import { renderWatermarkPng, renderWatermarkParts, animatedLogo, VERTICAL, HORIZONTAL } from './_watermark-render.js';
import { run, signJob, verifyJob, venueAuth as venueAuthFor, muxReq, SUB, socialInfo, tagFor, clipTimes, listAllAssets, sessionClips, videoSize, finishVerticals, originalsKey, clipOwner, artistMasters } from './_verticals.js';

// Puts the Brand Kit watermark on a session's vertical clips, and takes it off again.
// The vertical originals are cut once from the full recording (api/_verticals.js). Applying makes a
// watermarked copy of each original, shown in its place while the original is kept hidden
// ("… // SOCIALRAW // NN"). Removing deletes the copies and shows the originals again. Nothing is re-cut here.
//   POST { action: 'apply', artist, date, clipIds: [...] }
//   POST { action: 'remove', artist, date }
//   POST { action: 'sweep' }   finishes pending work and reports which clips are watermarked or not vertical yet

const del = (auth, id) => muxReq(auth, `/video/v1/assets/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(e => { if (e.status !== 404) throw e; });
const setTag = (auth, id, passthrough) => muxReq(auth, `/video/v1/assets/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ passthrough }) });

export const config = { maxDuration: 300 };
const animKey = slug => `wm_anim:${slug}`;   // hash clip id → time: clips being drawn with a moving (GIF) logo
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

// A moving (GIF) logo: Mux overlays only take still images, so the clip is drawn again with ffmpeg,
// the GIF looping in the logo's place over the clean clip, the text as a still layer. One clip per call.
async function animateClip(job) {
  const redis = createClient({ url: process.env.REDIS_URL });
  await redis.connect();
  const out = path.join(os.tmpdir(), `wm-${job.oldId}-${Date.now()}.mp4`);
  const auth = venueAuthFor(job.slug);
  try {
    const a = job.at;
    const filter = `[1:v]scale=${job.vw}:${job.vh}[b];[2:v]scale=${Math.round(a.w * job.vw / a.W / 2) * 2}:${Math.round(a.h * job.vw / a.W / 2) * 2}:flags=lanczos,format=rgba,colorchannelmixer=aa=${a.opacity}[g];` +
      `[0:v][b]overlay=0:0[v1];[v1][g]overlay=${Math.round(a.left * job.vw / a.W)}:${Math.round(a.top * job.vw / a.W)}:shortest=1,format=yuv420p[v]`;
    const enc = (src) => run(['-hide_banner', '-loglevel', 'warning', '-y', '-i', src, '-i', job.base, '-ignore_loop', '0', '-i', job.gif,
      '-filter_complex', filter, '-map', '[v]', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'copy', '-movflags', '+faststart', out]);
    const size = () => (fs.existsSync(out) ? fs.statSync(out).size : 0);
    await enc(`https://stream.mux.com/${job.pid}/highest.mp4`).catch(e => console.error('[watermark-gif] mp4', e.message));
    if (size() < 100 * 1024) await enc(`https://stream.mux.com/${job.pid}.m3u8?rendition_order=desc`);
    if (size() < 100 * 1024) throw new Error('The clip could not be read');
    const blob = await put(`watermarks/${job.slug}/gif-${crypto.randomBytes(6).toString('hex')}.mp4`, fs.readFileSync(out), { access: 'public', contentType: 'video/mp4', addRandomSuffix: false, multipart: size() > 50 * 1024 * 1024 });
    const copy = await muxReq(auth, '/video/v1/assets', {
      method: 'POST',
      body: JSON.stringify({ input: [{ url: blob.url }], playback_policy: ['public'], passthrough: tagFor(job.artist, job.n),
        ...(job.masterId ? { meta: { external_id: job.masterId } } : {}), static_renditions: [{ resolution: 'highest' }] }),
    });
    await redis.hSet(swapsKey(job.slug), copy.id, JSON.stringify({ old: job.oldId, n: job.n }));
    await redis.sAdd(markedKey(job.slug), copy.id);
    console.log('[watermark-gif]', job.slug, job.artist, job.n, Math.round(size() / 1024) + ' KB');
  } catch (e) {
    console.error('[watermark-gif] failed', job.slug, job.n, e.message);
  } finally {
    await redis.hDel(animKey(job.slug), job.oldId).catch(() => {});
    fs.rm(out, { force: true }, () => {});
    await redis.quit().catch(() => {});
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();
  // One clip's moving-logo render, started by "apply" (signed by the server, not a signed-in user)
  {
    const b = typeof req.body === 'string' ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })() : (req.body || {});
    if (b.action === 'animate') {
      const job = verifyJob(b.job);
      if (!job || job.kind !== 'wm-gif') return res.status(401).json({ error: 'Invalid job' });
      waitUntil(animateClip(job));
      return res.status(202).json({ ok: true });
    }
  }
  const session = getWebSessionAuth(req);
  if (!session?.email) return res.status(401).json({ error: 'Not authenticated' });
  if (!session.venueSlug || !session.muxAuth) return res.status(403).json({ error: 'No Cloud Storage for this account' });
  const slug = session.venueSlug, auth = session.muxAuth;
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  if (body.action === 'apply') { const _p = await pausedBy(slug, body.artist ? `artist:${String(body.artist).toUpperCase()}` : null); if (_p) return sendPaused(res, _p); }

  // Brand Kit "Export GIF": the watermark with a moving logo as an animated GIF, at 4K, transparent
  if (body.action === 'exportGif') {
    const w = body.watermark || {};
    // Only files from this account's own Brand Kit are read
    const own = u => typeof u === 'string' && /^https:\/\/[a-z0-9]+\.public\.blob\.vercel-storage\.com\//i.test(u) && new URL(u).pathname.startsWith(`/brand/${slug}/`);
    if (!own(w.url) || !/\.gif(\?|$)/i.test(w.url)) return res.status(400).json({ error: 'Choose a GIF logo from your Brand Kit' });
    const text = w.text && own(w.text.font) && String(w.text.value || '').trim()
      ? { value: String(w.text.value).slice(0, 60), font: w.text.font, position: /^[tb][lr]$/.test(w.text.position) ? w.text.position : 'br', size: ['s', 'm', 'l'].includes(w.text.size) ? w.text.size : 'm', color: w.text.color === 'black' ? 'black' : 'white' } : null;
    const wm = { url: w.url, position: /^[tb][lr]$/.test(w.position) ? w.position : 'bl', size: ['s', 'm', 'l'].includes(w.size) ? w.size : 'm', opacity: Math.min(1, Math.max(0.3, Number(w.opacity) || 0.9)), text };
    const frame = await animatedLogo(wm);
    if (!frame) return res.status(400).json({ error: 'This GIF has only one frame: use Export PNG' });
    const L = w.frame === 'horizontal' ? HORIZONTAL : VERTICAL;
    const width = L.W * 2;   // top resolution: 2160×3840 (vertical) or 3840×2160 (horizontal)
    const parts = await renderWatermarkParts(wm, L, width, frame);
    const a = parts.logoAt, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmgif-'));
    try {
      fs.writeFileSync(path.join(dir, 'base.png'), parts.png);
      const out = path.join(dir, 'watermark.gif');
      await run(['-hide_banner', '-loglevel', 'warning', '-y', '-loop', '1', '-i', path.join(dir, 'base.png'), '-i', wm.url,
        '-filter_complex', `[1:v]scale=${a.w}:${a.h}:flags=lanczos,format=rgba,colorchannelmixer=aa=${a.opacity}[g];[0:v][g]overlay=${a.left}:${a.top}:shortest=1,split[x][y];[x]palettegen=reserve_transparent=1:stats_mode=full[p];[y][p]paletteuse=alpha_threshold=96:dither=none`,
        '-loop', '0', out]);
      const blob = await put(`watermarks/${slug}/export-${crypto.randomBytes(6).toString('hex')}.gif`, fs.readFileSync(out), { access: 'public', contentType: 'image/gif', addRandomSuffix: false });
      return res.status(200).json({ url: blob.url, width: a.W, height: a.H });
    } catch (e) {
      console.error('[watermark-gif] export', slug, e.message);
      return res.status(500).json({ error: 'Could not make the GIF' });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }

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
      // Clean-up after a webhook bug (13 Oct 2026): an HQ audio upload was taken for a full recording, so
      // files were made with the whole JSON label as the artist ('{"ARTIST":…} // AUDIO' / '// THUMB'),
      // and its vertical cuts failed. Those labels are never made otherwise.
      const junk = assets.filter(a => /^\{.*\} \/\/ (AUDIO|THUMB|SOCIAL|SOCIALRAW)\b/i.test(String(a.passthrough || '').trim()));
      for (const a of junk) await del(auth, a.id).catch(() => {});
      if (junk.length) { console.log('[watermark-clips] removed', junk.length, 'files with a broken label', slug); assets = await listAllAssets(auth); }
      for (const [k, v] of Object.entries(await redis.hGetAll(`v_failed:${slug}`))) { try { if (String(JSON.parse(v).artist || '').startsWith('{')) await redis.hDel(`v_failed:${slug}`, k); } catch {} }
      const v = await finishVerticals(redis, slug, auth, assets);
      if (v.done) assets = await listAllAssets(auth);
      const isClean = cleanCheck(assets, await markedSet(redis, slug));
      const watermarked = assets.filter(a => /^.+ \/\/ SOCIAL \/\/ \d+$/i.test(String(a.passthrough || '').trim()) && !isClean(a)).map(a => a.id);
      // Clips still being drawn with a moving logo (dropped if a render never reported back)
      const anim = await redis.hGetAll(animKey(slug));
      for (const [k, at] of Object.entries(anim)) if (Date.now() - Number(at) > 20 * 60e3) { await redis.hDel(animKey(slug), k); delete anim[k]; }
      pending += Object.keys(anim).length;
      const pendingIds = Object.values(await redis.hGetAll(swapsKey(slug))).map(v => parseSwap(v).old).concat(Object.keys(anim));
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

    // A moving (GIF) logo: each clip is drawn by ffmpeg in its own call
    const frame = await animatedLogo(wm);
    const origin = `https://${req.headers['x-forwarded-host'] || req.headers.host}`;
    const parts = new Map();
    const partsFor = async (w, h) => {
      const L = w > h ? HORIZONTAL : VERTICAL;
      const width = Math.max(L.W, Math.round(w) || L.W);
      const key = `${L.W}x${L.H}@${width}`;
      if (!parts.has(key)) parts.set(key, (async () => {
        const r = await renderWatermarkParts(wm, L, width, frame);
        const url = (await put(`watermarks/${slug}/${crypto.randomBytes(6).toString('hex')}.png`, r.png, { access: 'public', contentType: 'image/png', addRandomSuffix: false })).url;
        return { base: url, at: r.logoAt };
      })());
      return parts.get(key);
    };
    const animating = new Set(Object.keys(await redis.hGetAll(animKey(slug))));

    const assets = await listAllAssets(auth);
    const byId = new Map(assets.map(a => [a.id, a]));
    const isClean = cleanCheck(assets, await markedSet(redis, slug));
    const { hidden, master: sessionMaster } = sessionClips(assets, artist, String(body.date || ''));
    const pendingOld = new Set(Object.values(await redis.hGetAll(swapsKey(slug))).map(v => parseSwap(v).old));
    let started = 0;
    const errors = [];
    for (const id of ids) {
      if (pendingOld.has(id) || animating.has(id)) continue;
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
        if (frame) {
          const src = byId.get(input.url.slice('mux://assets/'.length)) || clip;
          const pid = (src.playback_ids || [])[0]?.id;
          if (!pid) { errors.push(`Clip ${String(n).padStart(2, '0')} isn't ready yet.`); continue; }
          const p = await partsFor(size[0] || 1080, size[1] || 1920);
          await redis.hSet(animKey(slug), id, String(Date.now()));
          await fetch(`${origin}/api/watermark-clips`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000),
            body: JSON.stringify({ action: 'animate', job: signJob({ kind: 'wm-gif', slug, artist, n, oldId: id, pid, vw: size[0] || 1080, vh: size[1] || 1920, base: p.base, gif: wm.url, at: p.at, masterId: sessionMaster?.id || null }) }) })
            .catch(e => errors.push('Could not start clip ' + n + ': ' + e.message));
          started++;
          continue;
        }
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
