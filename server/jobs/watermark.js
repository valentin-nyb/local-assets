import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

// Brand Kit watermark for vertical clips (1080×1920).
// The job carries { url, position, size, opacity }; the logo is downloaded once per job,
// rasterised to PNG (SVG logos included) and laid over every clip by ffmpeg.

const WIDTH = { s: 160, m: 220, l: 300 };   // logo width in px on a 1080-wide frame
const MAX_HEIGHT = 160;                      // keeps tall logos from covering the picture
const MARGIN_X = 56;
// Bottom and top margins clear the captions and buttons TikTok, Reels and Shorts draw over the clip
const MARGIN_BOTTOM = 320;
const MARGIN_TOP = 220;

export async function prepareWatermark(watermark, dir) {
  if (!watermark?.url) return null;
  const r = await fetch(watermark.url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`Logo download failed (${r.status})`);
  const input = Buffer.from(await r.arrayBuffer());
  const file = path.join(dir, 'watermark.png');
  await sharp(input, { density: 300 })
    .resize({ width: WIDTH[watermark.size] || WIDTH.m, height: MAX_HEIGHT, fit: 'inside', withoutEnlargement: false })
    .png()
    .toFile(file);
  if (!fs.existsSync(file)) throw new Error('Logo could not be prepared');
  return { ...watermark, file };
}

// filter_complex tail: input [v] is the cropped 1080×1920 clip, input 1 the logo; output [out]
export function overlayChain({ position = 'br', opacity = 0.9 }) {
  const x = position.endsWith('l') ? `${MARGIN_X}` : `W-w-${MARGIN_X}`;
  const y = position.startsWith('t') ? `${MARGIN_TOP}` : `H-h-${MARGIN_BOTTOM}`;
  const a = Math.min(1, Math.max(0.3, Number(opacity) || 0.9));
  return `[1:v]format=rgba,colorchannelmixer=aa=${a}[wm];[v][wm]overlay=${x}:${y}:format=auto[out]`;
}
