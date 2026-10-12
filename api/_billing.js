import Stripe from 'stripe';
import { list } from '@vercel/blob';
import { getVenuesConfig, getMuxAuthForVenue } from './_venues.js';

// Usage-based billing: each venue's real usage of the services it runs on (Mux video, Vercel Blob
// files), priced at cost plus the local / assets margin, invoiced monthly through Stripe.

// Costs in GBP. Saved over in Redis (billing_rates) from the Billing page.
export const DEFAULT_RATES = {
  videoStorage: 0.0024,    // per stored minute, per month
  videoDelivery: 0.0008,   // per minute streamed or downloaded
  videoEncoding: 0,        // per minute of new video (included)
  fileStorage: 0.018,      // per GB of files, per month
  margin: 0.2,             // added on top of cost
  currency: 'gbp',
};

export async function readRates(redis) {
  try { return { ...DEFAULT_RATES, ...JSON.parse(await redis.get('billing_rates') || '{}') }; }
  catch { return { ...DEFAULT_RATES }; }
}

// Plans: a monthly price with usage included; usage above it is billed as overage
export const DEFAULT_PLANS = [
  { id: 'starter-distribution', name: 'Distribution · Starter', price: 2750, included: { storedMinutes: 3000, deliveredMinutes: 25000, fileGB: 25 } },
  { id: 'liveset-distribution', name: 'Distribution · Pro', price: 3500, included: { storedMinutes: 6000, deliveredMinutes: 50000, fileGB: 50 } },
  { id: 'starter-creative', name: 'Creative & Production · Starter', price: 5500, included: { storedMinutes: 6000, deliveredMinutes: 50000, fileGB: 50 } },
  { id: 'liveset-creative', name: 'Creative & Production · Live-Set', price: 7500, included: { storedMinutes: 12000, deliveredMinutes: 100000, fileGB: 100 } },
];
export async function readPlans(redis) {
  try { const p = JSON.parse(await redis.get('billing_plans') || 'null'); return Array.isArray(p) && p.length ? p : DEFAULT_PLANS; }
  catch { return DEFAULT_PLANS; }
}
export function cleanPlans(list) {
  return (Array.isArray(list) ? list : []).slice(0, 30).map((p, i) => {
    const name = String(p?.name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60);
    const num = v => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : 0; };
    const id = String(p?.id || '').replace(/[^a-z0-9-]/g, '').slice(0, 40) || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `plan-${i + 1}`;
    return name ? { id, name, price: num(p.price), included: { storedMinutes: num(p.included?.storedMinutes), deliveredMinutes: num(p.included?.deliveredMinutes), fileGB: num(p.included?.fileGB) } } : null;
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

export async function venueUsage(slug, auth, { start, end }, artist = null, label = null) {
  const only = artist ? String(artist).toUpperCase().trim() : null;
  if (label) auth = null;   // a record label is billed for its brand kit files only
  const ids = new Set();
  const usage = { storedMinutes: 0, newMinutes: 0, deliveredMinutes: 0, fileBytes: 0, videos: 0, notes: [] };
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
  const sk = process.env.STRIPE_SECRET_KEY;
  return sk ? new Stripe(sk) : null;
}

// The venue's Stripe customer, made on first use
export async function venueCustomer(stripe, redis, slug, { email, name }) {
  const saved = await redis.get(`billing_customer:${slug}`);
  if (saved) { if (email) await stripe.customers.update(saved, { email, name: name || undefined }).catch(() => {}); return saved; }
  const c = await stripe.customers.create({ email: email || undefined, name: name || slug, metadata: { venueSlug: slug } });
  await redis.set(`billing_customer:${slug}`, c.id);
  return c.id;
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
  const customer = await venueCustomer(stripe, redis, target === 'venue' ? slug : `${slug}:${target}`, { email, name });
  const currency = priced.currency;
  if (priced.planAmount) {
    await stripe.invoiceItems.create({ customer, currency, amount: Math.round(priced.planAmount * 100), description: `${plan.name || 'Plan'} · ${period.label}` });
  }
  for (const l of priced.lines) {
    if (l.amount < 0.01) continue;
    const over = l.included ? ` (${l.billable.toLocaleString('en-GB')} over the ${l.included.toLocaleString('en-GB')} included)` : '';
    await stripe.invoiceItems.create({ customer, currency, amount: Math.round(l.amount * 100), description: `${l.label} · ${l.quantity.toLocaleString('en-GB')} ${l.unit}${over} · ${period.label}` });
  }
  const invoice = await stripe.invoices.create({
    customer, collection_method: 'send_invoice', days_until_due: 14, pending_invoice_items_behavior: 'include',
    description: `local / assets · ${plan ? plan.name + ' · ' : ''}${period.label}`, metadata: { venueSlug: slug, target, period: period.key },
  });
  const sent = await stripe.invoices.finalizeInvoice(invoice.id);
  await stripe.invoices.sendInvoice(sent.id).catch(() => {});
  await redis.set(doneKey, sent.id);
  return { invoice: sent.id, total: priced.total, url: sent.hosted_invoice_url || null, livemode: !!sent.livemode };
}
