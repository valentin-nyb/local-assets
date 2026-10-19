import Stripe from 'stripe';
import { list } from '@vercel/blob';
import { getVenuesConfig, getMuxAuthForVenue } from './_venues.js';

// Usage-based billing: each venue's real usage of the services it runs on (Mux video, Vercel Blob
// files), priced at cost plus the local / assets margin, invoiced monthly through Stripe.

// Costs in GBP. Saved over in Redis (billing_rates) from the Billing page.
export const DEFAULT_RATES = {
  videoStorage: 0.01,      // per stored minute, per month (+ margin ≈ £120 per extra TB)
  videoDelivery: 0.0008,   // per minute streamed or downloaded
  videoEncoding: 0,        // per minute of new video (included)
  fileStorage: 0.018,      // per GB of files, per month
  margin: 0.5,             // admin costs added on top of cost (50%): every usage price and the estimated invoice include it
  currency: 'gbp',
};

export async function readRates(redis) {
  try {
    const saved = JSON.parse(await redis.get('billing_rates') || '{}');
    // Once (19 Oct 2026): 50% admin costs on every usage price
    if (!(await redis.get('billing_rates_margin_v3'))) {
      saved.margin = 0.5;
      await redis.set('billing_rates', JSON.stringify(saved));
      await redis.set('billing_rates_margin_v3', new Date().toISOString());
    }
    // Once: storage above a plan's allowance moves to about £120 per TB (it was below Mux's own cost)
    if (saved.videoStorage != null && Number(saved.videoStorage) < DEFAULT_RATES.videoStorage && !(await redis.get('billing_rates_storage_v2'))) {
      saved.videoStorage = DEFAULT_RATES.videoStorage;
      await redis.set('billing_rates', JSON.stringify(saved));
      await redis.set('billing_rates_storage_v2', new Date().toISOString());
    }
    return { ...DEFAULT_RATES, ...saved };
  }
  catch { return { ...DEFAULT_RATES }; }
}

// Plans: a monthly price with usage included; usage above it is billed as overage
export const DEFAULT_PLANS = [
  { id: 'dj-trial', name: 'Trial Month', price: 0, signupFee: 49, maxClips: 6, cameras: 0,
    included: { storedMinutes: 0, deliveredMinutes: 0, fileGB: 0 },
    features: ['From £49 to join (comes off your first month), then pay as you go', '6 vertical social clips per session', 'Brand Kit and watermark', 'Camera Control: phone, OBS or your own camera', 'Distribution History', 'Usage charged to your card on the 1st'] },
  { id: 'starter-distribution', name: 'Starter', price: 2750, maxClips: 6, cameras: 0,
    included: { storedMinutes: 10000, deliveredMinutes: 25000, fileGB: 1000 },
    features: ['Camera available as an add-on', 'Content intake & quality control', 'Up to 8 events processed / month', '6 vertical clips per session', 'Brand Kit, thumbnails & watermark', '1 TB cloud storage'] },
  { id: 'liveset-distribution', name: 'Pro', price: 3500, maxClips: 12, cameras: 1,
    included: { storedMinutes: 20000, deliveredMinutes: 50000, fileGB: 2000 },
    features: ['1 camera included', 'Content intake & quality control', 'Up to 8 events processed / month', '12 vertical clips per session', 'Brand Kit, thumbnails & watermark', '2 TB cloud storage'] },
  { id: 'starter-creative', name: 'Creative & Production · Starter', price: 5500, maxClips: 12, cameras: 1,
    included: { storedMinutes: 50000, deliveredMinutes: 100000, fileGB: 5000 },
    features: ['1 camera included', 'Starlink Mini', '4K master recordings', 'HQ audio capture', '12 vertical clips per session', 'Brand Kit, thumbnails & watermark', '5 TB cloud storage'] },
  { id: 'liveset-creative', name: 'Live-Set', price: 7500, maxClips: 0, cameras: 2,
    included: { storedMinutes: 100000, deliveredMinutes: 500000, fileGB: 10000 },
    features: ['2 cameras included', 'Starlink Mini + Mac mini', '4K master recordings', 'HQ audio capture', 'Multi-camera auto-edit', 'Unlimited vertical clips per session', 'Brand Kit, thumbnails & watermark', 'Quarterly performance reports', '10 TB cloud storage'] },
];
// Storage per plan: 1 / 2 / 5 / 10 TB (1 TB ≈ 10,000 minutes of 4K in Mux), so Mux stays near 10% of each plan's price.
// Applied once to a plan list saved before the change, so Billing and invoices use the new allowances.
const STORAGE_V2 = {
  'starter-distribution': { storedMinutes: 10000, fileGB: 1000, label: '1 TB cloud storage' },
  'liveset-distribution': { storedMinutes: 20000, fileGB: 2000, label: '2 TB cloud storage' },
  'starter-creative': { storedMinutes: 50000, fileGB: 5000, label: '5 TB cloud storage' },
  'liveset-creative': { storedMinutes: 100000, fileGB: 10000, label: '10 TB cloud storage' },
};
async function upgradeSavedStorage(redis, list) {
  try {
    if (await redis.get('billing_plans_storage_v2')) return list;
    const out = list.map(x => {
      const u = STORAGE_V2[x.id]; if (!u) return x;
      return { ...x, included: { ...(x.included || {}), storedMinutes: u.storedMinutes, fileGB: u.fileGB },
        features: Array.isArray(x.features) ? x.features.map(f => /^\s*[\d.,]+\s*(GB|TB)\s+cloud storage\s*$/i.test(f) ? u.label : f) : x.features };
    });
    await redis.set('billing_plans', JSON.stringify(out));
    await redis.set('billing_plans_storage_v2', new Date().toISOString());
    return out;
  } catch { return list; }
}
// Distribution · Starter has no camera included: a camera is an add-on for a fee. Applied once to a saved plan list.
async function upgradeStarterCamera(redis, list) {
  try {
    if (await redis.get('billing_plans_camera_v3')) return list;
    const out = list.map(x => x.id !== 'starter-distribution' ? x : { ...x, cameras: 0,
      features: Array.isArray(x.features) ? x.features.map(f => /^\s*1 camera included\s*$/i.test(f) ? 'Camera available as an add-on' : f) : x.features });
    await redis.set('billing_plans', JSON.stringify(out));
    await redis.set('billing_plans_camera_v3', new Date().toISOString());
    return out;
  } catch { return list; }
}
// Every plan: clips counted per session, and Brand Kit, thumbnails & watermark included. Applied once to a saved list.
const BRAND_LINE = 'Brand Kit, thumbnails & watermark';
async function upgradePlanWording(redis, list) {
  try {
    if (await redis.get('billing_plans_wording_v4')) return list;
    const out = list.map(x => {
      if (!Array.isArray(x.features) || x.id === 'dj-trial') return x;
      let f = x.features.map(t => t.replace(/^(\S+) vertical(?: social)? clips(?: per (?:session|set))?$/i, '$1 vertical clips per session').replace(/^multi-camera auto edit(,\s*cut to the music)?$/i, 'Multi-camera auto-edit'))
        .filter(t => !/^(marketing thumbnails( & watermark)?|brand kit watermark|brand kit, thumbnails & watermark)$/i.test(t.trim()));
      const at = f.findIndex(t => /vertical clips per session$/.test(t));
      f.splice(at >= 0 ? at + 1 : f.length, 0, BRAND_LINE);
      return { ...x, features: f };
    });
    await redis.set('billing_plans', JSON.stringify(out));
    await redis.set('billing_plans_wording_v4', new Date().toISOString());
    return out;
  } catch { return list; }
}
// The Venue Trial Month gives the same as Distribution · Starter (its features, storage and clips); it keeps
// its own name and price. Applied once to the saved plan list.
async function upgradeVenueTrial(redis, list) {
  try {
    if (await redis.get('billing_plans_trial_v6')) return list;
    // A saved plan without its own feature list shows the built-in one, so copy that
    const def = DEFAULT_PLANS.find(x => x.id === 'starter-distribution');
    const saved = list.find(x => x.id === 'starter-distribution') || {};
    const starter = { ...def, ...saved, features: saved.features && saved.features.length ? saved.features : def.features, included: { ...def.included, ...(saved.included || {}) } };
    const out = list.map(x => !/venue\s*trial/i.test(String(x.name || '')) ? x : { ...x,
      features: [...starter.features], included: { ...starter.included }, maxClips: starter.maxClips, cameras: starter.cameras || 0 });
    await redis.set('billing_plans', JSON.stringify(out));
    await redis.set('billing_plans_trial_v6', new Date().toISOString());
    return out;
  } catch { return list; }
}
// Three plans (18 Oct 2026): Starter, Pro and Live-Set, without the Distribution / Creative & Production split.
// Their old names are renamed once; Creative & Production · Starter stays for anyone already on it, no longer offered.
const THREE_PLAN_NAMES = { 'starter-distribution': [/^distribution\s*·\s*starter$/i, 'Starter'], 'liveset-distribution': [/^distribution\s*·\s*pro$/i, 'Pro'], 'liveset-creative': [/^creative\s*&\s*production\s*·\s*live-set$/i, 'Live-Set'] };
async function upgradeThreePlans(redis, list) {
  try {
    if (await redis.get('billing_plans_three_v7')) return list;
    const out = list.map(x => { const r = THREE_PLAN_NAMES[x.id]; return r && r[0].test(String(x.name || '').trim()) ? { ...x, name: r[1] } : x; });
    await redis.set('billing_plans', JSON.stringify(out));
    await redis.set('billing_plans_three_v7', new Date().toISOString());
    return out;
  } catch { return list; }
}
// A Venue Trial plan gives what Starter gives (clips, Brand Kit, cameras) but no included usage: every set,
// upload, GB of storage and minute streamed is pay as you go, charged on the 1st. Kept in step with Starter;
// it keeps its own name and price.
function trialLikeStarter(list) {
  const starter = list.find(x => x.id === 'starter-distribution');
  if (!starter) return list;
  const feats = (starter.features || []).filter(f => !/cloud storage|events? processed|sets? (a|per) month|included/i.test(f));
  return list.map(x => !/venue\s*trial/i.test(String(x.name || '')) ? x : { ...x,
    features: [...feats, 'Pay as you go: every set, upload, GB of storage and stream charged on the 1st'],
    included: { storedMinutes: 0, deliveredMinutes: 0, fileGB: 0 }, maxClips: starter.maxClips, cameras: starter.cameras || 0 });
}
// Monthly plan prices by account type: venues pay the list price, record labels half, artists half of that
// (a quarter, to the nearest £5). Applied at checkout, on plan changes, on the billing page and the pricing page.
// Plans with hardware we buy (Live-Set: cameras, Mac mini, Starlink Mini) run for at least 12 months
export const MIN_TERM_PLANS = ['liveset-creative'];
export const commitEndFor = planId => MIN_TERM_PLANS.includes(planId) ? new Date(Date.now() + 365 * 86400e3).toISOString().slice(0, 10) : '';
export const TYPE_FACTOR = { venue: 1, label: 0.5, artist: 0.25 };
// Set prices that replace the rule for one plan and type (planId → type → £ a month)
export const TYPE_PRICE = { 'starter-distribution': { artist: 379 } };
export function priceForType(price, type, planId) {
  const set = planId && TYPE_PRICE[planId] && TYPE_PRICE[planId][type];
  if (set && price > 0) return set;
  const f = TYPE_FACTOR[type];
  if (!(price > 0) || !f || f === 1) return price;
  return Math.round(price * f / 5) * 5;
}
export function planForType(plan, type) { return plan && plan.price > 0 ? { ...plan, price: priceForType(plan.price, type, plan.id) } : plan; }
export async function readPlansRaw(redis) {
  // The Trial Month is always offered, even when the saved plan list predates it
  const withPayg = list => [...DEFAULT_PLANS.filter(d => d.id === 'dj-trial' && !list.some(p => p.id === d.id)), ...list];
  try { let p = JSON.parse(await redis.get('billing_plans') || 'null'); if (Array.isArray(p) && p.length) p = await upgradeThreePlans(redis, await upgradeVenueTrial(redis, await upgradePlanWording(redis, await upgradeStarterCamera(redis, await upgradeSavedStorage(redis, p))))); return Array.isArray(p) && p.length ? withPayg(p.map(x => { const d = DEFAULT_PLANS.find(z => z.id === x.id) || {}; return { ...x, signupFee: x.signupFee != null ? x.signupFee : (d.signupFee || 0), features: (x.features && x.features.length ? x.features : d.features), cameras: x.cameras != null ? x.cameras : (d.cameras || 0), maxClips: x.maxClips != null ? x.maxClips : (d.maxClips != null ? d.maxClips : 5) }; })) : DEFAULT_PLANS; }
  catch { return DEFAULT_PLANS; }
}
export async function readPlans(redis) { return trialLikeStarter(await readPlansRaw(redis)); }
export function cleanPlans(list) {
  return (Array.isArray(list) ? list : []).slice(0, 30).map((p, i) => {
    const name = String(p?.name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60);
    const num = v => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : 0; };
    const id = String(p?.id || '').replace(/[^a-z0-9-]/g, '').slice(0, 40) || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `plan-${i + 1}`;
    return name ? { id, name, price: num(p.price), signupFee: num(p.signupFee), maxClips: Math.min(60, Math.max(0, Math.round(num(p.maxClips)))), cameras: Math.round(num(p.cameras)), features: Array.isArray(p.features) ? p.features.map(f => String(f).replace(/[<>]/g, '').slice(0, 80)).filter(Boolean).slice(0, 14) : undefined, included: { storedMinutes: num(p.included?.storedMinutes), deliveredMinutes: num(p.included?.deliveredMinutes), fileGB: num(p.included?.fileGB) } } : null;
  }).filter(Boolean);
}

// Kit expenses (admin): the hardware we buy and ship in the rolling case for Pro and Live-Set, with what
// each item costs us and how many of it each plan gets. Saved over in Redis (billing_kit) from the Billing page.
// cost null = not entered yet.
export const KIT_PLANS = ['liveset-distribution', 'liveset-creative'];
export const DEFAULT_KIT = [
  { id: 'camera', name: 'OBSBOT Tail 2 camera', cost: null, qty: { 'liveset-distribution': 1, 'liveset-creative': 2 } },
  { id: 'usb-cable', name: 'Fibre optic USB-C cable, 9 m (GeoHN.G)', cost: 65.99, qty: { 'liveset-distribution': 1, 'liveset-creative': 2 } },
  { id: 'mac-mini', name: 'Mac mini', cost: null, qty: { 'liveset-distribution': 0, 'liveset-creative': 1 } },
  { id: 'starlink-mini', name: 'Starlink Mini', cost: null, qty: { 'liveset-distribution': 0, 'liveset-creative': 1 } },
  { id: 'starlink-cover', name: 'Starlink Mini cover, orange (Joinfworld)', cost: 20.99, qty: { 'liveset-distribution': 0, 'liveset-creative': 1 } },
  { id: 'starlink-case', name: 'Starlink Mini hard case, orange (Joinfworld)', cost: 59.99, qty: { 'liveset-distribution': 0, 'liveset-creative': 1 } },
  { id: 'rolling-case', name: 'Rolling hard case, pick-and-pluck foam (Reflex)', cost: 109.99, qty: { 'liveset-distribution': 1, 'liveset-creative': 1 } },
];
export async function readKit(redis) {
  try { const saved = JSON.parse(await redis.get('billing_kit') || 'null'); if (Array.isArray(saved)) return saved; } catch {}
  return DEFAULT_KIT;
}
export function cleanKit(list) {
  return (Array.isArray(list) ? list : []).slice(0, 40).map((k, i) => {
    const name = String(k?.name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 80);
    const c = k?.cost === '' || k?.cost == null ? null : Number(k.cost);
    const qty = {};
    for (const p of KIT_PLANS) { const n = Number(k?.qty?.[p]); qty[p] = Number.isFinite(n) && n >= 0 ? Math.min(20, Math.round(n)) : 0; }
    const id = String(k?.id || '').replace(/[^a-z0-9-]/g, '').slice(0, 40) || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `item-${i + 1}`;
    return name ? { id, name, cost: Number.isFinite(c) && c >= 0 ? Math.round(c * 100) / 100 : null, qty } : null;
  }).filter(Boolean);
}

// Who an invoice is for: the venue itself ("venue") or one of its artists ("artist:DJ TENNIS")
export const assignKey = slug => `billing_assign:${slug}`;   // hash target → JSON { plan, email, name, monthly }
export async function readAssignments(redis, slug) {
  const raw = await redis.hGetAll(assignKey(slug));
  const out = {};
  for (const [k, v] of Object.entries(raw || {})) { try { out[k] = JSON.parse(v); } catch {} }
  return out;
}
// How many vertical clips a session of this account may have (its plan's limit, 5 without a plan)
export async function planMaxClips(redis, slug) {
  const plan = await readPlan(redis, slug, 'venue').catch(() => null);
  const def = DEFAULT_PLANS.find(d => d.id === plan?.id);
  const n = plan && plan.maxClips != null ? Number(plan.maxClips) : def ? def.maxClips : 5;
  return n === 0 ? 60 : Math.min(60, Math.max(1, n || 5));   // 0 = unlimited (up to 60 a session)
}
export async function readPlan(redis, slug, target = 'venue') {
  const a = (await readAssignments(redis, slug))[target];
  if (!a?.plan) return null;
  return (await readPlans(redis)).find(p => p.id === a.plan) || null;
}

const muxGet = (auth, path) => fetch('https://api.mux.com' + path, { headers: { Authorization: auth }, signal: AbortSignal.timeout(20000) })
  .then(async r => { const b = await r.json().catch(() => ({})); if (!r.ok) throw new Error(b?.error?.messages?.[0] || `Mux ${r.status}`); return b; });

export function monthRange(d = new Date()) {
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return { start, end, label: new Date(start).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }), key: new Date(start).toISOString().slice(0, 7) };
}

// Usage for one venue in [start, end): video minutes stored, streamed and added, and GB of files
const artistOfAsset = a => {
  const pt = String(a.passthrough || '').trim();
  try { const o = JSON.parse(pt); if (o && o.artist) return String(o.artist).toUpperCase().trim(); } catch {}
  return pt.split(' // ')[0].toUpperCase().trim();
};
const slugify = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

// Artists with sessions in this venue's Cloud Storage
export async function venueArtists(auth) {
  const names = new Set();
  if (!auth) return [];
  for (let page = 1; page <= 30; page++) {
    const b = await muxGet(auth, `/video/v1/assets?limit=100&page=${page}`);
    for (const a of b.data || []) { const n = artistOfAsset(a); if (n && n.length < 60 && !/^[a-z0-9]{20,}$/i.test(n)) names.add(n); }
    if ((b.data || []).length < 100) break;
  }
  return [...names].sort();
}

// Usage day by day, for the usage chart: video minutes stored at the end of each day and minutes
// streamed that day. Finished days are cached (Mux reports streaming up to about 12 hours ago).
export async function usageByDay(redis, slug, auth, { from, to }, artist = null, label = null) {
  const DAY = 86400e3;
  const days = [];
  for (let t = from; t < to; t += DAY) days.push({ start: t, stored: 0, delivered: 0 });
  const only = artist ? String(artist).toUpperCase().trim() : null;
  // Files (Brand Kit, thumbnails, watermarked clips), counted exactly as venueUsage does, with their upload times
  const files = [];
  const prefixes = label ? [`brand/${slug}/label-${slugify(label)}/`] : only ? [`brand/${slug}/artist-${slugify(only)}/`] : [`brand/${slug}/`, `thumbnails/${slug}/`, `watermarks/${slug}/`];
  for (const prefix of prefixes) {
    let cursor;
    do {
      const page = await list({ prefix, cursor, limit: 1000 });
      for (const b of page.blobs) files.push({ at: new Date(b.uploadedAt).getTime() || 0, bytes: b.size || 0 });
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
  }
  if (!auth || label) return { days, notes: [], vids: [], files };
  const notes = [], vids = [], ids = new Set();
  try {
    for (let page = 1; page <= 30; page++) {
      const b = await muxGet(auth, `/video/v1/assets?limit=100&page=${page}`);
      for (const a of b.data || []) {
        if (a.status !== 'ready') continue;
        if (only && artistOfAsset(a) !== only) continue;
        ids.add(a.id);
        vids.push({ at: Number(a.created_at) * 1000, min: (Number(a.duration) || 0) / 60 });
      }
      if ((b.data || []).length < 100) break;
    }
  } catch (e) { notes.push('Video usage unavailable: ' + e.message); return { days, notes, vids: [], files }; }
  for (const d of days) d.stored = vids.reduce((s, v) => s + (v.at < d.start + DAY ? v.min : 0), 0);
  const reported = Math.floor((Date.now() - 12.5 * 3600e3) / 3600e3) * 3600e3;
  const key = d => `usage_day2:${slug}:${only || '*'}:${new Date(d.start).toISOString().slice(0, 10)}`;
  const queue = days.filter(d => d.start < reported);
  const work = async () => {
    while (queue.length) {
      const d = queue.shift(), end = Math.min(d.start + DAY, reported), done = end === d.start + DAY;
      if (done) { const c = await redis.get(key(d)); if (c !== null) { d.delivered = Number(c) || 0; continue; } }
      try {
        let sec = 0;
        for (let page = 1; page <= 20; page++) {
          const b = await muxGet(auth, `/video/v1/delivery-usage?limit=100&page=${page}&timeframe[]=${Math.floor(d.start / 1000)}&timeframe[]=${Math.floor(end / 1000)}`);
          for (const r of b.data || []) if (!only || ids.has(r.asset_id)) sec += Number(r.delivered_seconds) || 0;
          if ((b.data || []).length < 100) break;
        }
        d.delivered = sec / 60;
        if (done) await redis.set(key(d), String(d.delivered), { EX: 400 * 86400 });
      } catch (e) { if (!notes.length) notes.push('Some streaming figures are unavailable: ' + e.message); }
    }
  };
  await Promise.all([work(), work(), work(), work()]);
  return { days, notes, vids, files };
}

export async function venueUsage(slug, auth, { start, end }, artist = null, label = null) {
  const only = artist ? String(artist).toUpperCase().trim() : null;
  if (label) auth = null;   // a record label is billed for its brand kit files only
  const ids = new Set();
  const usage = { storedMinutes: 0, newMinutes: 0, deliveredMinutes: 0, fileBytes: 0, videos: 0, notes: [] };
  if (auth) {
    // Mux keys that no longer work (environment deleted or keys revoked): bill no video usage, say why
    try { await muxGet(auth, '/video/v1/assets?limit=1&page=1'); }
    catch (e) { usage.notes.push('Video usage unavailable: Mux refused this account\'s keys (' + e.message + ')'); auth = null; }
  }
  if (auth) {
    for (let page = 1; page <= 30; page++) {
      const b = await muxGet(auth, `/video/v1/assets?limit=100&page=${page}`);
      for (const a of b.data || []) {
        if (a.status !== 'ready') continue;
        if (only && artistOfAsset(a) !== only) continue;
        ids.add(a.id);
        const min = (Number(a.duration) || 0) / 60;
        usage.storedMinutes += min; usage.videos++;
        const created = Number(a.created_at) * 1000;
        if (created >= start && created < end) usage.newMinutes += min;
      }
      if ((b.data || []).length < 100) break;
    }
    // Streaming: Mux delivery usage for the period (up to the last full hour)
    // Mux reports streaming up to 12 hours ago
    const to = Math.min(end, Math.floor((Date.now() - 12.5 * 3600e3) / 3600e3) * 3600e3);
    if (to > start) {
      try {
        for (let page = 1; page <= 30; page++) {
          const b = await muxGet(auth, `/video/v1/delivery-usage?limit=100&page=${page}&timeframe[]=${Math.floor(start / 1000)}&timeframe[]=${Math.floor(to / 1000)}`);
          for (const r of b.data || []) if (!only || ids.has(r.asset_id)) usage.deliveredMinutes += (Number(r.delivered_seconds) || 0) / 60;
          if ((b.data || []).length < 100) break;
        }
      } catch (e) { usage.notes.push('Streaming figures unavailable: ' + e.message); }
    }
  }
  // Files: Brand Kit, thumbnails and watermark images
  const prefixes = label ? [`brand/${slug}/label-${slugify(label)}/`] : only ? [`brand/${slug}/artist-${slugify(only)}/`] : [`brand/${slug}/`, `thumbnails/${slug}/`, `watermarks/${slug}/`];
  for (const prefix of prefixes) {
    let cursor;
    do {
      const page = await list({ prefix, cursor, limit: 1000 });
      for (const b of page.blobs) usage.fileBytes += b.size || 0;
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
  }
  return usage;
}

const round2 = n => Math.round(n * 100) / 100;

// Invoice lines: each service's usage, its cost and the price with the margin
// Each service's usage; with a plan, only what is above the plan's included amount is charged
export function priceUsage(usage, rates, plan) {
  const m = 1 + (Number(rates.margin) || 0);
  const gb = usage.fileBytes / 1e9;
  const inc = plan?.included || {};
  const lines = [
    { key: 'videoStorage', label: 'Video storage', quantity: usage.storedMinutes, included: inc.storedMinutes || 0, unit: 'minutes stored', rate: rates.videoStorage },
    { key: 'videoDelivery', label: 'Streaming and downloads', quantity: usage.deliveredMinutes, included: inc.deliveredMinutes || 0, unit: 'minutes delivered', rate: rates.videoDelivery },
    { key: 'videoEncoding', label: 'New video processing', quantity: usage.newMinutes, included: 0, unit: 'minutes added', rate: rates.videoEncoding },
    { key: 'fileStorage', label: 'File storage', quantity: gb, included: inc.fileGB || 0, unit: 'GB', rate: rates.fileStorage },
  ].map(l => {
    const billable = Math.max(0, l.quantity - l.included);
    return { ...l, quantity: round2(l.quantity), billable: round2(billable), cost: round2(billable * l.rate), amount: round2(billable * l.rate * m) };
  });
  const usageTotal = round2(lines.reduce((s, l) => s + l.amount, 0));
  const planAmount = plan && Number(plan.price) > 0 ? round2(Number(plan.price)) : 0;
  return { lines, usageTotal, plan: plan || null, planAmount, total: round2(usageTotal + planAmount), currency: rates.currency || 'gbp' };
}

export function stripeClient() {
  const sk = (process.env.LA_STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY);   // local / assets own Stripe account first, else the Vercel integration
  return sk ? new Stripe(sk) : null;
}

// The venue's Stripe customer, made on first use
const EU = new Set('AT BE BG CY CZ DE DK EE ES FI FR GR HR HU IE IT LT LU LV MT NL PL PT RO SE SI SK'.split(' '));
// The billing details printed on the Stripe invoice: legal name, postal address and VAT number
export async function applyDetails(stripe, id, details) {
  if (!details?.legalName) return;
  await stripe.customers.update(id, {
    name: details.legalName,
    address: { line1: details.line1 || undefined, line2: details.line2 || undefined, city: details.city || undefined, postal_code: details.postcode || undefined, country: details.country || 'GB' },
  });
  if (details.vat) {
    const type = details.country === 'GB' ? 'gb_vat' : EU.has(details.country) ? 'eu_vat' : null;
    if (!type) return;
    const have = await stripe.customers.listTaxIds(id, { limit: 20 }).catch(() => ({ data: [] }));
    if (have.data.some(t => t.value.replace(/\s+/g, '').toUpperCase() === details.vat)) return;
    for (const t of have.data) await stripe.customers.deleteTaxId(id, t.id).catch(() => {});
    await stripe.customers.createTaxId(id, { type, value: details.vat }).catch(e => console.error('[billing] VAT number', id, e.message));
  }
}
export async function venueCustomer(stripe, redis, slug, { email, name, details }) {
  const saved = await redis.get(`billing_customer:${slug}`);
  if (saved) {
    // A customer saved from another Stripe account (after switching accounts) is made again here
    const ok = await stripe.customers.retrieve(saved).then(c => !c.deleted).catch(() => false);
    if (ok) {
      if (email) await stripe.customers.update(saved, { email, name: name || undefined }).catch(() => {});
      await applyDetails(stripe, saved, details);
      return saved;
    }
  }
  const c = await stripe.customers.create({ email: email || undefined, name: name || slug, metadata: { venueSlug: slug } });
  await redis.set(`billing_customer:${slug}`, c.id);
  await applyDetails(stripe, c.id, details);
  return c.id;
}

// The card the customer saved at sign-up (or later through Stripe), if any
export async function defaultCard(stripe, customer) {
  const c = await stripe.customers.retrieve(customer).catch(() => null);
  const pm = c && !c.deleted ? c.invoice_settings?.default_payment_method : null;
  return pm ? (typeof pm === 'string' ? pm : pm.id) : null;
}

export function venueEntries() {
  return Object.entries(getVenuesConfig()).map(([slug, cfg]) => ({ slug, cfg, auth: getMuxAuthForVenue({ slug, ...cfg }) }));
}

// Creates and sends the invoice for one venue and one month (once)
export async function invoiceVenue(redis, stripe, { slug, auth, email, name, target = 'venue', planId }, period) {
  const doneKey = `billing_invoiced:${slug}:${target}:${period.key}`;
  const existing = await redis.get(doneKey);
  if (existing) return { skipped: true, invoice: existing };
  const rates = await readRates(redis);
  const plans = await readPlans(redis);
  const plan = planId !== undefined ? (plans.find(p => p.id === planId) || null) : await readPlan(redis, slug, target);
  const artist = target.startsWith('artist:') ? target.slice(7) : null;
  const label = target.startsWith('label:') ? target.slice(6) : null;
  const usage = await venueUsage(slug, auth, period, artist, label);
  const priced = priceUsage(usage, rates, plan);
  if (priced.total < 0.3) { await redis.set(doneKey, 'none'); return { skipped: true, reason: 'Nothing to bill' }; }
  const details = (await readAssignments(redis, slug))[target]?.details || null;
  if (!details?.legalName || !details?.line1) { await redis.del(doneKey); return { skipped: true, reason: 'Billing details missing: add the legal name and address in Bill to' }; }
  const customer = await venueCustomer(stripe, redis, target === 'venue' ? slug : `${slug}:${target}`, { email, name, details });
  const currency = priced.currency;
  // Accounts from a sign-up pay the plan through their Stripe subscription: invoice the usage above it only
  const viaSubscription = !!(await readAssignments(redis, slug))[target]?.subscription;
  if (viaSubscription) priced.total = priced.usageTotal;
  if (priced.total < 0.3) { await redis.set(doneKey, 'none'); return { skipped: true, reason: 'Nothing above the plan to bill' }; }
  if (priced.planAmount && !viaSubscription) {
    await stripe.invoiceItems.create({ customer, currency, amount: Math.round(priced.planAmount * 100), description: `${plan.name || 'Plan'} · ${period.label}` });
  }
  for (const l of priced.lines) {
    if (l.amount < 0.01) continue;
    const over = l.included ? ` (${l.billable.toLocaleString('en-GB')} over the ${l.included.toLocaleString('en-GB')} included)` : '';
    await stripe.invoiceItems.create({ customer, currency, amount: Math.round(l.amount * 100), description: `${l.label} · ${l.quantity.toLocaleString('en-GB')} ${l.unit}${over} · ${period.label}` });
  }
  // A card saved at sign-up is charged on the 1st; otherwise the invoice is emailed with 14 days to pay
  const card = await defaultCard(stripe, customer);
  const invoice = await stripe.invoices.create({
    customer, pending_invoice_items_behavior: 'include',
    ...(card ? { collection_method: 'charge_automatically', default_payment_method: card, auto_advance: true } : { collection_method: 'send_invoice', days_until_due: 14 }),
    description: `local / assets · ${plan ? plan.name + ' · ' : ''}${period.label}`, metadata: { venueSlug: slug, target, period: period.key },
  });
  let sent = await stripe.invoices.finalizeInvoice(invoice.id);
  if (card) {
    // A declined card leaves the invoice open: Stripe retries it and emails the customer a link to pay
    sent = await stripe.invoices.pay(sent.id).catch(e => { console.error('[billing] card charge failed', slug, sent.id, e.message); return sent; });
  } else {
    await stripe.invoices.sendInvoice(sent.id).catch(() => {});
  }
  await redis.set(doneKey, sent.id);
  return { invoice: sent.id, total: priced.total, url: sent.hosted_invoice_url || null, livemode: !!sent.livemode, charged: card ? sent.status === 'paid' : undefined };
}
