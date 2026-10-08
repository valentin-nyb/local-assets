import { readFileSync } from 'fs';
import { resolve } from 'path';
import { hostname } from 'os';
import { randomUUID } from 'crypto';
import { runPipeline } from './jobs/pipeline.js';
import { claimNextJob, createPipelinePool, renewPipelineJob, updatePipelineJob } from './jobs/pipeline-db.js';
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

// ── Validate database ─────────────────────────────────────────────────
let db;
try {
  db = createPipelinePool();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

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
  // Fall back to per-venue map
  if (job.venueSlug && venueCredMap[job.venueSlug]) return venueCredMap[job.venueSlug];
  // Last resort: default
  return defaultMuxAuth;
}

db.on('error', error => console.error('[Postgres] pool error:', error.message));
await db.query('SELECT 1');
const dbUrl = new URL(process.env.DATABASE_URL);
console.log(`[Postgres] Connected to ${dbUrl.host}${dbUrl.pathname}`);

const workerId = `${hostname()}:${process.pid}:${randomUUID()}`;
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
console.log('[Server] Polling pipeline_jobs for work...\n');

let idlePolls = 0;

// ── Main loop — atomically claim a queued or expired-lease job ─────────
while (true) {
  try {
    const job = await claimNextJob(db, workerId);
    if (!job) {
      if (++idlePolls % 15 === 1) {
        const { rows } = await db.query('SELECT status, count(*)::int AS n FROM pipeline_jobs GROUP BY status');
        console.log('[Server] Idle. Jobs by status:', rows.length ? rows.map(r => `${r.status}=${r.n}`).join(' ') : 'none');
      }
      await sleep(2000);
      continue;
    }
    idlePolls = 0;

    console.log(`[Server] Job received: ${job.jobId} — "${job.artistName}" venue=${job.venueSlug || 'default'}`);
    const muxAuth = getMuxAuthForJob(job);
    if (!muxAuth) {
      await updatePipelineJob(db, job.jobId, workerId, {
        done: 0,
        total: 30,
        status: 'error',
        error: 'No Mux credentials configured for this venue',
      });
      continue;
    }

    const abort = new AbortController();
    const heartbeat = setInterval(() => {
      renewPipelineJob(db, job.jobId, workerId).catch(error => {
        console.error(`[Server] Lease renewal failed for ${job.jobId}:`, error.message);
        // Lost lease means the job was cancelled or restarted from the dashboard.
        if (/Lost lease/.test(error.message)) abort.abort();
      });
    }, 5_000);
    try {
      await runPipeline({ ...job, db, workerId, muxAuth, signal: abort.signal });
    } catch (error) {
      console.error(`[Server] Unhandled pipeline error for ${job.jobId}:`, error.message);
      await updatePipelineJob(db, job.jobId, workerId, {
        done: 0,
        total: 30,
        status: 'error',
        error: error.message,
      }).catch(updateError => console.error('[Server] Failed to mark job error:', updateError.message));
    } finally {
      clearInterval(heartbeat);
    }
  } catch (error) {
    console.error('[Server] Loop error:', error.message);
    await sleep(2000);
  }
}
