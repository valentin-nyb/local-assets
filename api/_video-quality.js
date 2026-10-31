import { createClient } from 'redis';

// Mux video quality per account: Basic (Mux encodes it for free) unless local / assets turns on Premium for the
// account in Accounts (Redis hash video_quality: slug → 'premium'). Read at most every 30 seconds per instance.
// Kept at most in 1080p unless 4K is turned on for the account (hash video_4k: slug → '1'): 4K costs more to
// encode, store and stream.
export const VIDEO_QUALITY_KEY = 'video_quality';
export const VIDEO_4K_KEY = 'video_4k';
let _cache = null, _4k = null, _at = 0;

async function read() {
  if (_cache && Date.now() - _at <= 30000) return;
  const r = createClient({ url: (process.env.UPSTASH_REDIS_URL || process.env.REDIS_URL) });
  try { await r.connect(); _cache = (await r.hGetAll(VIDEO_QUALITY_KEY)) || {}; _4k = (await r.hGetAll(VIDEO_4K_KEY)) || {}; _at = Date.now(); }
  catch { _cache = _cache || {}; _4k = _4k || {}; }
  finally { r.quit().catch(() => {}); }
}

export async function videoQuality(slug) {
  if (!slug) return 'basic';
  await read();
  return _cache[slug] === 'premium' ? 'premium' : 'basic';
}

// The largest size Mux keeps a new video at (max_resolution_tier)
export async function maxResolution(slug) {
  if (!slug) return '1080p';
  await read();
  return _4k[slug] === '1' ? '2160p' : '1080p';
}
