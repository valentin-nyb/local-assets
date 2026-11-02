// Puts a nightly backup (backups/redis/YYYY-MM-DD.json.gz, from the private Blob store) into a Redis database.
//   node scripts/restore-redis-backup.mjs <backup.json.gz> <redis-url>            what it would write, nothing written
//   node scripts/restore-redis-backup.mjs <backup.json.gz> <redis-url> --write    writes it
// Each key in the backup replaces the same key in the database; other keys are left alone. Try it on a new,
// empty database first: written into the live one, it undoes every change since the backup was made.
// Download a backup from Vercel → Storage → the private store → backups/redis.
import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createClient } from 'redis';
import { restoreRedis } from '../api/_redis-backup.js';

const [file, url, flag] = process.argv.slice(2);
if (!file || !url) { console.log('Usage: node scripts/restore-redis-backup.mjs <backup.json.gz> <redis-url> [--write]'); process.exit(1); }
const raw = fs.readFileSync(file);
const backup = JSON.parse((file.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8'));
const types = {};
for (const { t } of Object.values(backup.keys)) types[t] = (types[t] || 0) + 1;
console.log(`Backup of ${backup.at}: ${backup.count} keys`, types);

const redis = createClient({ url });
await redis.connect();
const existing = await redis.dbSize();
console.log(`Target database has ${existing} keys now.`);
if (flag !== '--write') { console.log('Nothing written. Add --write to put the backup in.'); await redis.quit(); process.exit(0); }
const written = await restoreRedis(redis, backup);
console.log(`Written: ${written} keys. Target now has ${await redis.dbSize()} keys.`);
await redis.quit();
