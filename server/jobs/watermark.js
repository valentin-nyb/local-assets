import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import opentype from 'opentype.js';

// Brand Kit watermark for vertical clips (1080×1920).
// The job carries { url, position, size, opacity, text: { value, font, position, sub?: { value, font } } }.
// The logo and the text are each turned into a PNG once per job, then laid over every clip by ffmpeg.

// Largest logo box per size [width, height] in px on a 1080-wide frame; the logo keeps its proportions
const BOX = { s: [180, 120], m: [260, 180], l: [380, 270] };
const TEXT_PX = { s: 48, m: 66, l: 92 };     // text size in px
const TEXT_MAX_WIDTH = 760;
// Side margin, close to the edge (same as the Brand Kit preview)
const MARGIN_X = 60;
// Bottom and top margins, low in the frame (same as the Brand Kit preview)
const MARGIN_BOTTOM = 120;
const MARGIN_TOP = 140;
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

// Draws the text with the uploaded font file (TTF, OTF or WOFF) as SVG paths, then rasterises it.
// An optional subtitle (text.sub) sits under the title in its own font, smaller, lined up on the same side.
const SUB_SCALE = 0.6, SUB_GAP = 0.2;
async function prepareText(text, size, dir, maxWidth = TEXT_MAX_WIDTH, align = 'l') {
  const lines = [{ font: opentype.parse(new Uint8Array(await download(text.font)).buffer), value: text.value, k: 1 }];
  if (text.sub?.value && text.sub.font) {
    try { lines.push({ font: opentype.parse(new Uint8Array(await download(text.sub.font)).buffer), value: text.sub.value, k: SUB_SCALE }); }
    catch (e) { console.error(`  Watermark subtitle skipped: ${e.message}`); }
  }
  let px = TEXT_PX[size] || TEXT_PX.m;
  const measure = () => lines.map(l => l.font.getPath(l.value, 0, 0, px * l.k).getBoundingBox());
  let bbs = measure(), width = Math.max(...bbs.map(b => b.x2 - b.x1));
  if (width > maxWidth) { px = px * maxWidth / width; bbs = measure(); width = Math.max(...bbs.map(b => b.x2 - b.x1)); }
  if (!(bbs[0].x2 > bbs[0].x1)) throw new Error('Text has no visible characters in this font');
  const pad = 12, gap = px * SUB_GAP;
  let y = pad, paths = '';
  lines.forEach((l, i) => {
    const b = bbs[i], lw = b.x2 - b.x1;
    if (!(lw > 0)) return;
    const x = (align === 'r' ? pad + width - lw : pad) - b.x1;
    paths += `<path d="${l.font.getPath(l.value, x, y - b.y1, px * l.k).toPathData(2)}"/>`;
    y += (b.y2 - b.y1) + gap;
  });
  const w = Math.ceil(width) + pad * 2, h = Math.ceil(y - gap) + pad;
  // Flat white or black text, no shadow
  const black = text.color === 'black';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><g fill="${black ? '#000' : '#fff'}">${paths}</g></svg>`;
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
      const t = await prepareText(watermark.text, watermark.text.size || watermark.size, dir, Math.min(TEXT_MAX_WIDTH, room), tPos[1]);
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
