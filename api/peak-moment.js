import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { createClient } from 'redis';
import { getWebSessionAuth, platformAdmins } from './_venues.js';
import { muxUrlAuto } from './_signing.js';

// Finds the peak moment of a set for the dashboard banner: among the stretches with the most bass
// energy (the drops, measured on the smallest HLS rendition), the one where the picture shows someone
// playing (movement between frames, not an empty booth), and where in the frame that movement is, so
// the banner is centred on the DJ. The result is cached per asset in Redis.
export const config = { maxDuration: 300 };

const MAX_SEGMENTS = 400;   // segments analysed per video (sampled evenly)
const CONCURRENCY  = 12;
const WINDOW_SEC   = 30;    // energy is averaged over this window before picking the peak
const EDGE         = 0.1;   // ignore the first and last 10% (intro / outro)
const ASSET_ID     = /^[A-Za-z0-9]{10,64}$/;

async function withRedis(fn) {
  const redis = createClient({ url: (process.env.UPSTASH_REDIS_URL || process.env.REDIS_URL) });
  await redis.connect();
  try { return await fn(redis); } finally { await redis.quit().catch(() => {}); }
}

// Bass energy (RMS below 150 Hz) of one MPEG-TS segment.
function segmentEnergy(bytes) {
  return new Promise(resolve => {
    const ff = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn', '-ac', '1',
      '-af', 'lowpass=f=150', '-ar', '2000', '-f', 's16le', 'pipe:1']);
    let sum = 0, n = 0, carry = null;
    ff.stdout.on('data', buf => {
      if (carry) { buf = Buffer.concat([carry, buf]); carry = null; }
      const len = buf.length - (buf.length % 2);
      if (len < buf.length) carry = buf.subarray(len);
      for (let o = 0; o < len; o += 2) { const v = buf.readInt16LE(o); sum += v * v; n++; }
    });
    ff.on('error', () => resolve(null));
    ff.on('close', () => resolve(n ? Math.sqrt(sum / n) : null));
    ff.stdin.on('error', () => {});
    ff.stdin.end(bytes);
  });
}

// ── The picture: is the DJ playing, and where ──────────────────────────────────
const FW = 96, FH = 54;           // frames are compared this small, in grey
const CANDIDATES = 8;             // loudest stretches looked at
const SPACING_SEC = 45;           // candidates at least this far apart

function grayFrame(bytes) {
  return new Promise(resolve => {
    const ff = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vf', `scale=${FW}:${FH},format=gray`, '-f', 'rawvideo', 'pipe:1']);
    const out = [];
    ff.stdout.on('data', d => out.push(d));
    ff.on('error', () => resolve(null));
    ff.on('close', () => { const b = Buffer.concat(out); resolve(b.length >= FW * FH ? b.subarray(0, FW * FH) : null); });
    ff.stdin.on('error', () => {});
    ff.stdin.end(bytes);
  });
}
// auth: the Mux storage being read (signed videos need its key)
async function frameAt(playbackId, t, auth) {
  try {
    const r = await fetch(await muxUrlAuto(auth, `https://image.mux.com/${playbackId}/thumbnail.jpg?time=${Math.max(0, Math.round(t))}&width=192`), { signal: AbortSignal.timeout(15000) });
    return r.ok ? await grayFrame(Buffer.from(await r.arrayBuffer())) : null;
  } catch { return null; }
}
// Movement across the banner's loop (frames 3 s apart): how much, and where. Each frame is evened out
// for brightness first, so club lights changing don't count; a change over most of the picture
// (a light sweep or a cut) counts for little.
async function movement(playbackId, t, auth) {
  const frames = (await Promise.all([t - 3, t, t + 3].map(x => frameAt(playbackId, x, auth)))).filter(Boolean);
  if (frames.length < 2) return null;
  const norm = frames.map(f => { let m = 0; for (const v of f) m += v; m /= f.length; return Float32Array.from(f, v => v - m); });
  const diff = new Float32Array(FW * FH);
  for (let k = 1; k < norm.length; k++) for (let i = 0; i < diff.length; i++) diff[i] += Math.abs(norm[k][i] - norm[k - 1][i]);
  const sorted = Float32Array.from(diff).sort();
  const thr = Math.max(18 * (norm.length - 1), sorted[Math.floor(sorted.length * 0.5)] * 3);
  let count = 0, sx = 0, mid = 0; const rows = [];
  for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) if (diff[y * FW + x] > thr) {
    count++; sx += x; rows.push(y);
    if (x > FW * 0.28 && x < FW * 0.72 && y > FH * 0.1 && y < FH * 0.7) mid++;
  }
  const frac = count / diff.length;
  // The DJ from the front: the movement gathered in the middle and upper part of the picture (a wide
  // room shot moves all over, the overhead shot of the decks only at the bottom)
  const front = count ? mid / count : 0;
  const score = (frac < 0.3 ? frac : Math.max(0, 0.6 - frac)) * (0.25 + front);
  if (!count) return { score: 0, focus: null };
  // Centre on the upper part of the movement (head and hands), not the middle of the decks
  rows.sort((a, b) => a - b);
  return { score, focus: { x: Math.round(sx / count / FW * 100), y: Math.round(rows[Math.floor(rows.length * 0.35)] / FH * 100) } };
}

export async function findPeak(playbackId, duration, auth) {
  const master = await (await fetch(await muxUrlAuto(auth, `https://stream.mux.com/${playbackId}.m3u8`), { signal: AbortSignal.timeout(15000) })).text();
  const lines = master.split('\n');
  let low = null;
  lines.forEach((l, i) => {
    const m = l.match(/^#EXT-X-STREAM-INF:.*?BANDWIDTH=(\d+)/);
    if (m && (!low || +m[1] < low.bw)) low = { bw: +m[1], url: (lines[i + 1] || '').trim() };
  });
  if (!low?.url) throw new Error('No HLS rendition');

  const playlist = await (await fetch(low.url, { signal: AbortSignal.timeout(15000) })).text();
  const segs = [];
  let t = 0, dur = 0;
  for (const l of playlist.split('\n')) {
    const m = l.match(/^#EXTINF:([\d.]+)/);
    if (m) { dur = parseFloat(m[1]); continue; }
    if (l && !l.startsWith('#')) { segs.push({ start: t, dur, url: l.trim() }); t += dur; }
  }
  if (!segs.length) throw new Error('Empty playlist');

  const step = Math.max(1, Math.ceil(segs.length / MAX_SEGMENTS));
  const sample = segs.filter((_, i) => i % step === 0);
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < sample.length) {
      const s = sample[next++];
      try {
        const r = await fetch(s.url, { signal: AbortSignal.timeout(20000) });
        if (r.ok) s.energy = await segmentEnergy(Buffer.from(await r.arrayBuffer()));
      } catch (_) {}
    }
  }));

  const total = duration || t;
  const pts = sample.filter(s => s.energy != null).map(s => ({ mid: s.start + s.dur / 2, e: s.energy }));
  // No sound to measure (a recording whose audio is kept separately): moments spread over the set, by picture alone
  if (!pts.length) for (let i = 0; i < 12; i++) pts.push({ mid: total * (EDGE + (1 - 2 * EDGE) * (i + 0.5) / 12), e: 1 });
  const scored = [];
  for (const p of pts) {
    if (p.mid < total * EDGE || p.mid > total * (1 - EDGE)) continue;
    const near = pts.filter(q => Math.abs(q.mid - p.mid) <= WINDOW_SEC / 2);
    scored.push({ time: p.mid, score: near.reduce((a, q) => a + q.e, 0) / near.length });
  }
  if (!scored.length) return { time: Math.round(pts.reduce((a, b) => (b.e > a.e ? b : a)).mid), focus: null };
  // The loudest stretches, spread over the set
  scored.sort((a, b) => b.score - a.score);
  const cands = [];
  for (const c of scored) { if (cands.every(d => Math.abs(d.time - c.time) >= SPACING_SEC)) cands.push(c); if (cands.length >= (pts.every(p => p.e === 1) ? 12 : CANDIDATES)) break; }
  // Of those, the one where someone is playing on camera (louder breaks a tie)
  await Promise.all(cands.map(async c => { c.move = await movement(playbackId, c.time, auth); }));
  const topBass = cands[0].score || 1, topMove = Math.max(...cands.map(c => c.move?.score || 0));
  const rank = c => (topMove > 0 ? 0.65 * (c.move?.score || 0) / topMove : 0) + 0.35 * c.score / topBass;
  const best = cands.reduce((a, b) => (rank(b) > rank(a) ? b : a));
  return { time: Math.round(best.time), focus: best.move?.focus || null };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();

  const session = getWebSessionAuth(req);
  if (!session?.muxAuth) return res.status(401).json({ error: 'Not authenticated' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const assetId = String((req.method === 'POST' ? body?.assetId : req.query.assetId) || '');
  if (!ASSET_ID.test(assetId)) return res.status(400).json({ error: 'Invalid assetId' });

  // The DJ seen from the front (found in the browser by la-djframe.js): kept per recording
  if (req.method === 'GET' && req.query.dj) {
    // Kept per version of the finder (la-djframe.js), so a better one looks again
    const ver = /^[2-9]$/.test(String(req.query.dj)) ? String(req.query.dj) : '2';
    try { return res.status(200).json({ dj: await withRedis(async r => JSON.parse(await r.get(`djframe${ver}:${assetId}`) || 'null')) }); }
    catch (e) { return res.status(200).json({ dj: null }); }
  }
  if (req.method === 'POST') {
    const dj = body?.dj, num = (v, max) => Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= max;
    if (!dj || !num(dj.time, 1e6) || !dj.focus || !num(dj.focus.x, 100) || !num(dj.focus.y, 100)) return res.status(400).json({ error: 'Invalid frame' });
    // Only for a recording in this account's own Cloud Storage
    const ar = await fetch(`https://api.mux.com/video/v1/assets/${assetId}`, { headers: { Authorization: session.muxAuth }, signal: AbortSignal.timeout(10000) }).catch(() => null);
    if (!ar?.ok) return res.status(404).json({ error: 'Asset not found' });
    const v = { time: Math.round(Number(dj.time)), focus: { x: Math.round(Number(dj.focus.x)), y: Math.round(Number(dj.focus.y)) } };
    const ver = /^[2-9]$/.test(String(body?.v || '')) ? String(body.v) : '2';
    // The banner moment is chosen by local / assets: everyone else only saves the one found automatically, never over it
    const admin = platformAdmins().includes(String(session.email || '').toLowerCase());
    const saved = await withRedis(async r => (admin ? await r.set(`djframe${ver}:${assetId}`, JSON.stringify(v)) : await r.set(`djframe${ver}:${assetId}`, JSON.stringify(v), { NX: true })));
    if (!saved) return res.status(403).json({ error: 'Only local / assets can change the banner moment' });
    return res.status(200).json({ ok: true });
  }

  try {
    return await withRedis(async redis => {
      const cached = await redis.get(`peak3:${assetId}`);
      if (cached) return res.status(200).json(JSON.parse(cached));

      // Only one analysis per asset at a time; other callers fall back until it's done.
      const locked = await redis.set(`peak:lock:${assetId}`, '1', { NX: true, EX: 300 });
      if (!locked) return res.status(202).json({ pending: true });

      try {
        // Loading the asset with the venue's own Mux token proves it belongs to this venue.
        const ar = await fetch(`https://api.mux.com/video/v1/assets/${assetId}`, {
          headers: { Authorization: session.muxAuth }, signal: AbortSignal.timeout(10000),
        });
        if (!ar.ok) return res.status(404).json({ error: 'Asset not found' });
        const asset = (await ar.json()).data;
        const playbackId = (asset.playback_ids || [])[0]?.id;
        if (!playbackId || asset.status !== 'ready') return res.status(409).json({ error: 'Asset not ready' });

        const started = Date.now();
        const { time, focus } = await findPeak(playbackId, Number(asset.duration) || 0, session.muxAuth);
        const result = { time, focus, method: 'bass-and-movement' };
        await redis.set(`peak3:${assetId}`, JSON.stringify(result));
        console.log(`[peak-moment] ${assetId} peak at ${time}s focus ${JSON.stringify(focus)} (${Date.now() - started} ms)`);
        return res.status(200).json(result);
      } finally {
        await redis.del(`peak:lock:${assetId}`).catch(() => {});
      }
    });
  } catch (e) {
    console.error('[peak-moment]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
