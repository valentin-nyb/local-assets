import { list } from '@vercel/blob';

// Watermark for vertical clips, set on the Brand Kit page and stored in Redis per venue.
// When a clip job is queued, it is resolved to a concrete logo URL and saved on the job,
// so the clip worker never needs Redis or Blob access of its own.

export const WATERMARK_DEFAULTS = { enabled: true, logo: 'auto', position: 'br', size: 'm', opacity: 0.9 };
const POSITIONS = ['br', 'bl', 'tr', 'tl'];
const SIZES = ['s', 'm', 'l'];
// ffmpeg reads these; SVG is rasterised by the worker
const LOGO_FILE = /\.(png|svg|webp|jpe?g)$/i;

export const watermarkKey = slug => `brand_watermark:${slug}`;

export function slugify(name) {
  return String(name).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

// Accepts user input from the Brand Kit page; anything unknown falls back to the default.
export function cleanWatermark(input = {}) {
  const w = { ...WATERMARK_DEFAULTS };
  if (typeof input.enabled === 'boolean') w.enabled = input.enabled;
  if (POSITIONS.includes(input.position)) w.position = input.position;
  if (SIZES.includes(input.size)) w.size = input.size;
  const op = Number(input.opacity);
  if (op >= 0.3 && op <= 1) w.opacity = Math.round(op * 100) / 100;
  // "auto" = the artist's logo, else the account's; "account" = always the account's; or one file's URL
  if (input.logo === 'auto' || input.logo === 'account') w.logo = input.logo;
  else if (typeof input.logo === 'string' && /^https:\/\/[a-z0-9]+\.public\.blob\.vercel-storage\.com\//.test(input.logo)) w.logo = input.logo;
  return w;
}

export async function readWatermark(redis, slug) {
  try { return cleanWatermark(JSON.parse(await redis.get(watermarkKey(slug)) || '{}')); }
  catch { return { ...WATERMARK_DEFAULTS }; }
}

// The logo to stamp on an artist's clips, or null when watermarks are off or no logo exists.
export async function resolveWatermark(redis, slug, artist) {
  const w = await readWatermark(redis, slug);
  if (!w.enabled) return null;

  const prefix = `brand/${slug}/`;
  const logos = [];
  let cursor;
  do {
    const page = await list({ prefix, cursor, limit: 1000 });
    for (const b of page.blobs) {
      const [owner, category] = b.pathname.slice(prefix.length).split('/');
      if (category === 'logos' && LOGO_FILE.test(b.pathname)) logos.push({ owner, url: b.url, at: new Date(b.uploadedAt).getTime() });
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  logos.sort((a, b) => b.at - a.at);

  let url = null;
  if (w.logo.startsWith('https://')) url = logos.find(l => l.url === w.logo)?.url || null;
  if (!url && w.logo === 'auto' && artist) url = logos.find(l => l.owner === 'artist-' + slugify(artist))?.url || null;
  if (!url) url = logos.find(l => l.owner === 'venue')?.url || null;
  if (!url) return null;
  return { url, position: w.position, size: w.size, opacity: w.opacity };
}
