import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';

const execAsync = promisify(exec);

const CLIP_COUNT = 30;
const MIN_CLIP_DUR = 25;
const MAX_CLIP_DUR = 35;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Helpers ──────────────────────────────────────────────────────────

function muxHeaders(tokenId, tokenSecret) {
  return {
    Authorization: 'Basic ' + Buffer.from(`${tokenId}:${tokenSecret}`).toString('base64'),
    'Content-Type': 'application/json',
  };
}

async function muxGet(path, auth) {
  const r = await fetch(`https://api.mux.com${path}`, { headers: { Authorization: auth } });
  return r.json();
}

// ── Step 1-2: Wait for asset ──────────────────────────────────────────

async function waitForAsset(uploadId, assetId, authHeader) {
  // If we already have an assetId, skip polling the upload
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
      return { assetId, playbackId: a.playback_ids[0].id, duration: a.duration || 0 };
    }
  }
  throw new Error(`Timed out waiting for asset ${assetId} to be ready`);
}

// ── Step 3: Smart-reframe one clip ────────────────────────────────────

async function processClip(hlsUrl, start, dur, outPath) {
  const tmpDir = path.dirname(outPath);
  const rawPath = outPath.replace('.mp4', '_raw.mp4');

  // Download raw clip segment — explicitly map video + audio so the HLS
  // alternate audio rendition group is included in the output file.
  await execAsync(
    `ffmpeg -y -ss ${start} -t ${dur} -i "${hlsUrl}" -map 0:v:0 -map 0:a:0 -c copy "${rawPath}"`,
    { timeout: 120_000 }
  );

  // Probe dimensions of the raw clip
  const { stdout: probeOut } = await execAsync(
    `ffprobe -v quiet -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${rawPath}"`,
    { timeout: 15_000 }
  );
  const [srcW, srcH] = probeOut.trim().split(',').map(Number);

  // Cropdetect: sample 1 frame/sec to find the most active horizontal region
  let cropFilter;
  try {
    const { stderr } = await execAsync(
      `ffmpeg -i "${rawPath}" -vf "fps=1,cropdetect=24:2:0" -frames:v ${dur} -f null -`,
      { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 }
    );

    // Collect all crop= detections, pick the most common
    const allMatches = [...stderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
    if (allMatches.length > 0) {
      // Tally cx values weighted by cw to find the action center
      let sumCenterX = 0;
      let sumCenterY = 0;
      let sumCH = 0;
      for (const m of allMatches) {
        const [, cw, ch, cx, cy] = m.map(Number);
        sumCenterX += cx + cw / 2;
        sumCenterY += cy + ch / 2;
        sumCH += ch;
      }
      const actionCenterX = sumCenterX / allMatches.length;
      const contentH = Math.round(sumCH / allMatches.length);

      // Use the detected content height (handles letterboxing)
      const targetH = Math.min(contentH, srcH);
      const targetW = Math.floor(targetH * 9 / 16 / 2) * 2;   // even number
      let finalX = Math.round(actionCenterX - targetW / 2);
      finalX = Math.max(0, Math.min(srcW - targetW, finalX));

      // Vertical: center on the content band
      const contentTopY = Math.round(sumCenterY / allMatches.length - contentH / 2);
      const finalY = Math.max(0, Math.min(srcH - targetH, contentTopY));

      cropFilter = `crop=${targetW}:${targetH}:${finalX}:${finalY},scale=1080:1920:flags=lanczos`;
      console.log(`    Cropdetect: center=${Math.round(actionCenterX)}px → crop ${targetW}x${targetH}@${finalX},${finalY}`);
    }
  } catch (e) {
    console.log(`    Cropdetect failed (${e.message.slice(0, 60)}), using center crop`);
  }

  if (!cropFilter) {
    // Fallback: simple center crop to 9:16
    cropFilter = `crop=ih*9/16:ih:(iw-ih*9/16)/2:0,scale=1080:1920:flags=lanczos`;
  }

  // Encode final 9:16 portrait clip
  await execAsync(
    `ffmpeg -y -i "${rawPath}" ` +
    `-map 0:v:0 -map 0:a:0 ` +
    `-vf "${cropFilter}" ` +
    `-c:v libx264 -preset slow -crf 18 -b:v 8000k ` +
    `-c:a aac -b:a 192k ` +
    `-movflags +faststart "${outPath}"`,
    { timeout: 600_000 }
  );

  fs.unlinkSync(rawPath);
}

// ── Step 4: Upload clip to Mux ────────────────────────────────────────

async function uploadClipToMux(filePath, passthrough, headers) {
  // Create Mux upload URL
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
  const buf = fs.readFileSync(filePath);

  const putRes = await fetch(putUrl, {
    method: 'PUT',
    body: buf,
    headers: { 'Content-Type': 'video/mp4' },
  });
  if (!putRes.ok) throw new Error(`PUT failed: HTTP ${putRes.status}`);
}

// ── Main export ──────────────────────────────────────────────────────

export async function runPipeline({ jobId, uploadId, assetId: knownAssetId, artistName, redis, muxAuth }) {
  const { tokenId, tokenSecret } = muxAuth;
  const authHeader = 'Basic ' + Buffer.from(`${tokenId}:${tokenSecret}`).toString('base64');
  const headers = { Authorization: authHeader, 'Content-Type': 'application/json' };

  const setProgress = (done, total, status, extra = {}) =>
    redis.set(`pipeline:job:${jobId}`, JSON.stringify({ done, total, status, artistName, updatedAt: Date.now(), ...extra }), { EX: 7200 });

  const tmpDir = path.join(os.tmpdir(), `pipeline-${jobId}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    await setProgress(0, CLIP_COUNT, 'waiting');

    // ── 1+2. Get asset info ──────────────────────────────────────────
    const { assetId, playbackId, duration } = await waitForAsset(uploadId, knownAssetId, authHeader);
    console.log(`[Pipeline:${jobId}] Asset ready — ${Math.round(duration)}s @ ${playbackId}`);

    if (duration < MIN_CLIP_DUR * 2) throw new Error(`Video too short: ${Math.round(duration)}s`);

    // ── 3. Build clip specs (evenly spread + random jitter + random duration) ──
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

    const hlsUrl = `https://stream.mux.com/${playbackId}.m3u8`;
    await setProgress(0, CLIP_COUNT, 'processing');

    // ── 4. Process clips ──────────────────────────────────────────────
    for (let i = 0; i < clipSpecs.length; i++) {
      const { start, dur } = clipSpecs[i];
      const clipNum = String(i + 1).padStart(2, '0');
      const tag = `${artistName} // SOCIAL // ${clipNum}`;
      const outPath = path.join(tmpDir, `clip_${clipNum}.mp4`);

      console.log(`[Pipeline:${jobId}] Clip ${clipNum}/${CLIP_COUNT}: ${start}s-${start + dur}s  "${tag}"`);
      await setProgress(i, CLIP_COUNT, 'processing', { currentClip: clipNum });

      try {
        await processClip(hlsUrl, start, dur, outPath);
        await uploadClipToMux(outPath, tag, headers);
        console.log(`    ✓ Uploaded`);
      } catch (e) {
        console.error(`    ✗ Clip ${clipNum} failed:`, e.message);
      } finally {
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
