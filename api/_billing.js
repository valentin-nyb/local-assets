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

export async function readPlan(redis, slug) {
  try { return JSON.parse(await redis.get(`billing_plan:${slug}`) || 'null'); } catch { return null; }
}

const muxGet = (auth, path) => fetch('https://api.mux.com' + path, { headers: { Authorization: auth }, signal: AbortSignal.timeout(20000) })
  .then(async r => { const b = await r.json().catch(() => ({})); if (!r.ok) throw new Error(b?.error?.messages?.[0] || `Mux ${r.status}`); return b; });

export function monthRange(d = new Date()) {
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return { start, end, label: new Date(start).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }), key: new Date(start).toISOString().slice(0, 7) };
}

// Usage for one venue in [start, end): video minutes stored, streamed and added, and GB of files
export async function venueUsage(slug, auth, { start, end }) {
  const usage = { storedMinutes: 0, newMinutes: 0, deliveredMinutes: 0, fileBytes: 0, videos: 0, notes: [] };
  if (auth) {
    for (let page = 1; page <= 30; page++) {
      const b = await muxGet(auth, `/video/v1/assets?limit=100&page=${page}`);
      for (const a of b.data || []) {
        if (a.status !== 'ready') continue;
        const min = (Number(a.duration) || 0) / 60;
        usage.storedMinutes += min; usage.videos++;
        const created = Number(a.created_at) * 1000;
        if (created >= start && created < end) usage.newMinutes += min;
      }
      if ((b.data || []).length < 100) break;
    }
    // Streaming: Mux delivery usage for the period (up to the last full hour)
    const to = Math.min(end, Math.floor(Date.now() / 3600e3) * 3600e3);
    if (to > start) {
      try {
        for (let page = 1; page <= 30; page++) {
          const b = await muxGet(auth, `/video/v1/delivery-usage?limit=100&page=${page}&timeframe[]=${Math.floor(start / 1000)}&timeframe[]=${Math.floor(to / 1000)}`);
          for (const r of b.data || []) usage.deliveredMinutes += (Number(r.delivered_seconds) || 0) / 60;
          if ((b.data || []).length < 100) break;
        }
      } catch (e) { usage.notes.push('Streaming figures unavailable: ' + e.message); }
    }
  }
  // Files: Brand Kit, thumbnails and watermark images
  for (const prefix of [`brand/${slug}/`, `thumbnails/${slug}/`, `watermarks/${slug}/`]) {
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
export function priceUsage(usage, rates, plan) {
  const m = 1 + (Number(rates.margin) || 0);
  const gb = usage.fileBytes / 1e9;
  const lines = [
    { key: 'videoStorage', label: 'Video storage', quantity: usage.storedMinutes, unit: 'minutes stored', rate: rates.videoStorage },
    { key: 'videoDelivery', label: 'Streaming and downloads', quantity: usage.deliveredMinutes, unit: 'minutes delivered', rate: rates.videoDelivery },
    { key: 'videoEncoding', label: 'New video processing', quantity: usage.newMinutes, unit: 'minutes added', rate: rates.videoEncoding },
    { key: 'fileStorage', label: 'File storage', quantity: gb, unit: 'GB', rate: rates.fileStorage },
  ].map(l => ({ ...l, quantity: round2(l.quantity), cost: round2(l.quantity * l.rate), amount: round2(l.quantity * l.rate * m) }));
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
  if (saved) return saved;
  const c = await stripe.customers.create({ email: email || undefined, name: name || slug, metadata: { venueSlug: slug } });
  await redis.set(`billing_customer:${slug}`, c.id);
  return c.id;
}

export function venueEntries() {
  return Object.entries(getVenuesConfig()).map(([slug, cfg]) => ({ slug, cfg, auth: getMuxAuthForVenue({ slug, ...cfg }) }));
}

// Creates and sends the invoice for one venue and one month (once)
export async function invoiceVenue(redis, stripe, { slug, auth, email, name }, period) {
  const doneKey = `billing_invoiced:${slug}:${period.key}`;
  const existing = await redis.get(doneKey);
  if (existing) return { skipped: true, invoice: existing };
  const rates = await readRates(redis);
  const plan = await readPlan(redis, slug);
  const usage = await venueUsage(slug, auth, period);
  const priced = priceUsage(usage, rates, plan);
  if (priced.total < 0.3) { await redis.set(doneKey, 'none'); return { skipped: true, reason: 'Nothing to bill' }; }
  const customer = await venueCustomer(stripe, redis, slug, { email, name });
  const currency = priced.currency;
  if (priced.planAmount) {
    await stripe.invoiceItems.create({ customer, currency, amount: Math.round(priced.planAmount * 100), description: `${plan.name || 'Plan'} · ${period.label}` });
  }
  for (const l of priced.lines) {
    if (l.amount < 0.01) continue;
    await stripe.invoiceItems.create({ customer, currency, amount: Math.round(l.amount * 100), description: `${l.label} · ${l.quantity.toLocaleString('en-GB')} ${l.unit} · ${period.label}` });
  }
  const invoice = await stripe.invoices.create({
    customer, collection_method: 'send_invoice', days_until_due: 14, pending_invoice_items_behavior: 'include',
    description: `local / assets usage · ${period.label}`, metadata: { venueSlug: slug, period: period.key },
  });
  const sent = await stripe.invoices.finalizeInvoice(invoice.id);
  await stripe.invoices.sendInvoice(sent.id).catch(() => {});
  await redis.set(doneKey, sent.id);
  return { invoice: sent.id, total: priced.total };
}
