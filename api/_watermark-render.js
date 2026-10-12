import sharp from 'sharp';
import opentype from 'opentype.js';

// Renders the Brand Kit watermark as a full-frame transparent PNG (1080×1920 for vertical clips),
// laid out exactly like the clip worker (server/jobs/watermark.js) and the Brand Kit preview.
// Mux puts it over a clip as an overlay covering the whole frame.

const BOX = { s: [120, 80], m: [160, 110], l: [220, 150] };
const TEXT_PX = { s: 36, m: 46, l: 60 };
const TEXT_MAX_WIDTH = 760;
const STACK_GAP = 24;
export const VERTICAL = { W: 1080, H: 1920, mx: 60, top: 140, bottom: 120 };

async function download(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`Download failed (${r.status})`);
  return Buffer.from(await r.arrayBuffer());
}

async function logoLayer(wm) {
  const box = BOX[wm.size] || BOX.m;
  const { data, info } = await sharp(await download(wm.url), { density: 300 })
    .resize({ width: box[0], height: box[1], fit: 'inside', withoutEnlargement: false })
    .png().toBuffer({ resolveWithObject: true });
  return { input: data, w: info.width, h: info.height };
}

async function textLayer(text, size, maxWidth) {
  const font = opentype.parse(new Uint8Array(await download(text.font)).buffer);
  let px = TEXT_PX[size] || TEXT_PX.m;
  let bb = font.getPath(text.value, 0, 0, px).getBoundingBox();
  if (bb.x2 - bb.x1 > maxWidth) {
    px = px * maxWidth / (bb.x2 - bb.x1);
    bb = font.getPath(text.value, 0, 0, px).getBoundingBox();
  }
  if (!(bb.x2 > bb.x1)) throw new Error('Text has no visible characters in this font');
  const pad = 12;
  const w = Math.ceil(bb.x2 - bb.x1) + pad * 2, h = Math.ceil(bb.y2 - bb.y1) + pad * 2;
  const d = font.getPath(text.value, pad - bb.x1, pad - bb.y1, px).toPathData(2);
  const black = text.color === 'black';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<filter id="s" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="4"/></filter>` +
    `<path d="${d}" fill="${black ? '#fff' : '#000'}" fill-opacity="${black ? '.25' : '.35'}" filter="url(#s)" transform="translate(0 2)"/>` +
    `<path d="${d}" fill="${black ? '#000' : '#fff'}"/></svg>`;
  return { input: await sharp(Buffer.from(svg)).png().toBuffer(), w, h };
}

// Applies opacity to a PNG layer
async function withOpacity(layer, opacity) {
  const a = Math.min(1, Math.max(0.3, Number(opacity) || 0.9));
  if (a >= 1) return layer;
  const input = await sharp(layer.input).ensureAlpha()
    .composite([{ input: Buffer.from([255, 255, 255, Math.round(a * 255)]), raw: { width: 1, height: 1, channels: 4 }, tile: true, blend: 'dest-in' }])
    .png().toBuffer();
  return { ...layer, input };
}

export async function renderWatermarkPng(wm, L = VERTICAL) {
  const position = wm.position || 'bl';
  const layers = [];
  let logo = null;
  if (wm.url) logo = await logoLayer(wm).catch(e => { console.error('[watermark-render] logo:', e.message); return null; });
  const place = (pos, w, h, shift) => ({
    left: Math.round(pos[1] === 'l' ? L.mx : L.W - L.mx - w),
    top: Math.round(pos[0] === 't' ? L.top + shift : L.H - L.bottom - shift - h),
  });
  if (logo) layers.push({ ...logo, ...place(position, logo.w, logo.h, 0) });
  if (wm.text?.value && wm.text.font) {
    const tPos = wm.text.position || 'br';
    const sameRow = logo && tPos !== position && tPos[0] === position[0];
    const room = sameRow ? Math.min(TEXT_MAX_WIDTH, L.W - 2 * L.mx - logo.w - 48) : TEXT_MAX_WIDTH;
    const t = await textLayer(wm.text, wm.size, room).catch(e => { console.error('[watermark-render] text:', e.message); return null; });
    if (t) {
      // Same corner: next to the logo. Same row, other side: lined up with the middle of the logo.
      const shift = !logo ? 0 : tPos === position ? logo.h + STACK_GAP : sameRow ? (logo.h - t.h) / 2 : 0;
      layers.push({ ...t, ...place(tPos, t.w, t.h, shift) });
    }
  }
  if (!layers.length) return null;
  const faded = await Promise.all(layers.map(l => withOpacity(l, wm.opacity)));
  return sharp({ create: { width: L.W, height: L.H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(faded.map(l => ({ input: l.input, left: l.left, top: l.top })))
    .png().toBuffer();
}
