import { list, del } from '@vercel/blob';
import { createClient } from 'redis';
import { getWebSessionAuth, getVenuesConfig, isAdminVenue, refreshRegistry } from './_venues.js';
import { thumbnailPrefix } from './_thumbnails.js';

// Admin only: permanently deletes a client account's stored data on local / assets.
//   GET  ?slug=…                       what would be deleted (nothing is changed)
//   POST { slug, confirm: slug }       deletes it
// Removes the account's Redis records, its Blob files (brand/, thumbnails/, watermarks/ under the slug
// only; the Blob store is shared with other projects) and its sign-up entry, and marks the slug deleted
// so it no longer logs in or shows in any account list, even if VENUES_CONFIG still names it.
// Stripe invoices are kept for the accounts. Videos live in the account's own Mux environment.

export const config = { maxDuration: 60 };

const KEYS = [
  'account_type', 'billing_assign', 'billing_customer', 'billing_status', 'billing_unpaid',
  'brand_file_label', 'brand_hidden_owners', 'brand_label_artist', 'brand_org_name', 'brand_org_type',
  'brand_owner_names', 'brand_owner_photo', 'brand_watermark', 'calendar_url',
  'cam_cmds', 'cam_relay_key', 'cam_relay_seen', 'cameras', 'sc_tokens', 'session_meta',
  'v_failed', 'v_intake', 'v_jobs', 'v_orig', 'v_ready', 'wm_marked', 'wm_raw', 'wm_swaps', 'youtube_token',
];
export const DELETED_KEY = 'la_deleted';

async function blobFiles(prefixes) {
  const urls = [];
  for (const prefix of prefixes) {
    let cursor;
    do {
      const page = await list({ prefix, cursor, limit: 1000 });
      urls.push(...page.blobs.map(b => b.url));
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
  }
  return urls;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const session = getWebSessionAuth(req);
  const admins = (process.env.BILLING_ADMINS || 'info@local-assets.com').split(/[\s,]+/).map(x => x.toLowerCase());
  if (!session?.email || !admins.includes(String(session.email).toLowerCase())) return res.status(403).json({ error: 'Admin only' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const slug = String((req.method === 'POST' ? body.slug : req.query.slug) || '').trim();
  if (!/^[a-z0-9-]{2,60}$/.test(slug)) return res.status(400).json({ error: 'Account slug missing' });
  const venue = getVenuesConfig()[slug];
  if (!venue) return res.status(404).json({ error: 'No account with that slug' });
  if (isAdminVenue({ slug, ...venue })) return res.status(400).json({ error: 'The admin account cannot be deleted' });

  const prefixes = [`brand/${slug}/`, thumbnailPrefix(slug), `watermarks/${slug}/`];
  const redis = createClient({ url: process.env.REDIS_URL });
  await redis.connect();
  try {
    // Every Redis record of the account: the named keys plus any "<key>:<slug>:…" variants
    const keys = new Set();
    for (const k of KEYS) if (await redis.exists(`${k}:${slug}`)) keys.add(`${k}:${slug}`);
    for await (const batch of redis.scanIterator({ MATCH: `*:${slug}:*`, COUNT: 500 })) for (const k of [].concat(batch)) keys.add(k);
    let streams = [];
    try { streams = JSON.parse(await redis.get(`cameras:${slug}`) || '[]').map(c => c.streamId).filter(Boolean); } catch {}
    for (const id of streams) if (await redis.exists(`cam_sched:${id}`)) keys.add(`cam_sched:${id}`);
    const signup = !!(await redis.hExists('la_venues', slug));
    const files = await blobFiles(prefixes);
    const plan = { slug, name: venue.name || slug, redisKeys: [...keys].sort(), files: files.length, prefixes, signupEntry: signup };

    if (req.method !== 'POST') return res.status(200).json({ preview: true, ...plan });
    if (body.confirm !== slug) return res.status(400).json({ error: 'Type the account slug to confirm' });

    for (let i = 0; i < files.length; i += 500) await del(files.slice(i, i + 500));
    if (keys.size) await redis.del([...keys]);
    if (signup) await redis.hDel('la_venues', slug);
    await redis.sAdd(DELETED_KEY, slug);
    await refreshRegistry(redis);
    console.log('[delete-account]', slug, 'by', session.email, '·', keys.size, 'records ·', files.length, 'files');
    return res.status(200).json({ deleted: true, ...plan });
  } catch (e) {
    console.error('[delete-account]', slug, e.message);
    return res.status(500).json({ error: 'Could not delete the account: ' + e.message });
  } finally {
    await redis.quit().catch(() => {});
  }
}
