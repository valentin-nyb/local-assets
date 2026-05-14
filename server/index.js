import { createClient } from 'redis';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runPipeline } from './jobs/pipeline.js';
import { execSync } from 'child_process';

// ── Load .env.local from project root ────────────────────────────────
try {
  const envPath = resolve(process.cwd(), '../.env.local');
  const raw = readFileSync(envPath, 'utf8');
  for (const line of raw.split('\n')) {
    const m = line.match(/^([^#=\s][^=]*)=(.*)/);
    if (m) process.env[m[1].trim()] ??= m[2].trim().replace(/^["']|["']$/g, '');
  }
  console.log('[Server] Loaded .env.local');
} catch {
  console.log('[Server] No .env.local found — using existing env vars');
}

// ── Validate environment ──────────────────────────────────────────────
const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) { console.error('REDIS_URL is not set'); process.exit(1); }

// Build a per-venue Mux credential map from VENUES_CONFIG (fallback if job carries no creds)
const venueCredMap = {};
let defaultMuxAuth = null;
try {
  const raw = process.env.VENUES_CONFIG || '{}';
  let venues;
  try { venues = JSON.parse(raw); } catch { venues = JSON.parse(decodeURIComponent(raw)); }
  for (const [slug, cfg] of Object.entries(venues)) {
    const id = (cfg.mux_token_id || '').trim();
    const secret = (cfg.mux_token_secret || '').trim();
    if (id && secret) {
      venueCredMap[slug] = { tokenId: id, tokenSecret: secret };
      if (!defaultMuxAuth) defaultMuxAuth = venueCredMap[slug];
    }
  }
  if (defaultMuxAuth) console.log('[Server] Mux credentials loaded from VENUES_CONFIG for', Object.keys(venueCredMap).join(', '));
} catch (e) {
  console.error('[Server] Failed to parse VENUES_CONFIG for Mux creds:', e.message);
}

// Also accept explicit env vars as a global fallback
const envTokenId = (process.env.PROD_MUX_TOKEN_ID || process.env.MUX_TOKEN_ID || '').trim();
const envTokenSecret = (process.env.PROD_MUX_TOKEN_SECRET || process.env.MUX_TOKEN_SECRET || '').trim();
if (envTokenId && envTokenSecret && !defaultMuxAuth) {
  defaultMuxAuth = { tokenId: envTokenId, tokenSecret: envTokenSecret };
  console.log('[Server] Mux credentials loaded from env vars');
}

function getMuxAuthForJob(job) {
  // Prefer creds embedded in the job (set by pipeline-trigger per-venue)
  if (job.muxAuth?.tokenId && job.muxAuth?.tokenSecret) return job.muxAuth;
  // Fall back to per-venue map
  if (job.venueSlug && venueCredMap[job.venueSlug]) return venueCredMap[job.venueSlug];
  // Last resort: default
  return defaultMuxAuth;
}

// ── Validate FFmpeg ───────────────────────────────────────────────────
try {
  execSync('ffmpeg -version', { stdio: 'pipe' });
  console.log('[Server] ffmpeg ✓');
} catch {
  console.error('[Server] ffmpeg not found — install with: brew install ffmpeg');
  process.exit(1);
}

// ── Redis connection with retry ───────────────────────────────────────
const redis = createClient({ url: REDIS_URL });
redis.on('error', e => console.error('[Redis] client error:', e.message));

async function connectRedis(retries = 10) {
  for (let i = 1; i <= retries; i++) {
    try {
      await redis.connect();
      console.log('[Server] Redis connected');
      return;
    } catch (e) {
      console.error(`[Server] Redis connect attempt ${i}/${retries} failed:`, e.message);
      if (i === retries) { console.error('[Server] Giving up on Redis'); process.exit(1); }
      await new Promise(r => setTimeout(r, 3000 * i));
    }
  }
}
await connectRedis();
console.log('[Server] Polling pipeline:queue for jobs...\n');

// ── Main loop — BLPOP blocks until a job arrives ──────────────────────
while (true) {
  try {
    // Reconnect if Redis dropped
    if (!redis.isOpen) {
      console.log('[Server] Redis disconnected — reconnecting...');
      await connectRedis();
    }

    const item = await redis.blPop('pipeline:queue', 5);
    if (!item) continue;

    let job;
    try { job = JSON.parse(item.element); } catch {
      console.error('[Server] Bad job JSON:', item.element);
      continue;
    }

    console.log(`\n[Server] ▶ Job received: ${job.jobId} — "${job.artistName}" venue=${job.venueSlug || 'default'}`);

    const muxAuth = getMuxAuthForJob(job);
    if (!muxAuth) {
      console.error(`[Server] No Mux credentials for venue "${job.venueSlug}" — skipping job ${job.jobId}`);
      await redis.set(
        `pipeline:job:${job.jobId}`,
        JSON.stringify({ done: 0, total: 30, status: 'error', artistName: job.artistName, error: 'No Mux credentials configured for this venue' }),
        { EX: 7200 }
      );
      continue;
    }

    await runPipeline({ ...job, redis, muxAuth }).catch(e => {
      console.error('[Server] Unhandled pipeline error:', e.message);
      return redis.set(
        `pipeline:job:${job.jobId}`,
        JSON.stringify({ done: 0, total: 30, status: 'error', artistName: job.artistName, error: e.message }),
        { EX: 7200 }
      );
    });
  } catch (e) {
    console.error('[Server] Loop error:', e.message);
    await new Promise(r => setTimeout(r, 2000));
  }
}
