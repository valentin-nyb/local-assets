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

let tokenId = process.env.PROD_MUX_TOKEN_ID || process.env.MUX_TOKEN_ID;
let tokenSecret = process.env.PROD_MUX_TOKEN_SECRET || process.env.MUX_TOKEN_SECRET;

// Fallback: read from VENUES_CONFIG (first venue with Mux creds)
if (!tokenId || !tokenSecret) {
  try {
    const raw = process.env.VENUES_CONFIG || '{}';
    let venues;
    try { venues = JSON.parse(raw); } catch { venues = JSON.parse(decodeURIComponent(raw)); }
    for (const cfg of Object.values(venues)) {
      if ((cfg.mux_token_id || '').trim() && (cfg.mux_token_secret || '').trim()) {
        tokenId = cfg.mux_token_id.trim();
        tokenSecret = cfg.mux_token_secret.trim();
        console.log('[Server] Mux credentials loaded from VENUES_CONFIG');
        break;
      }
    }
  } catch (e) {
    console.error('[Server] Failed to parse VENUES_CONFIG for Mux creds:', e.message);
  }
}
if (!tokenId || !tokenSecret) { console.error('MUX credentials not set'); process.exit(1); }

const muxAuth = { tokenId, tokenSecret };

// ── Validate FFmpeg ───────────────────────────────────────────────────
try {
  execSync('ffmpeg -version', { stdio: 'pipe' });
  console.log('[Server] ffmpeg ✓');
} catch {
  console.error('[Server] ffmpeg not found — install with: brew install ffmpeg');
  process.exit(1);
}

// ── Redis connection ──────────────────────────────────────────────────
const redis = createClient({ url: REDIS_URL });
redis.on('error', e => console.error('[Redis]', e.message));
await redis.connect();
console.log('[Server] Redis connected');
console.log('[Server] Polling pipeline:queue for jobs...\n');

// ── Main loop — BLPOP blocks until a job arrives ──────────────────────
while (true) {
  try {
    const item = await redis.blPop('pipeline:queue', 5);
    if (!item) continue;

    let job;
    try { job = JSON.parse(item.element); } catch {
      console.error('[Server] Bad job JSON:', item.element);
      continue;
    }

    console.log(`\n[Server] ▶ Job received: ${job.jobId} — "${job.artistName}"`);

    await runPipeline({ ...job, redis, muxAuth }).catch(e => {
      console.error('[Server] Unhandled pipeline error:', e.message);
      return redis.set(
        `pipeline:job:${job.jobId}`,
        JSON.stringify({ done: 0, total: 30, status: 'error', artistName: job.artistName, error: e.message }),
        { EX: 7200 }
      );
    });
  } catch (e) {
    // Ignore BLPOP timeout errors; re-throw real ones
    if (!e.message?.includes('blPop') && !e.message?.includes('BLPOP')) {
      console.error('[Server] Loop error:', e.message);
    }
    await new Promise(r => setTimeout(r, 1000));
  }
}
