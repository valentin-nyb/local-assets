import { exec } from 'child_process';
import { promisify } from 'util';
import { Readable } from 'stream';
import fs from 'fs';
import path from 'path';
import os from 'os';

const execAsync = promisify(exec);

const CLIP_COUNT = 30;
const MIN_CLIP_DUR = 25;
const MAX_CLIP_DUR = 35;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Helpers ──────────────────────────────────────────────────────────

async function muxGet(path, auth) {
  const r = await fetch(`https://api.mux.com${path}`, { headers: { Authorization: auth } });
  return r.json();
}

// ── Step 1-2: Wait for asset + static renditions ──────────────────────

async function waitForAsset(uploadId, assetId, authHeader) {
  if (!assetId) {
    console.log(`  Polling upload ${uploadId} for asset_id...`);
    for (let i = 0; i < 72; i++) {   // up to 6 min
      await sleep(5000);
      const j = await muxGet(`/video/v1/uploads/${uploadId}`, authHeader);
      if (j.data?.asset_id) { assetId = j.data.asset_id; break; }
    }
    if (!assetId) throw new Error(`Timed out waiting for asset_id (uploadId=${uploadId})`);
    console.log(`  Asset created: ${assetId}`);
  }

  console.log(`  Waiting for asset ${assetId} to be ready...`);
  for (let i = 0; i < 120; i++) {   // up to 10 min
    await sleep(5000);
    const j = await muxGet(`/video/v1/assets/${assetId}`, authHeader);
    const a = j.data;
    if (a?.status === 'ready' && a.playback_ids?.[0]?.id) {
      const playbackId = a.playback_ids[0].id;
      const duration = a.duration || 0;
      const srStatus = a.static_renditions?.status;
      if (srStatus === 'ready') {
        console.log(`  Static renditions ready — using MP4`);
        return { assetId, playbackId, duration, mp4Ready: true };
      }
      // Asset ready but static renditions still preparing — keep polling
      if (srStatus === 'preparing') continue;
      // No static renditions configured — fall back to HLS
      console.log(`  No static renditions (sr_status=${srStatus}) — using HLS`);
      return { assetId, playbackId, duration, mp4Ready: false };
    }
  }
  throw new Error(`Timed out waiting for asset ${assetId} to be ready`);
}

// ── Step 3: Smart-reframe one clip — no intermediate raw file ─────────

async function processClip(videoUrl, start, dur, outPath, srcW, srcH) {
  // Pass 1 — cropdetect directly from source (streaming, no disk write)
  let cropFilter;
  if (srcW && srcH) {
    try {
      const { stderr } = await execAsync(
        `ffmpeg -ss ${start} -t ${dur} -i "${videoUrl}" -vf "fps=1,cropdetect=24:2:0" -t ${dur} -f null -`,
        { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 }
      );

      const allMatches = [...stderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
      if (allMatches.length > 0) {
        let sumCenterX = 0, sumCenterY = 0, sumCH = 0;
        for (const m of allMatches) {
          const [, cw, ch, cx, cy] = m.map(Number);
          sumCenterX += cx + cw / 2;
          sumCenterY += cy + ch / 2;
          sumCH += ch;
        }
        const actionCenterX = sumCenterX / allMatches.length;
        const contentH = Math.round(sumCH / allMatches.length);

        const targetH = Math.min(contentH, srcH);
        const targetW = Math.floor(targetH * 9 / 16 / 2) * 2;
        let finalX = Math.round(actionCenterX - targetW / 2);
        finalX = Math.max(0, Math.min(srcW - targetW, finalX));
        const contentTopY = Math.round(sumCenterY / allMatches.length - contentH / 2);
        const finalY = Math.max(0, Math.min(srcH - targetH, contentTopY));

        cropFilter = `crop=${targetW}:${targetH}:${finalX}:${finalY},scale=1080:1920:flags=lanczos`;
        console.log(`    Cropdetect: center=${Math.round(actionCenterX)}px → crop ${targetW}x${targetH}@${finalX},${finalY}`);
      }
    } catch (e) {
      console.log(`    Cropdetect failed (${e.message.slice(0, 80)}), using center crop`);
    }
  }

  if (!cropFilter) {
    cropFilter = `crop=ih*9/16:ih:(iw-ih*9/16)/2:0,scale=1080:1920:flags=lanczos`;
  }

  // Pass 2 — encode directly to output, ultrafast for Railway CPU limits
  await execAsync(
    `ffmpeg -y -ss ${start} -t ${dur} -i "${videoUrl}" ` +
    `-map 0:v:0 -map 0:a:0 ` +
    `-vf "${cropFilter}" ` +
    `-c:v libx264 -preset ultrafast -crf 26 -b:v 3500k ` +
    `-c:a aac -b:a 128k ` +
    `-movflags +faststart "${outPath}"`,
    { timeout: 300_000 }
  );
}

// ── Step 4: Upload clip to Mux — streaming, no RAM buffer ─────────────

async function uploadClipToMux(filePath, passthrough, headers) {
  const uploadRes = await fetch('https://api.mux.com/video/v1/uploads', {
    method: 'POST',
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

  const putUrl = uploadData.data.url;
  const fileSize = fs.statSync(filePath).size;

  // Stream the file directly — avoids loading entire clip into RAM
  const nodeStream = fs.createReadStream(filePath);
  const webStream = Readable.toWeb(nodeStream);

  const putRes = await fetch(putUrl, {
    method: 'PUT',
    body: webStream,
    headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(fileSize) },
    duplex: 'half',
  });
  if (!putRes.ok) throw new Error(`PUT failed: HTTP ${putRes.status}`);
}

// ── Main export ──────────────────────────────────────────────────────

export async function runPipeline({ jobId, uploadId, assetId: knownAssetId, artistName, venueSlug, redis, muxAuth }) {
  const { tokenId, tokenSecret } = muxAuth;
  const authHeader = 'Basic ' + Buffer.from(`${tokenId}:${tokenSecret}`).toString('base64');
  const headers = { Authorization: authHeader, 'Content-Type': 'application/json' };

  const setProgress = (done, total, status, extra = {}) =>
    redis.set(`pipeline:job:${jobId}`, JSON.stringify({ done, total, status, artistName, venueSlug: venueSlug || '', updatedAt: Date.now(), ...extra }), { EX: 7200 });

  const tmpDir = path.join(os.tmpdir(), `pipeline-${jobId}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    await setProgress(0, CLIP_COUNT, 'waiting');

    // ── 1+2. Get asset info + wait for static renditions ─────────────
    const { assetId, playbackId, duration, mp4Ready } = await waitForAsset(uploadId, knownAssetId, authHeader);
    console.log(`[Pipeline:${jobId}] Asset ready — ${Math.round(duration)}s @ ${playbackId} (mp4=${mp4Ready})`);

    if (duration < MIN_CLIP_DUR * 2) throw new Error(`Video too short: ${Math.round(duration)}s`);

    // Prefer MP4 static rendition for fast HTTP-range seeking; fall back to HLS
    const videoUrl = mp4Ready
      ? `https://stream.mux.com/${playbackId}/highest.mp4`
      : `https://stream.mux.com/${playbackId}.m3u8`;

    console.log(`[Pipeline:${jobId}] Source: ${videoUrl}`);

    // ── 2b. Probe source dimensions once (avoids per-clip ffprobe) ───
    let srcW = 0, srcH = 0;
    try {
      const { stdout: probeOut } = await execAsync(
        `ffprobe -v quiet -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${videoUrl}"`,
        { timeout: 30_000 }
      );
      [srcW, srcH] = probeOut.trim().split(',').map(Number);
      console.log(`[Pipeline:${jobId}] Source dimensions: ${srcW}x${srcH}`);
    } catch (e) {
      console.log(`[Pipeline:${jobId}] ffprobe failed (${e.message.slice(0, 60)}), cropdetect disabled`);
    }

    // ── 3. Build clip specs ──────────────────────────────────────────
    const margin = Math.max(30, duration * 0.03);
    const safeStart = margin;
    const safeEnd = duration - margin - MAX_CLIP_DUR;

    const clipSpecs = [];
    const step = (safeEnd - safeStart) / CLIP_COUNT;
    for (let i = 0; i < CLIP_COUNT; i++) {
      const base = safeStart + i * step;
      const jitter = (Math.random() - 0.5) * step * 0.6;
      const start = Math.round(Math.max(safeStart, Math.min(safeEnd, base + jitter)));
      const dur = MIN_CLIP_DUR + Math.round(Math.random() * (MAX_CLIP_DUR - MIN_CLIP_DUR));
      clipSpecs.push({ start, dur });
    }

    await setProgress(0, CLIP_COUNT, 'processing');

    // ── 4. Process & upload clips ────────────────────────────────────
    for (let i = 0; i < clipSpecs.length; i++) {
      const { start, dur } = clipSpecs[i];
      const clipNum = String(i + 1).padStart(2, '0');
      const tag = `${artistName} // SOCIAL // ${clipNum}`;
      const outPath = path.join(tmpDir, `clip_${clipNum}.mp4`);

      console.log(`[Pipeline:${jobId}] Clip ${clipNum}/${CLIP_COUNT}: ${start}s-${start + dur}s  "${tag}"`);
      await setProgress(i, CLIP_COUNT, 'processing', { currentClip: clipNum });

      try {
        await processClip(videoUrl, start, dur, outPath, srcW, srcH);
        await uploadClipToMux(outPath, tag, headers);
        console.log(`    ✓ Uploaded`);
      } catch (e) {
        console.error(`    ✗ Clip ${clipNum} failed:`, e.message);
      } finally {
        // Always clean up the output file immediately to free disk space
        try { fs.unlinkSync(outPath); } catch (_) {}
      }

      await setProgress(i + 1, CLIP_COUNT, 'processing');
    }

    await setProgress(CLIP_COUNT, CLIP_COUNT, 'done');
    console.log(`[Pipeline:${jobId}] ✓ Complete for "${artistName}"`);

  } catch (e) {
    console.error(`[Pipeline:${jobId}] Fatal:`, e.message);
    await setProgress(0, CLIP_COUNT, 'error', { error: e.message });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}
