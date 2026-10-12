import { unpaidKey, readUnpaid } from './_suspend.js';
import { createClient } from 'redis';
import { getWebSessionAuth, getVenuesConfig } from './_venues.js';
import { venueAuth } from './_verticals.js';
import {
  readRates, readPlans, cleanPlans, readAssignments, assignKey, venueUsage, venueArtists, priceUsage,
  monthRange, stripeClient, invoiceVenue, venueEntries, DEFAULT_RATES,
} from './_billing.js';

// Billing page data and actions.
//   GET ?target=venue|artist:NAME&plan=ID&period=current|previous   usage, plan and price for one bill-to
//   GET ?cron=1                            (Vercel cron, the 1st) invoices last month for every monthly bill-to
//   POST { action: 'setRates', rates }                           admin
//   POST { action: 'setPlans', plans }                           admin
//   POST { action: 'assign', target, plan, email, name, monthly } admin: who pays which plan
//   POST { action: 'invoiceNow', target, plan, email, name, period } admin: send an invoice now

const admins = () => (process.env.BILLING_ADMINS || 'info@local-assets.com').split(/[\s,]+/).map(s => s.toLowerCase()).filter(Boolean);
const cleanTarget = t => (t === 'venue' || /^(artist|label):[^<>]{1,60}$/.test(String(t || ''))) ? String(t) : 'venue';
const STATUSES = ['paid', 'unpaid', 'waiting'];
const cleanText = (v, n) => String(v ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);

async function withRedis(fn) {
  const redis = createClient({ url: process.env.REDIS_URL });
  await redis.connect();
  try { return await fn(redis); } finally { await redis.quit().catch(() => {}); }
}
function previousMonth() { const d = new Date(); return monthRange(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 15))); }

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // Monthly run: every bill-to marked monthly, for last month
  if (req.method === 'GET' && req.query.cron) {
    const secret = process.env.CRON_SECRET;
    const ok = secret ? req.headers.authorization === `Bearer ${secret}` : /vercel-cron/i.test(req.headers['user-agent'] || '');
    if (!ok) return res.status(401).end();
    const stripe = stripeClient();
    if (!stripe) return res.status(503).json({ error: 'Stripe is not connected' });
    const period = previousMonth();
    const results = await withRedis(async redis => {
      const out = [];
      for (const v of venueEntries()) {
        const assigned = Object.entries(await readAssignments(redis, v.slug)).filter(([, a]) => a.monthly);
        for (const [target, a] of assigned) {
          try { out.push({ slug: v.slug, target, ...(await invoiceVenue(redis, stripe, { slug: v.slug, auth: v.auth, email: a.email, name: a.name || v.cfg.name || v.slug, target, planId: a.plan || null }, period)) }); }
          catch (e) { console.error('[billing] invoice', v.slug, target, e.message); out.push({ slug: v.slug, target, error: e.message }); }
        }
      }
      return out;
    });
    console.log('[billing] monthly', period.key, JSON.stringify(results));
    return res.status(200).json({ period: period.key, results });
  }

  const session = getWebSessionAuth(req);
  if (!session?.email) return res.status(401).json({ error: 'Not authenticated' });
  if (!session.venueSlug) return res.status(403).json({ error: 'No venue for this account' });

  // Lightweight check for the banner on every page (the signed-in venue)
  if (req.method === 'GET' && req.query.status) {
    try {
      const unpaid = await withRedis(redis => readUnpaid(redis, session.venueSlug));
      const venue = unpaid.find(i => i.target === 'venue');
      return res.status(200).json({ paused: !!venue, payUrl: venue?.url || null, number: venue?.number || null, others: unpaid.filter(i => i.target !== 'venue').map(i => ({ target: i.target, number: i.number, url: i.url })) });
    } catch (e) { return res.status(200).json({ paused: false }); }
  }

  // Billing admin = a local / assets admin signed in to the local / assets venue. They pick the venue to bill;
  // everyone else only sees their own venue.
  const ADMIN_VENUE = process.env.BILLING_ADMIN_VENUE || 'local-assets-admin';
  const isAdmin = admins().includes(session.email) && session.venueSlug === ADMIN_VENUE;
  const cfg = getVenuesConfig();
  const billable = Object.keys(cfg).filter(k => k !== ADMIN_VENUE);
  let slug = session.venueSlug, auth = session.muxAuth, venueName = session.venue?.name || session.venueSlug;
  if (isAdmin) {
    let bodyVenue = '';
    try { bodyVenue = (typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {})).venue || ''; } catch {}
    const want = String(req.query.venue || bodyVenue || '');
    slug = billable.includes(want) ? want : (billable[0] || slug);
    auth = venueAuth(slug);
    venueName = cfg[slug]?.name || slug;
  }

  try {
    if (req.method === 'GET') {
      const target = isAdmin ? cleanTarget(req.query.target) : 'venue';
      const base = req.query.period === 'previous' ? previousMonth() : monthRange();
      const artist = target.startsWith('artist:') ? target.slice(7) : null;
      const label = target.startsWith('label:') ? target.slice(6) : null;
      const data = await withRedis(async redis => {
        const [rates, plans, assignments, customer] = await Promise.all([
          readRates(redis), readPlans(redis), readAssignments(redis, slug),
          redis.get(`billing_customer:${target === 'venue' ? slug : `${slug}:${target}`}`),
        ]);
        const usage = await venueUsage(slug, auth, base, artist, label);
        const artists = isAdmin ? await venueArtists(auth).catch(() => []) : [];
        // Record labels from the Brand Kit
        const names = isAdmin ? await redis.hGetAll(`brand_owner_names:${slug}`) : {};
        const labels = Object.entries(names || {}).filter(([k]) => k.startsWith('label-')).map(([, v]) => v).sort();
        const statuses = await redis.hGetAll(`billing_status:${slug}`);
        return { rates, plans, assignments, customer, usage, artists, labels, statuses };
      });
      const a = data.assignments[target] || {};
      const planId = req.query.plan !== undefined && isAdmin ? String(req.query.plan) : (a.plan || '');
      const plan = data.plans.find(p => p.id === planId) || null;
      const priced = priceUsage(data.usage, data.rates, plan);
      let invoices = [];
      const stripe = stripeClient();
      if (stripe) {
        // Admin: every invoice of this venue (venue, artists, labels); a venue: its own
        let list = [];
        if (isAdmin) list = (await stripe.invoices.search({ query: `metadata['venueSlug']:'${slug.replace(/'/g, '')}'`, limit: 50 }).catch(() => ({ data: [] }))).data;
        else if (data.customer) list = (await stripe.invoices.list({ customer: data.customer, limit: 24 })).data;
        invoices = list.sort((x, y) => y.created - x.created).map(i => {
          const t = i.metadata?.target || 'venue';
          const own = data.statuses?.[i.id];
          const fromStripe = i.status === 'paid' ? 'paid' : i.status === 'uncollectible' || i.status === 'void' ? 'unpaid' : 'waiting';
          return {
            id: i.id, number: i.number, status: own || fromStripe, total: i.total / 100, currency: i.currency,
            created: i.created * 1000, url: i.hosted_invoice_url, pdf: i.invoice_pdf,
            billedTo: i.customer_name || (t === 'venue' ? venueName : t.replace(/^(artist|label):/, '')),
            kind: t === 'venue' ? 'Venue' : t.startsWith('label:') ? 'Record label' : 'Artist',
          };
        });
      }
      const elapsed = Math.min(1, Math.max(0, (Date.now() - base.start) / (base.end - base.start)));
      return res.status(200).json({
        venue: venueName, target, period: { label: base.label, start: base.start, end: base.end, elapsed },
        usage: data.usage, ...priced, invoices, stripe: !!stripe, isAdmin,
        ...(isAdmin ? { venueSlug: slug, venues: billable.map(k => ({ slug: k, name: cfg[k]?.name || k })), rates: data.rates, plans: data.plans, assignments: data.assignments, artists: data.artists, labels: data.labels, assignment: a } : {}),
      });
    }

    if (req.method !== 'POST') return res.status(405).end();
    if (!isAdmin) return res.status(403).json({ error: 'Only local / assets can change billing' });
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});

    if (body.action === 'setRates') {
      const r = body.rates || {};
      const clean = {};
      for (const k of ['videoStorage', 'videoDelivery', 'videoEncoding', 'fileStorage', 'margin']) {
        const n = Number(r[k]);
        if (Number.isFinite(n) && n >= 0 && n < 1000) clean[k] = n;
      }
      await withRedis(redis => redis.set('billing_rates', JSON.stringify({ ...DEFAULT_RATES, ...clean })));
      return res.status(200).json({ ok: true });
    }

    if (body.action === 'setPlans') {
      const plans = cleanPlans(body.plans);
      if (!plans.length) return res.status(400).json({ error: 'Add at least one plan' });
      await withRedis(redis => redis.set('billing_plans', JSON.stringify(plans)));
      return res.status(200).json({ plans });
    }

    if (body.action === 'assign') {
      const target = cleanTarget(body.target);
      const rec = { plan: cleanText(body.plan, 40), email: cleanText(body.email, 120), name: cleanText(body.name, 80), monthly: !!body.monthly };
      if (rec.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rec.email)) return res.status(400).json({ error: 'Enter a valid email' });
      await withRedis(redis => redis.hSet(assignKey(slug), target, JSON.stringify(rec)));
      return res.status(200).json({ ok: true });
    }

    if (body.action === 'setStatus') {
      const id = String(body.invoice || '');
      const status = STATUSES.includes(body.status) ? body.status : null;
      if (!/^in_[A-Za-z0-9]+$/.test(id) || !status) return res.status(400).json({ error: 'Unknown invoice or status' });
      const stripe = stripeClient();
      const inv = stripe ? await stripe.invoices.retrieve(id).catch(() => null) : null;
      if (!inv || inv.metadata?.venueSlug !== slug) return res.status(404).json({ error: 'Invoice not found' });
      // Stripe follows where it can: paid outside Stripe, or written off; it can't reopen a paid invoice
      if (status === 'paid' && inv.status === 'open') await stripe.invoices.pay(id, { paid_out_of_band: true }).catch(() => {});
      if (status === 'unpaid' && inv.status === 'open') await stripe.invoices.markUncollectible(id).catch(() => {});
      await withRedis(async redis => {
        await redis.hSet(`billing_status:${slug}`, id, status);
        // Not paid pauses the account it was for; paid or waiting lifts that
        if (status === 'unpaid') await redis.hSet(unpaidKey(slug), id, JSON.stringify({ target: inv.metadata?.target || 'venue', number: inv.number || '', url: inv.hosted_invoice_url || '' }));
        else await redis.hDel(unpaidKey(slug), id);
      });
      return res.status(200).json({ ok: true, status });
    }

    if (body.action === 'invoiceNow') {
      const stripe = stripeClient();
      if (!stripe) return res.status(503).json({ error: 'Stripe is not connected' });
      const target = cleanTarget(body.target);
      const email = cleanText(body.email, 120);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter the email the invoice goes to' });
      const base = body.period === 'previous' ? previousMonth() : monthRange();
      // A manual invoice never blocks the monthly one
      const period = { ...base, key: `${base.key}-manual-${Date.now()}` };
      const name = cleanText(body.name, 80) || (target === 'venue' ? (venueName) : target.replace(/^(artist|label):/, ''));
      const out = await withRedis(redis => invoiceVenue(redis, stripe, { slug, auth: auth, email, name, target, planId: cleanText(body.plan, 40) || null }, period));
      return res.status(200).json(out);
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    console.error('[billing]', slug, e.message);
    return res.status(500).json({ error: e.message });
  }
}
