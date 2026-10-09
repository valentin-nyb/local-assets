import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { createClient } from 'redis';
import { getWebSessionAuth } from './_venues.js';

// Finds the peak moment of a set: the stretch with the most bass energy (the drops),
// measured on the smallest HLS rendition. The result is cached per asset in Redis.
export const config = { maxDuration: 300 };

const MAX_SEGMENTS = 400;   // segments analysed per video (sampled evenly)
const CONCURRENCY  = 12;
const WINDOW_SEC   = 30;    // energy is averaged over this window before picking the peak
const EDGE         = 0.1;   // ignore the first and last 10% (intro / outro)
const ASSET_ID     = /^[A-Za-z0-9]{10,64}$/;

async function withRedis(fn) {
  const redis = createClient({ url: process.env.REDIS_URL });
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

export async function findPeak(playbackId, duration) {
  const master = await (await fetch(`https://stream.mux.com/${playbackId}.m3u8`, { signal: AbortSignal.timeout(15000) })).text();
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
  if (!pts.length) throw new Error('No audio analysed');
  let best = null;
  for (const p of pts) {
    if (p.mid < total * EDGE || p.mid > total * (1 - EDGE)) continue;
    const near = pts.filter(q => Math.abs(q.mid - p.mid) <= WINDOW_SEC / 2);
    const score = near.reduce((a, q) => a + q.e, 0) / near.length;
    if (!best || score > best.score) best = { time: p.mid, score };
  }
  return Math.round((best || pts.reduce((a, b) => (b.e > a.e ? b : a))).time ?? pts[0].mid);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).end();

  const session = getWebSessionAuth(req);
  if (!session?.muxAuth) return res.status(401).json({ error: 'Not authenticated' });

  const assetId = String(req.query.assetId || '');
  if (!ASSET_ID.test(assetId)) return res.status(400).json({ error: 'Invalid assetId' });

  try {
    return await withRedis(async redis => {
      const cached = await redis.get(`peak:${assetId}`);
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
        const playbackId = (asset.playback_ids || []).find(p => p.policy === 'public')?.id;
        if (!playbackId || asset.status !== 'ready') return res.status(409).json({ error: 'Asset not ready' });

        const started = Date.now();
        const time = await findPeak(playbackId, Number(asset.duration) || 0);
        const result = { time, method: 'bass-energy' };
        await redis.set(`peak:${assetId}`, JSON.stringify(result));
        console.log(`[peak-moment] ${assetId} peak at ${time}s (${Date.now() - started} ms)`);
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
