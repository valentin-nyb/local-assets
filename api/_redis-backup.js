// The whole database as plain data, and back: every key with its type, value and time left to live.
// Used by the nightly backup (api/backup-redis.js) and to put a backup back (scripts/restore-redis-backup.mjs).
// Strings, hashes, lists, sets and sorted sets; anything else is counted in `skipped` (there is none today).

const READ = {
  string: (m, k) => m.get(k),
  hash: (m, k) => m.hGetAll(k),
  list: (m, k) => m.lRange(k, 0, -1),
  set: (m, k) => m.sMembers(k),
  zset: (m, k) => m.zRangeWithScores(k, 0, -1),
};

export async function dumpRedis(redis) {
  const keys = new Map();   // SCAN can return a key twice
  const skipped = {};
  let cursor = '0';
  do {
    const page = await redis.scan(cursor, { COUNT: 1000 });
    cursor = String(page.cursor);
    const fresh = page.keys.filter(k => !keys.has(k));
    if (!fresh.length) continue;
    const meta = redis.multi();
    for (const k of fresh) meta.type(k).pTTL(k);
    const m = await meta.execAsPipeline();
    const read = redis.multi(), wanted = [];
    fresh.forEach((k, i) => {
      const type = String(m[i * 2]), ttl = Number(m[i * 2 + 1]);
      if (!READ[type]) { if (type !== 'none') skipped[type] = (skipped[type] || 0) + 1; return; }   // none: gone since
      READ[type](read, k);
      wanted.push({ k, type, ttl });
    });
    if (!wanted.length) continue;
    const values = await read.execAsPipeline();
    wanted.forEach(({ k, type, ttl }, i) => {
      const v = type === 'hash' ? { ...values[i] } : values[i];
      keys.set(k, { t: type, v, ...(ttl > 0 ? { ttl } : {}) });
    });
  } while (cursor !== '0');
  return { at: new Date().toISOString(), count: keys.size, skipped, keys: Object.fromEntries(keys) };
}

// Writes every key of a backup into `redis` (replacing those keys, leaving any others alone), in batches.
// A key whose time to live ran out since the backup isn't written.
export async function restoreRedis(redis, backup, { batch = 500 } = {}) {
  const entries = Object.entries(backup.keys || {});
  let written = 0;
  for (let i = 0; i < entries.length; i += batch) {
    const m = redis.multi();
    for (const [k, { t, v, ttl }] of entries.slice(i, i + batch)) {
      m.del(k);
      if (t === 'string') m.set(k, v);
      else if (t === 'hash') { if (Object.keys(v).length) m.hSet(k, v); }
      else if (t === 'list') { if (v.length) m.rPush(k, v); }
      else if (t === 'set') { if (v.length) m.sAdd(k, v); }
      else if (t === 'zset') { if (v.length) m.zAdd(k, v); }
      else continue;
      if (ttl > 0) m.pExpire(k, ttl);
      written++;
    }
    await m.execAsPipeline();
  }
  return written;
}
