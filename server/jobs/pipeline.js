import { exec } from 'child_process';
import { promisify } from 'util';
import { Readable } from 'stream';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { extractSubjectFrames, detectSubjectTrack, buildSubjectCropFilter } from './subject-reframe.js';
import { updatePipelineJob } from './pipeline-db.js';

const execAsync = promisify(exec);

const CLIP_COUNT  = 5;
const MIN_CLIP_DUR = 25;
const MAX_CLIP_DUR = 35;
const CONCURRENCY  = 4;   // simultaneous FFmpeg workers

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Helpers ───────────────────────────────────────────────────────────

async function muxGet(apiPath, auth) {
  const r = await fetch(`https://api.mux.com${apiPath}`, { headers: { Authorization: auth } });
  const j = await r.json();
  // Wrong or missing venue credentials never recover by retrying, so fail the job now.
  if (['unauthorized', 'forbidden', 'invalid_parameters'].includes(j.error?.type)) {
    throw new Error(`Mux rejected request (${j.error.messages?.[0] || j.error.type}). Check this venue's Mux credentials in VENUES_CONFIG.`);
  }
  return j;
}

// ── Wait for asset (HLS-ready = start immediately, don't block on MP4) ─

class AbortedError extends Error {}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new AbortedError('Job cancelled or restarted');
}

async function waitForAsset(uploadId, assetId, authHeader, signal) {
  if (!assetId) {
    console.log(`  Polling upload ${uploadId} for asset_id...`);
    for (let i = 0; i < 72; i++) {
      throwIfAborted(signal);
      await sleep(5000);
      const j = await muxGet(`/video/v1/uploads/${uploadId}`, authHeader);
      if (j.data?.asset_id) { assetId = j.data.asset_id; break; }
    }
    if (!assetId) throw new Error(`Timed out waiting for asset_id (uploadId=${uploadId})`);
    console.log(`  Asset created: ${assetId}`);
  }

  console.log(`  Waiting for asset ${assetId} to be ready...`);
  let playbackId, duration, srStatus;
  for (let i = 0; i < 120; i++) {
    throwIfAborted(signal);
    await sleep(5000);
    const j = await muxGet(`/video/v1/assets/${assetId}`, authHeader);
    const a = j.data;
    if (a?.status === 'ready' && a.playback_ids?.[0]?.id) {
      playbackId = a.playback_ids[0].id;
      duration   = a.duration || 0;
      srStatus   = a.static_renditions?.status;
      break;
    }
  }
  if (!playbackId) throw new Error(`Timed out waiting for asset ${assetId}`);

  if (srStatus === 'ready') {
    console.log(`  Static renditions ready — using MP4 (fastest)`);
    return { assetId, playbackId, duration, mp4Ready: true };
  }

  // Don't wait for MP4 static renditions (can take 60-90 min for 4K).
  // Proceed with HLS immediately using pre-input seeking.
  console.log(`  Static renditions ${srStatus || 'unavailable'} — using HLS with segment-seek`);
  return { assetId, playbackId, duration, mp4Ready: false };
}

// ── Encode one clip ───────────────────────────────────────────────────

async function processClip(videoUrl, start, dur, outPath, cropFilter, signal) {
  // Pre-input seeking is fast for both MP4 (HTTP range) and HLS (segment seek).
  // -allowed_extensions ALL is required for FFmpeg to accept HLS playlists over HTTPS.
  const ffBase = `ffmpeg -y -allowed_extensions ALL -protocol_whitelist file,https,http,tcp,tls,crypto`;

  const cmd =
    `${ffBase} -ss ${start} -t ${dur} -i "${videoUrl}" ` +
    `-map 0:v:0 -map 0:a:0? ` +
    `-vf "${cropFilter}" ` +
    `-c:v libx264 -preset ultrafast -crf 22 -b:v 5000k -maxrate 6000k -bufsize 8000k ` +
    `-c:a aac -b:a 192k ` +
    `-movflags +faststart "${outPath}"`;

  const { stderr } = await execAsync(cmd, { timeout: 300_000, maxBuffer: 20 * 1024 * 1024, signal });

  // Guard: confirm output exists and is not a stub
  if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 10_000) {
    throw new Error(`Output missing/empty. FFmpeg tail: ${stderr.slice(-400)}`);
  }
}

// ── Upload one clip to Mux ────────────────────────────────────────────

async function uploadClipToMux(filePath, passthrough, headers) {
  const uploadRes = await fetch('https://api.mux.com/video/v1/uploads', {
    method:  'POST',
    headers,
    body: JSON.stringify({
      new_asset_settings: {
        passthrough,
        playback_policy: ['public'],
        static_renditions: [{ resolution: 'highest' }],
      },
      cors_origin: '*',
    }),
  });
  const uploadData = await uploadRes.json();
  if (!uploadRes.ok) throw new Error('Mux upload create failed: ' + JSON.stringify(uploadData.error || uploadData));

  const putUrl   = uploadData.data.url;
  const fileSize = fs.statSync(filePath).size;

  const webStream = Readable.toWeb(fs.createReadStream(filePath));
  const putRes = await fetch(putUrl, {
    method:  'PUT',
    body:    webStream,
    headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(fileSize) },
    duplex:  'half',
  });
  if (!putRes.ok) {
    const body = await putRes.text().catch(() => '');
    throw new Error(`PUT failed HTTP ${putRes.status}: ${body.slice(0, 200)}`);
  }
}

// ── Main export ───────────────────────────────────────────────────────

export async function runPipeline({ jobId, uploadId, assetId: knownAssetId, artistName, venueSlug, db, workerId, muxAuth, signal }) {
  const { tokenId, tokenSecret } = muxAuth;
  const authHeader = 'Basic ' + Buffer.from(`${tokenId}:${tokenSecret}`).toString('base64');
  const headers    = { Authorization: authHeader, 'Content-Type': 'application/json' };

  const setProgress = (done, total, status, extra = {}) =>
    updatePipelineJob(db, jobId, workerId, { done, total, status, ...extra });

  const tmpDir = path.join(os.tmpdir(), `pipeline-${jobId}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    await setProgress(0, CLIP_COUNT, 'waiting');

    const { assetId, playbackId, duration, mp4Ready } = await waitForAsset(uploadId, knownAssetId, authHeader, signal);
    console.log(`[Pipeline:${jobId}] Ready — ${Math.round(duration)}s, playback=${playbackId}, mp4=${mp4Ready}`);

    if (duration < MIN_CLIP_DUR * 2) throw new Error(`Video too short: ${Math.round(duration)}s`);

    // highest.mp4 = best available quality static rendition; HLS fallback via .m3u8
    const videoUrl = mp4Ready
      ? `https://stream.mux.com/${playbackId}/highest.mp4`
      : `https://stream.mux.com/${playbackId}.m3u8`;

    console.log(`[Pipeline:${jobId}] Source: ${videoUrl}`);

    // Probe dimensions once so we can apply the high-res pre-scale optimisation
    let srcW = 0, srcH = 0;
    try {
      const { stdout } = await execAsync(
        `ffprobe -v quiet -allowed_extensions ALL -protocol_whitelist file,https,http,tcp,tls,crypto ` +
        `-select_streams v:0 -show_entries stream=width,height -of json "${videoUrl}"`,
        { timeout: 30_000 }
      );
      const probe = JSON.parse(stdout);
      const stream = (probe.streams || []).find(item =>
        Number.isFinite(item.width) && Number.isFinite(item.height) && item.width > 0 && item.height > 0
      );
      if (!stream) throw new Error('ffprobe returned no valid video dimensions');
      srcW = stream.width;
      srcH = stream.height;
      console.log(`[Pipeline:${jobId}] Dimensions: ${srcW}x${srcH}`);
    } catch (e) {
      throw new Error(`Could not determine source dimensions: ${e.message}`);
    }

    // Evenly-spaced clip specs with random jitter
    const margin   = Math.max(30, duration * 0.03);
    const safeStart = margin;
    const safeEnd   = duration - margin - MAX_CLIP_DUR;
    const step      = (safeEnd - safeStart) / CLIP_COUNT;

    const clipSpecs = Array.from({ length: CLIP_COUNT }, (_, i) => {
      const base   = safeStart + i * step;
      const jitter = (Math.random() - 0.5) * step * 0.6;
      const start  = Math.round(Math.max(safeStart, Math.min(safeEnd, base + jitter)));
      const dur    = MIN_CLIP_DUR + Math.round(Math.random() * (MAX_CLIP_DUR - MIN_CLIP_DUR));
      return { start, dur, num: String(i + 1).padStart(2, '0') };
    });

    let uploaded = 0, failed = 0;
    await setProgress(0, CLIP_COUNT, 'processing', { uploaded, failed });

    // Worker pool — CONCURRENCY clips encoded + uploaded simultaneously
    let idx = 0;  // safe in Node.js single-threaded async: idx++ is atomic per microtask

    async function worker() {
      while (idx < clipSpecs.length && !signal?.aborted) {
        const { start, dur, num } = clipSpecs[idx++];
        const tag     = `${artistName} // SOCIAL // ${num}`;
        const outPath = path.join(tmpDir, `clip_${num}.mp4`);

        console.log(`[Pipeline:${jobId}] ▶ Clip ${num}/${CLIP_COUNT}  ${start}s + ${dur}s`);
        try {
          if (!srcW || !srcH) throw new Error('Could not determine source dimensions for vertical reframing');
          const frameDir = path.join(tmpDir, `frames_${num}`);
          try {
            await extractSubjectFrames(videoUrl, start, dur, frameDir, signal);
            const subjectTrack = await detectSubjectTrack(frameDir);
            const cropFilter = buildSubjectCropFilter(subjectTrack, srcW, srcH, dur);
            throwIfAborted(signal);
            await processClip(videoUrl, start, dur, outPath, cropFilter, signal);
          } finally {
            try { fs.rmSync(frameDir, { recursive: true, force: true }); } catch (_) {}
          }
          throwIfAborted(signal);
          await uploadClipToMux(outPath, tag, headers);
          uploaded++;
          console.log(`[Pipeline:${jobId}] ✓ ${num}  (${uploaded} ok / ${failed} failed)`);
        } catch (e) {
          if (signal?.aborted) return;
          failed++;
          console.error(`[Pipeline:${jobId}] ✗ ${num} FAILED: ${e.message}`);
        } finally {
          try { fs.unlinkSync(outPath); } catch (_) {}
          if (!signal?.aborted) await setProgress(uploaded + failed, CLIP_COUNT, 'processing', { uploaded, failed });
        }
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    throwIfAborted(signal);

    const finalStatus = uploaded > 0 ? 'done' : 'error';
    const finalExtra  = { uploaded, failed };
    if (uploaded === 0) finalExtra.error = `All ${CLIP_COUNT} clips failed — check worker logs`;
    await setProgress(CLIP_COUNT, CLIP_COUNT, finalStatus, finalExtra);
    console.log(`[Pipeline:${jobId}] Complete: ${uploaded} uploaded, ${failed} failed`);

  } catch (e) {
    if (signal?.aborted || e instanceof AbortedError) {
      console.log(`[Pipeline:${jobId}] Stopped: cancelled or restarted from the dashboard`);
      return;
    }
    console.error(`[Pipeline:${jobId}] Fatal:`, e.message);
    await setProgress(0, CLIP_COUNT, 'error', { error: e.message });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}
