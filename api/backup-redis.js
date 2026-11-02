import './_report.js';   // errors go to Rollbar
import { createClient } from 'redis';
import { gzipSync } from 'node:zlib';
import * as blob from '@vercel/blob';
import { dumpRedis } from './_redis-backup.js';

// Nightly, 02:30 UTC (vercel.json): a copy of the whole database into the private Blob store, as
// backups/redis/YYYY-MM-DD.json.gz, keeping the last 30 days. Upstash's own daily backup on our plan keeps
// only the last day, so a mistake noticed a few days later could not be undone with it alone.
// To put one back: scripts/restore-redis-backup.mjs. Never written to the public store.
const KEEP_DAYS = 30;
const PREFIX = 'backups/redis/';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const secret = process.env.CRON_SECRET;
  const ok = secret ? req.headers.authorization === `Bearer ${secret}` : /vercel-cron/i.test(req.headers['user-agent'] || '');
  if (!ok) return res.status(401).json({ error: 'Cron only' });
  const token = process.env.LA_PRIVATE_READ_WRITE_TOKEN;
  if (!token) { console.error('[backup-redis] no private Blob store (LA_PRIVATE_READ_WRITE_TOKEN): no backup made'); return res.status(503).json({ error: 'No private store' }); }

  const redis = createClient({ url: (process.env.UPSTASH_REDIS_URL || process.env.REDIS_URL) });
  try {
    await redis.connect();
    const data = await dumpRedis(redis);
    const body = gzipSync(JSON.stringify(data));
    const pathname = `${PREFIX}${data.at.slice(0, 10)}.json.gz`;
    await blob.put(pathname, body, { access: 'private', token, contentType: 'application/gzip', addRandomSuffix: false, allowOverwrite: true });

    // Older than 30 days: deleted (the date is in the name)
    const cutoff = new Date(Date.now() - KEEP_DAYS * 86400e3).toISOString().slice(0, 10);
    const old = [];
    let cursor;
    do {
      const page = await blob.list({ prefix: PREFIX, token, cursor, limit: 1000 });
      for (const b of page.blobs) { const day = b.pathname.slice(PREFIX.length, PREFIX.length + 10); if (day < cutoff) old.push(b.url); }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    if (old.length) await blob.del(old, { token });

    if (Object.keys(data.skipped).length) console.error('[backup-redis] keys of a type not backed up:', JSON.stringify(data.skipped));
    console.log('[backup-redis]', pathname, data.count, 'keys', body.length, 'bytes;', old.length, 'old removed');
    return res.status(200).json({ ok: true, pathname, keys: data.count, bytes: body.length, removed: old.length });
  } catch (e) {
    console.error('[backup-redis] failed:', e);
    return res.status(500).json({ error: 'Backup failed' });
  } finally { await redis.quit().catch(() => {}); }
}
