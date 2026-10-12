import { createClient } from 'redis';
import { getWebSessionAuth } from './_venues.js';
import { readRates, readPlan, venueUsage, priceUsage, monthRange, stripeClient, invoiceVenue, venueEntries, DEFAULT_RATES } from './_billing.js';

// Billing page data and actions.
//   GET                       this month's usage and estimate for the signed-in venue, plus past invoices
//   GET ?cron=1               (Vercel cron, 1st of the month) invoices every venue for last month
//   POST { action: 'setRates', rates }            admin: costs and margin
//   POST { action: 'setPlan', name, price }        admin: this venue's monthly plan
//   POST { action: 'invoiceNow', period }          admin: send this venue's invoice now ('current' | 'previous')

const admins = () => (process.env.BILLING_ADMINS || 'info@local-assets.com').split(/[\s,]+/).map(s => s.toLowerCase()).filter(Boolean);

async function withRedis(fn) {
  const redis = createClient({ url: process.env.REDIS_URL });
  await redis.connect();
  try { return await fn(redis); } finally { await redis.quit().catch(() => {}); }
}

function previousMonth() { const d = new Date(); return monthRange(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 15))); }

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // Monthly run
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
        const email = (Array.isArray(v.cfg.emails) ? v.cfg.emails[0] : String(v.cfg.emails || '').split(/[\s,;]+/)[0]) || '';
        try { out.push({ slug: v.slug, ...(await invoiceVenue(redis, stripe, { slug: v.slug, auth: v.auth, email, name: v.cfg.name || v.slug }, period)) }); }
        catch (e) { console.error('[billing] invoice', v.slug, e.message); out.push({ slug: v.slug, error: e.message }); }
      }
      return out;
    });
    console.log('[billing] monthly', period.key, JSON.stringify(results));
    return res.status(200).json({ period: period.key, results });
  }

  const session = getWebSessionAuth(req);
  if (!session?.email) return res.status(401).json({ error: 'Not authenticated' });
  const slug = session.venueSlug;
  if (!slug) return res.status(403).json({ error: 'No venue for this account' });
  const isAdmin = admins().includes(session.email);

  try {
    if (req.method === 'GET') {
      const period = monthRange();
      const data = await withRedis(async redis => {
        const [rates, plan, customer] = await Promise.all([readRates(redis), readPlan(redis, slug), redis.get(`billing_customer:${slug}`)]);
        const usage = await venueUsage(slug, session.muxAuth, period);
        return { rates, plan, customer, usage };
      });
      const priced = priceUsage(data.usage, data.rates, data.plan);
      let invoices = [];
      const stripe = stripeClient();
      if (stripe && data.customer) {
        const list = await stripe.invoices.list({ customer: data.customer, limit: 24 });
        invoices = list.data.map(i => ({
          id: i.id, number: i.number, status: i.status, total: i.total / 100, currency: i.currency,
          created: i.created * 1000, due: i.due_date ? i.due_date * 1000 : null, period: i.metadata?.period || null,
          url: i.hosted_invoice_url, pdf: i.invoice_pdf,
        }));
      }
      const elapsed = Math.min(1, (Date.now() - period.start) / (period.end - period.start));
      return res.status(200).json({
        venue: session.venue?.name || slug, period: { label: period.label, start: period.start, end: period.end, elapsed },
        usage: data.usage, ...priced, rates: isAdmin ? data.rates : undefined,
        invoices, stripe: !!stripe, isAdmin,
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

    if (body.action === 'setPlan') {
      const name = String(body.name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60);
      const price = Number(body.price);
      if (!name || !Number.isFinite(price) || price < 0) return res.status(400).json({ error: 'Enter the plan name and monthly price' });
      await withRedis(redis => redis.set(`billing_plan:${slug}`, JSON.stringify({ name, price })));
      return res.status(200).json({ ok: true });
    }

    if (body.action === 'invoiceNow') {
      const stripe = stripeClient();
      if (!stripe) return res.status(503).json({ error: 'Stripe is not connected' });
      const base = body.period === 'previous' ? previousMonth() : monthRange();
      // A manual invoice never blocks the monthly one
      const period = { ...base, key: `${base.key}-manual-${Date.now()}` };
      const out = await withRedis(redis => invoiceVenue(redis, stripe, { slug, auth: session.muxAuth, email: session.email, name: session.venue?.name || slug }, period));
      return res.status(200).json(out);
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    console.error('[billing]', slug, e.message);
    return res.status(500).json({ error: e.message });
  }
}
