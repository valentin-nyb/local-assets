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
  { id: 'starter-distribution', name: 'Distribution · Starter', price: 2750, maxClips: 6, cameras: 0,
    included: { storedMinutes: 3000, deliveredMinutes: 25000, fileGB: 250 },
    features: ['Content intake & quality control', 'Up to 8 events processed / month', '6 vertical social clips', 'Basic multi-platform distribution', '250 GB cloud storage'] },
  { id: 'liveset-distribution', name: 'Distribution · Pro', price: 3500, maxClips: 12, cameras: 0,
    included: { storedMinutes: 6000, deliveredMinutes: 50000, fileGB: 500 },
    features: ['Content intake & quality control', 'Up to 8 events processed / month', '12+ vertical social clips', 'Marketing thumbnails', 'Multi-platform distribution', 'YouTube & SoundCloud SEO', 'Priority 48-hour turnaround', '500 GB cloud storage'] },
  { id: 'starter-creative', name: 'Creative & Production · Starter', price: 5500, maxClips: 12, cameras: 1,
    included: { storedMinutes: 12000, deliveredMinutes: 100000, fileGB: 2000 },
    features: ['1 camera included', 'Starlink Mini: the camera streams straight to the app, anywhere', 'Up to 4 event nights / month', '4K master recordings', 'HQ audio capture', '12 vertical social clips', 'Marketing thumbnails', 'Basic distribution', '2 TB cloud storage'] },
  { id: 'liveset-creative', name: 'Creative & Production · Live-Set', price: 7500, maxClips: 0, cameras: 1,
    included: { storedMinutes: 60000, deliveredMinutes: 500000, fileGB: 20000 },
    features: ['1 camera included', 'Mac mini + Starlink private network included', 'Up to 8 event nights / month', '4K master recordings', 'HQ audio capture', 'Unlimited vertical social clips', 'Marketing thumbnails & watermark', 'Multi-platform distribution & SEO', 'Quarterly performance reports', 'Priority 48-hour turnaround', '20 TB cloud storage'] },
];
export async function readPlans(redis) {
  try { const p = JSON.parse(await redis.get('billing_plans') || 'null'); return Array.isArray(p) && p.length ? p.map(x => { const d = DEFAULT_PLANS.find(z => z.id === x.id) || {}; return { ...x, features: (x.features && x.features.length ? x.features : d.features), cameras: x.cameras || d.cameras || 0, maxClips: x.maxClips != null ? x.maxClips : (d.maxClips != null ? d.maxClips : 5) }; }) : DEFAULT_PLANS; }
  catch { return DEFAULT_PLANS; }
}
export function cleanPlans(list) {
  return (Array.isArray(list) ? list : []).slice(0, 30).map((p, i) => {
    const name = String(p?.name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60);
    const num = v => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : 0; };
    const id = String(p?.id || '').replace(/[^a-z0-9-]/g, '').slice(0, 40) || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `plan-${i + 1}`;
    return name ? { id, name, price: num(p.price), maxClips: Math.min(60, Math.max(0, Math.round(num(p.maxClips)))), cameras: Math.round(num(p.cameras)), features: Array.isArray(p.features) ? p.features.map(f => String(f).replace(/[<>]/g, '').slice(0, 80)).filter(Boolean).slice(0, 14) : undefined, included: { storedMinutes: num(p.included?.storedMinutes), deliveredMinutes: num(p.included?.deliveredMinutes), fileGB: num(p.included?.fileGB) } } : null;
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
  const invoice = await stripe.invoices.create({
    customer, collection_method: 'send_invoice', days_until_due: 14, pending_invoice_items_behavior: 'include',
    description: `local / assets · ${plan ? plan.name + ' · ' : ''}${period.label}`, metadata: { venueSlug: slug, target, period: period.key },
  });
  const sent = await stripe.invoices.finalizeInvoice(invoice.id);
  await stripe.invoices.sendInvoice(sent.id).catch(() => {});
  await redis.set(doneKey, sent.id);
  return { invoice: sent.id, total: priced.total, url: sent.hosted_invoice_url || null, livemode: !!sent.livemode };
}
