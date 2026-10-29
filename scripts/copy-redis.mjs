// Copies every key from the old Redis (REDIS_URL) to Upstash (UPSTASH_REDIS_URL), keeping expiry times.
// Safe to run again: each key is replaced, so a second run just brings Upstash up to date.
// Prints counts only, never the addresses or passwords.
import { createClient } from 'redis';
import { execSync } from 'node:child_process';

const isUrl = u => /^rediss?:\/\//.test(u || '');
// The old REDIS_URL is a Secret and can't be pulled: copy it from the Redis page in Vercel, and it's read from the clipboard.
let from = process.env.REDIS_URL;
if (!isUrl(from)) {
  try { from = execSync('pbpaste').toString().trim(); } catch { from = ''; }
  if (!isUrl(from)) { console.error('Copy the old Redis URL first (Vercel → Storage → redis-bisque-mirror → Show secret → copy REDIS_URL), then run this again.'); process.exit(1); }
  execSync('pbcopy < /dev/null'); // clear it from the clipboard
}
const to = [process.env.UPSTASH_REDIS_URL, process.env.UPSTASH_KV_URL].find(isUrl);
if (!from || !to) { console.error('Missing REDIS_URL or UPSTASH_REDIS_URL. Is the Upstash database connected to local-assets?'); process.exit(1); }
if (from === to) { console.error('Both point at the same database; nothing to copy.'); process.exit(1); }

const a = createClient({ url: from }), b = createClient({ url: to });
await a.connect(); await b.connect();

const counts = {}, skipped = [];
let n = 0;
for await (const batch of a.scanIterator({ COUNT: 500 })) {
  for (const key of Array.isArray(batch) ? batch : [batch]) {
    const type = await a.type(key);
    if (type === 'none') continue; // expired while copying
    const ttl = await a.pTTL(key);
    const m = b.multi().del(key);
    if (type === 'string') m.set(key, await a.get(key));
    else if (type === 'hash') { const h = await a.hGetAll(key); if (Object.keys(h).length) m.hSet(key, h); }
    else if (type === 'list') { const l = await a.lRange(key, 0, -1); if (l.length) m.rPush(key, l); }
    else if (type === 'set') { const s = await a.sMembers(key); if (s.length) m.sAdd(key, s); }
    else if (type === 'zset') { const z = await a.zRangeWithScores(key, 0, -1); if (z.length) m.zAdd(key, z); }
    else { skipped.push(`${key} (${type})`); continue; }
    if (ttl > 0) m.pExpire(key, ttl);
    await m.exec();
    counts[type] = (counts[type] || 0) + 1;
    if (++n % 500 === 0) console.log(`${n} copied…`);
  }
}

const [oldSize, newSize] = [await a.dbSize(), await b.dbSize()];
console.log(`Copied ${n} keys:`, counts);
if (skipped.length) console.log('Not copied (unsupported type):', skipped);
console.log(`Old database has ${oldSize} keys, Upstash has ${newSize}.`);
await a.quit(); await b.quit();
