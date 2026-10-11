import crypto from 'crypto';
import { put } from '@vercel/blob';
import { createClient } from 'redis';
import { getWebSessionAuth } from './_venues.js';
import { resolveWatermark } from './_watermark.js';
import { renderWatermarkPng } from './_watermark-render.js';

// Puts the Brand Kit watermark on a session's existing vertical clips.
// Mux makes a watermarked copy of each clip (same tag, so it takes the clip's place);
// once a copy is ready the original is deleted. Copies that fail leave the original as it was.
//   POST { action: 'apply', artist, clipIds: [...] }
//   POST { action: 'sweep' }   finishes pending swaps (called when the dashboard loads)

const muxReq = (auth, path, init = {}) => fetch('https://api.mux.com' + path, {
  ...init,
  headers: { Authorization: auth, 'Content-Type': 'application/json', ...(init.headers || {}) },
  signal: AbortSignal.timeout(15000),
}).then(async r => {
  const body = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(body?.error?.messages?.[0] || `Mux ${r.status}`); e.status = r.status; throw e; }
  return body.data;
});

const swapsKey = slug => `wm_swaps:${slug}`;   // hash newId → oldId

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
      for (const [newId, oldId] of Object.entries(swaps)) {
        let status;
        try { status = (await muxReq(auth, `/video/v1/assets/${encodeURIComponent(newId)}`)).status; }
        catch (e) { status = e.status === 404 ? 'gone' : 'unknown'; }
        if (status === 'ready') {
          await muxReq(auth, `/video/v1/assets/${encodeURIComponent(oldId)}`, { method: 'DELETE' }).catch(e => { if (e.status !== 404) throw e; });
          await redis.hDel(swapsKey(slug), newId); done++;
        } else if (status === 'errored' || status === 'gone') {
          // The copy failed: keep the original, drop the copy
          if (status === 'errored') await muxReq(auth, `/video/v1/assets/${encodeURIComponent(newId)}`, { method: 'DELETE' }).catch(() => {});
          await redis.hDel(swapsKey(slug), newId);
        } else pending++;
      }
      return res.status(200).json({ done, pending });
    }

    if (body.action !== 'apply') return res.status(400).json({ error: 'Unknown action' });
    const artist = String(body.artist || '').toUpperCase().trim();
    const ids = Array.isArray(body.clipIds) ? body.clipIds.map(String).slice(0, 30) : [];
    if (!artist || !ids.length) return res.status(400).json({ error: 'Choose a session with vertical clips' });

    const wm = await resolveWatermark(redis, slug, artist);
    if (!wm) return res.status(400).json({ error: 'The watermark is off, or there is no logo or text to apply. Set it up in Brand Kit.' });
    const png = await renderWatermarkPng(wm);
    if (!png) return res.status(400).json({ error: 'The watermark could not be drawn. Check the logo and font in Brand Kit.' });
    const blob = await put(`watermarks/${slug}/${crypto.randomBytes(6).toString('hex')}.png`, png, { access: 'public', contentType: 'image/png', addRandomSuffix: false });

    // Clips already being replaced are skipped
    const pendingOld = new Set(Object.values(await redis.hGetAll(swapsKey(slug))));
    let started = 0;
    const errors = [];
    for (const id of ids) {
      if (pendingOld.has(id)) continue;
      try {
        const clip = await muxReq(auth, `/video/v1/assets/${encodeURIComponent(id)}`);
        const pt = String(clip.passthrough || '');
        // Only this session's vertical clips, from this venue's own Cloud Storage
        if (!pt.toUpperCase().startsWith(artist + ' // SOCIAL')) { errors.push(`One clip isn't a vertical clip of ${artist}`); continue; }
        const copy = await muxReq(auth, '/video/v1/assets', {
          method: 'POST',
          body: JSON.stringify({
            input: [
              { url: `mux://assets/${id}` },
              { url: blob.url, overlay_settings: { vertical_align: 'top', horizontal_align: 'left', width: '100%', opacity: '100%' } },
            ],
            playback_policy: ['public'],
            passthrough: pt,
            static_renditions: [{ resolution: 'highest' }],
          }),
        });
        await redis.hSet(swapsKey(slug), copy.id, id);
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
