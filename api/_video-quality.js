import { createClient } from 'redis';

// Mux video quality per account: Basic (Mux encodes it for free) unless local / assets turns on Premium for the
// account in Accounts (Redis hash video_quality: slug → 'premium'). Read at most every 30 seconds per instance.
export const VIDEO_QUALITY_KEY = 'video_quality';
let _cache = null, _at = 0;

export async function videoQuality(slug) {
  if (!slug) return 'basic';
  if (!_cache || Date.now() - _at > 30000) {
    const r = createClient({ url: (process.env.UPSTASH_REDIS_URL || process.env.REDIS_URL) });
    try { await r.connect(); _cache = (await r.hGetAll(VIDEO_QUALITY_KEY)) || {}; _at = Date.now(); }
    catch { _cache = _cache || {}; }
    finally { r.quit().catch(() => {}); }
  }
  return _cache[slug] === 'premium' ? 'premium' : 'basic';
}
