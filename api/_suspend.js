import { createClient } from 'redis';

// Unpaid invoices pause an account until they're paid.
// billing_unpaid:<venue> hash: invoice id → JSON { target, number, url }
// A venue's own unpaid invoice pauses the whole venue; an artist's or record label's pauses that one only.
export const unpaidKey = slug => `billing_unpaid:${slug}`;

export async function readUnpaid(redis, slug) {
  const raw = await redis.hGetAll(unpaidKey(slug));
  return Object.entries(raw || {}).map(([id, v]) => { try { return { id, ...JSON.parse(v) }; } catch { return { id, target: 'venue' }; } });
}

// The unpaid invoice that pauses this venue, or this artist/label in it ('artist:NAME' / 'label:NAME'); else null
export async function pausedBy(slug, target = null, redis = null) {
  if (!slug) return null;
  const own = !redis;
  if (own) { redis = createClient({ url: (process.env.UPSTASH_REDIS_URL || process.env.REDIS_URL) }); await redis.connect(); }
  try {
    const list = await readUnpaid(redis, slug);
    return list.find(i => i.target === 'venue') || (target && list.find(i => i.target.toUpperCase() === String(target).toUpperCase())) || null;
  } catch { return null; }
  finally { if (own) await redis.quit().catch(() => {}); }
}

export function sendPaused(res, inv) {
  return res.status(402).json({
    // Paused by local / assets (Accounts), or by an unpaid invoice
    error: inv.admin ? 'This account is paused by local / assets. Email info@local-assets.com to start it again.' : `This account is paused until invoice ${inv.number || ''} is paid.`.replace('  ', ' '),
    paused: true, payUrl: inv.url || null,
  });
}
