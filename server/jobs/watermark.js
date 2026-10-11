import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import opentype from 'opentype.js';

// Brand Kit watermark for vertical clips (1080×1920).
// The job carries { url, position, size, opacity, text: { value, font, position } }.
// The logo and the text are each turned into a PNG once per job, then laid over every clip by ffmpeg.

// Largest logo box per size [width, height] in px on a 1080-wide frame; the logo keeps its proportions
const BOX = { s: [160, 110], m: [240, 170], l: [340, 240] };
const TEXT_PX = { s: 44, m: 56, l: 72 };     // text size in px
const TEXT_MAX_WIDTH = 760;
// Side margin: about 11% of the width, clear of the edge and of the like and share buttons on the right
const MARGIN_X = 120;
// Bottom and top margins clear the captions and buttons TikTok, Reels and Shorts draw over the clip
const MARGIN_BOTTOM = 320;
const MARGIN_TOP = 220;
const STACK_GAP = 24;                        // between logo and text when they share a corner

async function download(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`Download failed (${r.status})`);
  return Buffer.from(await r.arrayBuffer());
}

async function prepareLogo(watermark, dir) {
  const file = path.join(dir, 'watermark.png');
  const info = await sharp(await download(watermark.url), { density: 300 })
    .resize({ width: (BOX[watermark.size] || BOX.m)[0], height: (BOX[watermark.size] || BOX.m)[1], fit: 'inside', withoutEnlargement: false })
    .png()
    .toFile(file);
  return { file, w: info.width, h: info.height };
}

// Draws the text with the uploaded font file (TTF, OTF or WOFF) as an SVG path, then rasterises it
async function prepareText(text, size, dir, maxWidth = TEXT_MAX_WIDTH) {
  const font = opentype.parse(new Uint8Array(await download(text.font)).buffer);
  let px = TEXT_PX[size] || TEXT_PX.m;
  let p = font.getPath(text.value, 0, 0, px);
  let bb = p.getBoundingBox();
  if (bb.x2 - bb.x1 > maxWidth) {
    px = px * maxWidth / (bb.x2 - bb.x1);
    p = font.getPath(text.value, 0, 0, px);
    bb = p.getBoundingBox();
  }
  if (!(bb.x2 > bb.x1)) throw new Error('Text has no visible characters in this font');
  const pad = 12;
  const w = Math.ceil(bb.x2 - bb.x1) + pad * 2, h = Math.ceil(bb.y2 - bb.y1) + pad * 2;
  const d = font.getPath(text.value, pad - bb.x1, pad - bb.y1, px).toPathData(2);
  // White or black text; a soft shadow in the opposite tone keeps it readable on busy scenes
  const black = text.color === 'black';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<filter id="s" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="4"/></filter>` +
    `<path d="${d}" fill="${black ? '#fff' : '#000'}" fill-opacity="${black ? '.25' : '.35'}" filter="url(#s)" transform="translate(0 2)"/>` +
    `<path d="${d}" fill="${black ? '#000' : '#fff'}"/></svg>`;
  const file = path.join(dir, 'watermark-text.png');
  await sharp(Buffer.from(svg)).png().toFile(file);
  return { file, w, h };
}

// Returns the overlays to apply, each { file, x, y } as ffmpeg overlay expressions, plus opacity
export async function prepareWatermark(watermark, dir) {
  if (!watermark?.url && !watermark?.text?.value) return null;
  const position = watermark.position || 'bl';
  const layers = [];
  let logo = null;
  if (watermark.url) {
    try { logo = await prepareLogo(watermark, dir); }
    catch (e) { console.error(`  Watermark logo skipped: ${e.message}`); }
  }
  if (logo) layers.push({ file: logo.file, ...place(position, 0) });
  if (watermark.text?.value && watermark.text.font) {
    try {
      const tPos = watermark.text.position || 'br';
      // On the same row as the logo, the text keeps clear of it
      const room = logo && tPos !== position && tPos[0] === position[0] ? 1080 - 2 * MARGIN_X - logo.w - 48 : TEXT_MAX_WIDTH;
      const t = await prepareText(watermark.text, watermark.size, dir, Math.min(TEXT_MAX_WIDTH, room));
      if (logo && tPos === position) {
        // Same corner as the logo: the text sits next to it, further from the edge of the frame
        layers.push({ file: t.file, ...place(tPos, logo.h + STACK_GAP) });
      } else if (logo && tPos[0] === position[0]) {
        // Same row, other side: the text lines up with the middle of the logo
        const x = tPos[1] === 'l' ? `${MARGIN_X}` : `W-w-${MARGIN_X}`;
        const y = tPos[0] === 't'
          ? `${MARGIN_TOP + Math.round((logo.h - t.h) / 2)}`
          : `H-${MARGIN_BOTTOM + Math.round((logo.h + t.h) / 2)}`;
        layers.push({ file: t.file, x, y });
      } else {
        layers.push({ file: t.file, ...place(tPos, 0) });
      }
    } catch (e) { console.error(`  Watermark text skipped: ${e.message}`); }
  }
  if (!layers.length) return null;
  return { layers, opacity: watermark.opacity };
}

function place(position, shift) {
  const x = position.endsWith('l') ? `${MARGIN_X}` : `W-w-${MARGIN_X}`;
  const y = position.startsWith('t') ? `${MARGIN_TOP + shift}` : `H-h-${MARGIN_BOTTOM + shift}`;
  return { x, y };
}

// ffmpeg inputs for the overlays, after the source video (input 0)
export function overlayInputs({ layers }) {
  return layers.map(l => `-i "${l.file}"`).join(' ');
}

// filter_complex tail: input [v] is the cropped 1080×1920 clip, inputs 1.. the overlays; output [out]
export function overlayChain({ layers, opacity = 0.9 }) {
  const a = Math.min(1, Math.max(0.3, Number(opacity) || 0.9));
  let prev = 'v';
  return layers.map((l, i) => {
    const out = i === layers.length - 1 ? 'out' : `o${i}`;
    const s = `[${i + 1}:v]format=rgba,colorchannelmixer=aa=${a}[w${i}];[${prev}][w${i}]overlay=${l.x}:${l.y}:format=auto[${out}]`;
    prev = out;
    return s;
  }).join(';');
}
