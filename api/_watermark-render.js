import sharp from 'sharp';
import opentype from 'opentype.js';

// Renders the Brand Kit watermark as a full-frame transparent PNG (1080×1920 for vertical clips),
// laid out exactly like the clip worker (server/jobs/watermark.js) and the Brand Kit preview.
// Mux puts it over a clip as an overlay covering the whole frame.

const BOX = { s: [180, 120], m: [260, 180], l: [380, 270] };
const TEXT_PX = { s: 48, m: 66, l: 110 };
// Large in the horizontal frame is a little smaller (same height, wider frame)
const textPx = (size, L) => (size === 'l' && L && L.W > L.H ? 86 : TEXT_PX[size] || TEXT_PX.m);
const TEXT_MAX_WIDTH = 760;
const STACK_GAP = 24;
export const VERTICAL = { W: 1080, H: 1920, mx: 60, top: 140, bottom: 120 };
export const HORIZONTAL = { W: 1920, H: 1080, mx: 60, top: 52, bottom: 52 };

async function download(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`Download failed (${r.status})`);
  return Buffer.from(await r.arrayBuffer());
}

// The frame of an animated image with the most visible pixels, as a PNG; a still image is returned as it is
async function fullestFrame(src) {
  const meta = await sharp(src, { animated: true }).metadata();
  const pages = meta.pages || 1;
  if (pages < 2) return src;
  const ph = meta.pageHeight || meta.height, w = meta.width;
  const { data, info } = await sharp(src, { animated: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels, per = w * ph * ch;
  let best = 0, bestCount = -1;
  for (let p = 0; p < pages; p++) {
    let n = 0;
    for (let i = p * per + 3; i < (p + 1) * per; i += ch * 4) if (data[i] > 128) n++;
    if (n > bestCount) { bestCount = n; best = p; }
  }
  return sharp(src, { page: best }).png().toBuffer();
}

async function logoLayer(wm, s = 1) {
  const box = BOX[wm.size] || BOX.m;
  // SVG and PDF logos are drawn from their vectors at a high density, so they stay sharp at any size
  let src = await download(wm.url);
  // A moving logo (GIF / animated WebP) on a still picture: its fullest frame, where the whole logo shows
  src = await fullestFrame(src).catch(() => src);
  const vector = /\.(svg|pdf)(\?|$)/i.test(wm.url) || /^\s*(<\?xml|<svg)/.test(src.subarray(0, 200).toString());
  // The empty margin around the logo is cut off first, so the logo itself fills the size's box
  let trimmed = await sharp(src, { density: vector ? Math.min(2400, Math.round(300 * s * 2)) : 72 }).trim({ threshold: 10 }).png().toBuffer().catch(() => null);
  if (!trimmed) trimmed = await sharp(src, { density: vector ? Math.min(2400, Math.round(300 * s * 2)) : 72 }).png().toBuffer();
  const { data, info } = await sharp(trimmed)
    .resize({ width: Math.round(box[0] * s), height: Math.round(box[1] * s), fit: 'inside', withoutEnlargement: false, kernel: 'lanczos3' })
    .png().toBuffer({ resolveWithObject: true });
  return { input: data, w: info.width, h: info.height };
}

// The title, and the subtitle under it in its own font (smaller), as one block lined up on the side
// of its corner. Both shrink together when the block is wider than maxWidth.
export const SUB_SCALE = 0.6, SUB_GAP = 0.2;
async function textLayer(text, size, maxWidth, s = 1, align = 'l', L = null) {
  const lines = [{ font: opentype.parse(new Uint8Array(await download(text.font)).buffer), value: text.value, k: 1 }];
  if (text.sub?.value && text.sub.font) {
    try { lines.push({ font: opentype.parse(new Uint8Array(await download(text.sub.font)).buffer), value: text.sub.value, k: SUB_SCALE }); }
    catch (e) { console.error('[watermark-render] subtitle:', e.message); }
  }
  let px = textPx(size, L) * s;
  const measure = () => lines.map(l => l.font.getPath(l.value, 0, 0, px * l.k).getBoundingBox());
  let bbs = measure(), width = Math.max(...bbs.map(b => b.x2 - b.x1));
  if (width > maxWidth) { px = px * maxWidth / width; bbs = measure(); width = Math.max(...bbs.map(b => b.x2 - b.x1)); }
  if (!(bbs[0].x2 > bbs[0].x1)) throw new Error('Text has no visible characters in this font');
  const pad = Math.round(12 * s), gap = px * SUB_GAP;
  let y = pad, paths = '';
  lines.forEach((l, i) => {
    const b = bbs[i], lw = b.x2 - b.x1;
    if (!(lw > 0)) return;
    const x = (align === 'r' ? pad + width - lw : align === 'c' ? pad + (width - lw) / 2 : pad) - b.x1;
    paths += `<path d="${l.font.getPath(l.value, x, y - b.y1, px * l.k).toPathData(2)}"/>`;
    y += (b.y2 - b.y1) + gap;
  });
  const w = Math.ceil(width) + pad * 2, h = Math.ceil(y - gap) + pad;
  const black = text.color === 'black';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><g fill="${black ? '#000' : '#fff'}">${paths}</g></svg>`;
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

// width: the clip's real width in px. The layout is designed at L.W and scaled up, so on a 4K clip
// the watermark is drawn at 4K instead of being stretched.
// An animated logo (a GIF or animated WebP with more than one frame): its frame size, else null
export async function animatedLogo(wm) {
  if (!wm?.url || !/\.(gif|webp)(\?|$)/i.test(wm.url)) return null;
  try {
    const m = await sharp(await download(wm.url), { animated: true }).metadata();
    return (m.pages || 1) > 1 ? { w: m.width, h: m.pageHeight || m.height } : null;
  } catch { return null; }
}

// For an animated logo: the still parts (text) as a full-frame PNG, and where the moving logo goes,
// laid out exactly as renderWatermarkPng would place a still logo of the same size
export async function renderWatermarkParts(wm, L = VERTICAL, width = L.W, frame) {
  const s = Math.max(1, width / L.W);
  const box = BOX[wm.size] || BOX.m;
  const k = Math.min(box[0] * s / frame.w, box[1] * s / frame.h);
  const w = Math.max(2, Math.round(frame.w * k / 2) * 2), h = Math.max(2, Math.round(frame.h * k / 2) * 2);
  return compose(wm, L, width, { w, h });
}

export async function renderWatermarkPng(wm, L = VERTICAL, width = L.W) {
  return (await compose(wm, L, width, null)).png;
}

async function compose(wm, L, width, movingLogo) {
  const s = Math.max(1, width / L.W);
  if (s !== 1) L = { W: Math.round(L.W * s), H: Math.round(L.H * s), mx: L.mx * s, top: L.top * s, bottom: L.bottom * s };
  const position = wm.position || 'bl';
  const layers = [];
  let logo = null;
  if (movingLogo) logo = { input: null, w: movingLogo.w, h: movingLogo.h, moving: true };
  else if (wm.url) logo = await logoLayer(wm, s).catch(e => { console.error('[watermark-render] logo:', e.message); return null; });
  // cc: centred in the frame (text set in the middle too goes under the logo)
  const place = (pos, w, h, shift) => pos === 'cc'
    ? { left: Math.round((L.W - w) / 2), top: Math.round((L.H - h) / 2 + shift) }
    : {
      left: Math.round(pos[1] === 'l' ? L.mx : L.W - L.mx - w),
      top: Math.round(pos[0] === 't' ? L.top + shift : L.H - L.bottom - shift - h),
    };
  if (logo) layers.push({ ...logo, ...place(position, logo.w, logo.h, 0) });
  if (wm.text?.value && wm.text.font) {
    const tPos = wm.text.position || 'br';
    const sameRow = logo && tPos !== position && tPos[0] === position[0];
    // Both in the middle: side by side, the text then the logo, centred together
    const besides = logo && tPos === 'cc' && position === 'cc', G = 32 * s;
    const room = besides ? Math.min(TEXT_MAX_WIDTH * s, L.W - 2 * L.mx - logo.w - G) : sameRow ? Math.min(TEXT_MAX_WIDTH * s, L.W - 2 * L.mx - logo.w - 48 * s) : TEXT_MAX_WIDTH * s;
    const t = await textLayer(wm.text, wm.text.size || wm.size, room, s, besides ? 'l' : tPos[1], L).catch(e => { console.error('[watermark-render] text:', e.message); return null; });
    if (t && besides) {
      const lg = layers[0], left = Math.round((L.W - (t.w + G + logo.w)) / 2);
      layers.push({ ...t, left, top: Math.round((L.H - t.h) / 2) });
      lg.left = Math.round(left + t.w + G); lg.top = Math.round((L.H - logo.h) / 2);
    } else if (t) {
      // Same corner: next to the logo. Same row, other side: lined up with the middle of the logo.
      const shift = !logo ? 0 : tPos === position ? logo.h + STACK_GAP * s : sameRow ? (logo.h - t.h) / 2 : 0;
      layers.push({ ...t, ...place(tPos, t.w, t.h, shift) });
    }
  }
  const moving = layers.find(l => l.moving) || null;
  const still = layers.filter(l => !l.moving);
  const logoAt = moving ? { left: moving.left, top: moving.top, w: moving.w, h: moving.h, opacity: Math.min(1, Math.max(0.3, Number(wm.opacity) || 0.9)), W: L.W, H: L.H } : null;
  if (!still.length) return { png: moving ? await sharp({ create: { width: L.W, height: L.H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer() : null, logoAt };
  const faded = await Promise.all(still.map(l => withOpacity(l, wm.opacity)));
  const png = await sharp({ create: { width: L.W, height: L.H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(faded.map(l => ({ input: l.input, left: l.left, top: l.top })))
    .png().toBuffer();
  return { png, logoAt };
}
