import { listPool, addToPool, removeFromPool, activateFromPool, poolSize } from './_mux-pool.js';
import { unpaidKey, readUnpaid } from './_suspend.js';
import { createClient } from 'redis';
import { getWebSessionAuth, getVenuesConfig, readRegistryRaw, saveRegistryEntry, sealSecret, freshVenues, isAdminVenue } from './_venues.js';
import { venueAuth } from './_verticals.js';
import {
  readRates, readPlans, cleanPlans, readAssignments, assignKey, venueUsage, venueArtists, priceUsage,
  monthRange, stripeClient, invoiceVenue, venueEntries, DEFAULT_RATES, applyDetails, usageByDay, planForType, priceForType, commitEndFor, readKit, cleanKit, KIT_PLANS, accountTypeOf, sendInvoiceEmail, billingEmailFor } from './_billing.js';

// Billing page data and actions.
//   GET ?target=venue|artist:NAME&plan=ID&period=current|previous   usage, plan and price for one bill-to
//   GET ?cron=1                            (Vercel cron, the 1st) invoices last month for every monthly bill-to
//   POST { action: 'setRates', rates }                           admin
//   POST { action: 'setPlans', plans }                           admin
//   POST { action: 'setKit', kit }                               admin: kit expenses for Pro and Live-Set
//   POST { action: 'repriceSubscriptions', apply }               admin: subscriptions to their plan's current price
//   POST { action: 'assign', target, plan, email, name, monthly } admin: who pays which plan
//   POST { action: 'invoiceNow', target, plan, email, name, period } admin: send an invoice now

const admins = () => (process.env.BILLING_ADMINS || 'info@local-assets.com').split(/[\s,]+/).map(s => s.toLowerCase()).filter(Boolean);
// Who is billed: the account itself ("venue"), or one of its artists, record labels, venues or managements by name
const cleanTarget = t => (t === 'venue' || /^(artist|label|venue|management):[^<>]{1,60}$/.test(String(t || ''))) ? String(t).replace(/^(\w+):\s*/, '$1:').trim() : 'venue';
const STATUSES = ['paid', 'unpaid', 'waiting'];
const TYPE_LABEL = { venue: 'Venue', artist: 'Artist', label: 'Record label', management: 'Management' };
const cleanText = (v, n) => String(v ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
// Who the invoice is legally addressed to: name or company, postal address, VAT number
const cleanDetails = d => {
  d = d && typeof d === 'object' ? d : {};
  const out = { legalName: cleanText(d.legalName, 100), line1: cleanText(d.line1, 100), line2: cleanText(d.line2, 100), city: cleanText(d.city, 60),
    postcode: cleanText(d.postcode, 20).toUpperCase(), country: /^[A-Z]{2}$/.test(String(d.country || '').toUpperCase()) ? String(d.country).toUpperCase() : 'GB', vat: cleanText(d.vat, 30).toUpperCase().replace(/\s+/g, '') };
  return out;
};

async function withRedis(fn) {
  const redis = createClient({ url: process.env.REDIS_URL });
  await redis.connect();
  try { return await fn(redis); } finally { await redis.quit().catch(() => {}); }
}
function previousMonth() { const d = new Date(); return monthRange(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 15))); }

export default async function handler(req, res) {
  await freshVenues();
  res.setHeader('Cache-Control', 'no-store');

  // Monthly run, on the 1st: every client account is invoiced for last month (and any artist or label in it
  // marked to be billed monthly), emailed to the address in Bill to or the account's sign-in email
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
        if (isAdminVenue({ slug: v.slug, ...v.cfg })) continue;   // local / assets itself is never billed
        const all = await readAssignments(redis, v.slug);
        const assigned = Object.entries(all).filter(([target, a]) => target === 'venue' || a.monthly);
        if (!all.venue) assigned.unshift(['venue', {}]);
        for (const [target, a] of assigned) {
          try { out.push({ slug: v.slug, target, ...(await invoiceVenue(redis, stripe, { slug: v.slug, auth: v.auth, email: billingEmailFor(v.slug, target === 'venue' ? a : { email: a.email }), name: a.name || v.cfg.name || v.slug, target, planId: a.plan || null }, period)) }); }
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
      const setupPending = getVenuesConfig()[session.venueSlug]?.status === 'pending';
      return res.status(200).json({ setupPending, paused: !!venue, byAdmin: !!venue?.admin, payUrl: venue?.url || null, number: venue?.number || null, others: unpaid.filter(i => i.target !== 'venue').map(i => ({ target: i.target, number: i.number, url: i.url })) });
    } catch (e) { return res.status(200).json({ paused: false }); }
  }

  // Billing admin = a local / assets admin signed in to the local / assets venue. They pick the venue to bill;
  // everyone else only sees their own venue.
  const ADMIN_VENUE = process.env.BILLING_ADMIN_VENUE || 'local-assets-admin';
  // The local / assets venue: its configured slug, or the venue named "local / assets"
  const isAdminVenue = session.venueSlug === ADMIN_VENUE || /^local\s*[\/-]?\s*assets\b/i.test(String(session.venue?.name || '').trim());
  const isAdmin = admins().includes(session.email) && isAdminVenue;
  if (admins().includes(session.email)) console.log('[billing] venue', session.venueSlug, JSON.stringify(session.venue?.name || ''), 'admin view:', isAdmin, '| venues:', Object.keys(getVenuesConfig()).join(','));
  const cfg = getVenuesConfig();
    // local / assets is the admin account, not a venue: only real venues are billed
  const isAdminEntry = k => k === ADMIN_VENUE || k === session.venueSlug && isAdminVenue || /^local\s*[\/-]?\s*assets\b/i.test(String(cfg[k]?.name || '').trim());
  const billable = Object.keys(cfg).filter(k => !isAdminEntry(k));
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
    // Admin: one invoice's PDF, passed through so the page can zip every invoice together
    if (req.method === 'GET' && req.query.invoicePdf) {
      if (!isAdmin) return res.status(403).json({ error: 'Admin only' });
      const stripe = stripeClient();
      const id = String(req.query.invoicePdf);
      if (!stripe || !/^in_[A-Za-z0-9]+$/.test(id)) return res.status(400).json({ error: 'Unknown invoice' });
      const inv = await stripe.invoices.retrieve(id).catch(() => null);
      if (!inv?.metadata?.venueSlug || !inv.invoice_pdf) return res.status(404).json({ error: 'No PDF for this invoice' });
      const r = await fetch(inv.invoice_pdf, { signal: AbortSignal.timeout(25000) });
      if (!r.ok) return res.status(502).json({ error: 'Stripe PDF ' + r.status });
      res.setHeader('Content-Type', 'application/pdf');
      return res.status(200).send(Buffer.from(await r.arrayBuffer()));
    }
    // Admin: every account at once, this month so far: what its video and files cost us (all their Cloud
    // Storage environments, and the local / assets one) and what it is billed. Kept 10 minutes (?fresh=1 to redo).
    if (req.method === 'GET' && req.query.overview) {
      if (!isAdmin) return res.status(403).json({ error: 'Admin only' });
      const period = monthRange();
      const out = await withRedis(async redis => {
        const cacheKey = `billing_overview:${period.key}`;
        if (!req.query.fresh) { const c = await redis.get(cacheKey).catch(() => null); if (c) return JSON.parse(c); }
        const [rates, plans] = await Promise.all([readRates(redis), readPlans(redis)]);
        const seenEnv = new Set(), rows = [];
        const entries = venueEntries();
        for (const { slug: s, cfg: c, auth: a } of entries) {
          const own = isAdminEntry(s);
          const type = own ? 'admin' : await accountTypeOf(redis, s);
          // Accounts sharing one environment: its video is counted once (on the first), files for each
          const shared = !!(a && seenEnv.has(a));
          if (a) seenEnv.add(a);
          let usage;
          try { usage = await venueUsage(s, shared ? null : a, period); }
          catch (e) { rows.push({ slug: s, name: c?.name || s, type, error: e.message }); continue; }
          const gb = usage.fileBytes / 1e9;
          const cost = usage.storedMinutes * rates.videoStorage + (usage.deliveredMinutes - (usage.delivered4KMinutes || 0)) * rates.videoDelivery + (usage.delivered4KMinutes || 0) * (Number(rates.videoDelivery4K) || 0) + usage.newMinutes * rates.videoEncoding
            + (usage.liveMinutes || 0) * (Number(rates.liveRecording) || 0) + gb * rates.fileStorage;
          const asg = (await readAssignments(redis, s)).venue || {};
          const plan = own ? null : planForType(plans.find(p => p.id === asg.plan) || null, type);
          const billed = own ? 0 : priceUsage(usage, rates, plan).total;
          rows.push({ slug: s, name: c?.name || s, type, plan: plan?.name || (own ? 'local / assets' : 'No plan'), shared, notes: usage.notes,
            storedHours: usage.storedMinutes / 60, streamedHours: usage.deliveredMinutes / 60, newHours: usage.newMinutes / 60, recordedHours: (usage.liveMinutes || 0) / 60, fileGB: gb,
            cost: Math.round(cost * 100) / 100, billed: Math.round(billed * 100) / 100 });
        }
        rows.sort((x, y) => y.cost - x.cost);
        const sum = k => Math.round(rows.reduce((t, r) => t + (r[k] || 0), 0) * 100) / 100;
        const result = { period: period.label, at: Date.now(), rows, totals: { cost: sum('cost'), billed: sum('billed'), storedHours: sum('storedHours'), streamedHours: sum('streamedHours'), recordedHours: sum('recordedHours'), fileGB: sum('fileGB') }, currency: rates.currency || 'gbp' };
        await redis.set(cacheKey, JSON.stringify(result), { EX: 600 }).catch(() => {});
        return result;
      });
      return res.status(200).json(out);
    }

    // The usage chart: day-by-day usage over a range, with the billing cycles (calendar months) it covers
    if (req.method === 'GET' && req.query.usageDays) {
      const target = isAdmin ? cleanTarget(req.query.target) : 'venue';
      const artist = target.startsWith('artist:') ? target.slice(7) : null;
      const label = target.startsWith('label:') ? target.slice(6) : null;
      const now = new Date(), today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      const range = String(req.query.range || 'cycle');
      const m = /^(\d+)d$/.exec(range), inv = /^inv([1-3])$/.exec(range);
      const from = m ? today - (Math.min(120, Number(m[1])) - 1) * 86400e3
        : Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (inv ? Number(inv[1]) : 0), 1);
      const to = today + 86400e3;
      // One account's day-by-day usage, priced with its own plan (by its type)
      const accountDays = async (redis, rates, plans, aSlug, aAuth, aTarget, planOverride) => {
        const assignments = await readAssignments(redis, aSlug);
        const planId = planOverride !== undefined ? planOverride : (assignments[aTarget]?.plan || '');
        const type = aTarget.startsWith('artist:') ? 'artist' : aTarget.startsWith('label:') ? 'label' : await accountTypeOf(redis, aSlug);
        const plan = planForType(plans.find(p => p.id === planId) || null, type);
        // From the start of the first cycle, so a range starting mid-cycle carries that cycle's running total
        const fd = new Date(from), cycleFrom = Date.UTC(fd.getUTCFullYear(), fd.getUTCMonth(), 1);
        const u = await usageByDay(redis, aSlug, aAuth, { from: cycleFrom, to }, aTarget.startsWith('artist:') ? aTarget.slice(7) : null, aTarget.startsWith('label:') ? aTarget.slice(6) : null);
        return pointsFor({ rates, plan, ...u });
      };
      // Each day's point is what the invoice would say if the cycle ended that day: the same quantities
      // (minutes stored, minutes streamed this cycle, minutes added this cycle, file storage) priced by the
      // same priceUsage, plan allowance included, so today's point equals "Usage so far" exactly
      const pointsFor = out => {
        const DAY = 86400e3, nowMs = Date.now();
        let cyc = -1, streamed = 0;
        return { plan: out.plan, notes: out.notes, points: out.days.map(d => {
          const dt = new Date(d.start), c = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), 1);
          if (c !== cyc) { cyc = c; streamed = 0; }
          streamed += d.delivered;
          const end = Math.min(d.start + DAY, nowMs);
          const usage = {
            storedMinutes: out.vids.reduce((s, v) => s + (v.at < end ? v.min : 0), 0),
            newMinutes: out.vids.reduce((s, v) => s + (v.at >= c && v.at < end ? v.min : 0), 0),
            deliveredMinutes: streamed,
            fileBytes: out.files.reduce((s, f) => s + (f.at < end ? f.bytes : 0), 0),
            videos: 0, notes: [],
          };
          const p = priceUsage(usage, out.rates, out.plan);
          // That day on its own too (for the daily bars): minutes streamed, minutes of video added; and video stored by its end
          const added = out.vids.reduce((s, v) => s + (v.at >= d.start && v.at < end ? v.min : 0), 0);
          return { t: d.start, end, cycle: c, amount: p.usageTotal, mins: Math.round(streamed * 100) / 100,
            daily: Math.round(d.delivered * 100) / 100, stored: Math.round(usage.storedMinutes), added: Math.round(added),
            lines: p.lines.map(l => ({ label: l.label, quantity: l.quantity, unit: l.unit, amount: l.amount })) };
        }) };
      };
      const rates = await withRedis(readRates);
      let result;
      if (isAdmin && req.query.venue === 'all') {
        // Admin: every client account added up, day by day (each at its own plan)
        const per = await withRedis(async redis => {
          const plans = await readPlans(redis), out = [];
          for (const s0 of billable) { try { out.push(await accountDays(redis, rates, plans, s0, venueAuth(s0), 'venue')); } catch (e) { console.error('[billing] usage days', s0, e.message); } }
          return out;
        });
        const base = per.find(x => x.points.length) || { points: [] };
        const points = base.points.map((pt, k) => {
          const all = per.map(x => x.points[k]).filter(Boolean);
          const sum = f => Math.round(all.reduce((t, x) => t + (x[f] || 0), 0) * 100) / 100;
          const lines = {};
          all.forEach(x => x.lines.forEach(l => { const o = lines[l.label] || (lines[l.label] = { label: l.label, quantity: 0, unit: l.unit, amount: 0 }); o.quantity += l.quantity; o.amount += l.amount; }));
          return { t: pt.t, end: pt.end, cycle: pt.cycle, amount: sum('amount'), mins: sum('mins'), daily: sum('daily'), stored: sum('stored'), added: sum('added'),
            lines: Object.values(lines).map(l => ({ ...l, quantity: Math.round(l.quantity * 100) / 100, amount: Math.round(l.amount * 100) / 100 })) };
        });
        result = { plan: 'All accounts', points, notes: per.flatMap(x => x.notes || []) };
      } else {
        const one = await withRedis(async redis => accountDays(redis, rates, await readPlans(redis), slug, auth, target, req.query.plan !== undefined && isAdmin ? String(req.query.plan) : undefined));
        result = { plan: one.plan ? one.plan.name : null, points: one.points, notes: one.notes };
      }
      const cycles = [];
      for (let y = new Date(from).getUTCFullYear(), mo = new Date(from).getUTCMonth(); Date.UTC(y, mo, 1) < to; mo++) cycles.push(Date.UTC(y, mo, 1));
      return res.status(200).json({ range, from, to, today, cycles, currency: rates.currency || 'gbp',
        plan: result.plan, points: result.points, notes: result.notes });
    }
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
        let artists = isAdmin ? await venueArtists(auth).catch(() => []) : [];
        // Record labels from the Brand Kit
        const names = isAdmin ? await redis.hGetAll(`brand_owner_names:${slug}`) : {};
        const labels = Object.entries(names || {}).filter(([k]) => k.startsWith('label-')).map(([, v]) => v).sort();
        // Venues from the Brand Kit (where the artist plays)
        const bkVenues = Object.entries(names || {}).filter(([k]) => k.startsWith('venue-')).map(([, v]) => v).filter(Boolean).sort();
        // Artists from the Brand Kit too, not only those with sessions
        for (const [k, v] of Object.entries(names || {})) if (k.startsWith('artist-') && v) artists.push(String(v).toUpperCase().trim());
        const statuses = await redis.hGetAll(`billing_status:${slug}`);
        // The account's own type from its Brand Kit (venue, artist, record label or management)
        const accountType = (await redis.get(`brand_org_type:${slug}`)) || (await redis.get(`account_type:${slug}`)) || getVenuesConfig()[slug]?.type || (/team$/i.test(String(getVenuesConfig()[slug]?.name || '')) ? 'management' : 'venue');
        return { rates, plans, assignments, customer, usage, artists: [...new Set(artists)].sort(), labels, bkVenues, statuses, accountType };
      });
      const a = data.assignments[target] || {};
      const planId = req.query.plan !== undefined && isAdmin ? String(req.query.plan) : (a.plan || '');
      // The plan at this account's price (venue, record label or artist: see TYPE_FACTOR)
      const billedType = target.startsWith('artist:') ? 'artist' : target.startsWith('label:') ? 'label' : data.accountType;
      const plan = planForType(data.plans.find(p => p.id === planId) || null, billedType);
      const priced = priceUsage(data.usage, data.rates, plan);
      let invoices = [];
      const stripe = stripeClient();
      if (stripe) {
        // Admin: every invoice of this venue (venue, artists, labels); a venue: its own
        let list = [];
        // Admin: every invoice sent to any client account (all venues, artists, record labels, managements)
        if (isAdmin) {
          for await (const inv of stripe.invoices.list({ limit: 100 })) {
            if (inv.metadata?.venueSlug) list.push(inv);
            if (list.length >= 300) break;
          }
        }
        else {
          // A client: every invoice sent for this account, whether billed to the account itself or to one of its artists or labels
          try {
            for await (const inv of stripe.invoices.list({ limit: 100 })) {
              if (inv.metadata?.venueSlug === slug || (data.customer && inv.customer === data.customer)) list.push(inv);
              if (list.length >= 100) break;
            }
          } catch (e) { console.error('[billing] client invoices', slug, e.message); }
          list = list.filter(i => i.status !== 'draft');
        }
        // Each account's type and name, and saved statuses, for the invoices of every account
        const acctTypes = {}, allStatuses = { ...(data.statuses || {}) };
        if (isAdmin) {
          await withRedis(async r => {
            for (const v of [...new Set(list.map(i => i.metadata.venueSlug))]) {
              acctTypes[v] = (await r.get(`brand_org_type:${v}`)) || (await r.get(`account_type:${v}`)) || cfg[v]?.type || (/team$/i.test(String(cfg[v]?.name || '')) ? 'management' : 'venue');
              Object.assign(allStatuses, await r.hGetAll(`billing_status:${v}`));
            }
          });
        }
        // Invoices the admin deleted stay in Stripe for the accounts but leave every list
        const hidden = new Set(await withRedis(r => r.sMembers('billing_hidden')).catch(() => []));
        list = list.filter(i => !hidden.has(i.id));
        invoices = list.sort((x, y) => y.created - x.created).map(i => {
          const t = i.metadata?.target || 'venue';
          const iv = i.metadata?.venueSlug || slug;
          const own = allStatuses[i.id];
          const fromStripe = i.status === 'paid' ? 'paid' : i.status === 'uncollectible' || i.status === 'void' ? 'unpaid' : 'waiting';
          return {
            id: i.id, number: i.number, status: own || fromStripe, total: i.total / 100, currency: i.currency,
            created: i.created * 1000, url: i.hosted_invoice_url, pdf: i.invoice_pdf, payable: i.status === 'open' && i.amount_remaining > 0,
            issued: (i.status_transitions?.finalized_at || i.created) * 1000, due: i.due_date ? i.due_date * 1000 : null, paidAt: i.status_transitions?.paid_at ? i.status_transitions.paid_at * 1000 : null,
            amountDue: i.amount_remaining / 100, email: i.customer_email || '', address: i.customer_address ? [i.customer_address.line1, i.customer_address.line2, [i.customer_address.city, i.customer_address.postal_code].filter(Boolean).join(' '), i.customer_address.country].filter(Boolean) : [], vat: (i.customer_tax_ids || []).map(t => t.value).filter(Boolean), lines: (i.lines?.data || []).slice(0, 30).map(l => ({ text: String(l.description || ''), amount: l.amount / 100 })),
            billedTo: i.customer_name || (t === 'venue' ? (cfg[iv]?.name || venueName) : t.replace(/^(artist|label|venue|management):/, '')),
            kind: t === 'venue' ? TYPE_LABEL[acctTypes[iv] || data.accountType] || 'Account' : TYPE_LABEL[t.split(':')[0]] || 'Artist',
            account: iv, accountName: cfg[iv]?.name || iv,
          };
        });
      }
      // Which Stripe account the app uses, and whether its invoices carry a name and logo (admin)
      let stripeAccount = null;
      if (isAdmin && stripe) {
        try {
          const acct = await stripe.accounts.retrieve();
          stripeAccount = { id: acct.id, name: acct.settings?.dashboard?.display_name || acct.business_profile?.name || '', publicName: acct.business_profile?.name || '', logo: !!acct.settings?.branding?.logo, icon: !!acct.settings?.branding?.icon, country: acct.country || '' };
          console.log('[billing] stripe account', JSON.stringify(stripeAccount));
        } catch (e) { stripeAccount = { error: e.message }; }
      }
      // The client's subscription: whether it's set to end, and when
      let subscription = null;
      const subId = (data.assignments.venue || {}).subscriptionId || getVenuesConfig()[slug]?.subscription || '';
      if (stripe && subId && target === 'venue') {
        const sub = await stripe.subscriptions.retrieve(subId).catch(() => null);
        const end = sub && (sub.current_period_end || sub.items?.data?.[0]?.current_period_end);
        const ce = sub && sub.metadata && sub.metadata.commitEnd ? Date.parse(sub.metadata.commitEnd + 'T23:59:59Z') : 0;
        if (sub) subscription = { status: sub.status, cancelAtPeriodEnd: !!(sub.cancel_at_period_end || sub.cancel_at), periodEnd: sub.cancel_at ? sub.cancel_at * 1000 : end ? end * 1000 : null, commitEnd: ce > Date.now() ? ce : null, tier: sub.metadata?.tier || '' };
      }
      const elapsed = Math.min(1, Math.max(0, (Date.now() - base.start) / (base.end - base.start)));
      return res.status(200).json({
        venue: venueName, target, period: { label: base.label, start: base.start, end: base.end, elapsed },
        usage: data.usage, ...priced, invoices, stripe: !!stripe, isAdmin, subscription, accountType: data.accountType, accountTypeLabel: TYPE_LABEL[data.accountType] || 'Account',
        // Plans a client can move to (name, price, what's included)
        // (pay-as-you-go plans are chosen at sign-up only; an account can move up to a monthly plan from them)
        plansOffered: data.plans.filter(p => p.price > 0 || p.id === ((data.assignments.venue || {}).plan || '')).map(p => planForType(p, data.accountType)).map(p => ({ signupFee: p.signupFee || 0, id: p.id, name: p.name, price: p.price, maxClips: p.maxClips, cameras: p.cameras || 0, features: p.features || [], included: p.included })),
        currentPlan: (data.assignments.venue || {}).plan || '',
        ...(isAdmin ? { kit: await withRedis(readKit), kitPlans: KIT_PLANS,
          // Each kit plan's monthly price for a venue, a record label and an artist (for the kit's share of the first month)
          kitPrices: Object.fromEntries(KIT_PLANS.map(id => { const p = data.plans.find(x => x.id === id); return [id, p ? { venue: priceForType(p.price, 'venue', id), label: priceForType(p.price, 'label', id), artist: priceForType(p.price, 'artist', id) } : {}]; })),
          stripeAccount, venueSlug: slug, venues: billable.map(k => ({ slug: k, name: cfg[k]?.name || k })), rates: data.rates, plans: data.plans, assignments: data.assignments, artists: data.artists, labels: data.labels, bkVenues: data.bkVenues, assignment: a } : {}),
      });
    }

    if (req.method !== 'POST') return res.status(405).end();
    // A client changes its own plan: the Stripe subscription moves to the new price (prorated),
    // or, without a subscription yet, a Stripe checkout starts one
    if (!isAdmin) {
      const body0 = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      // Rent a PTZ camera: £149 a month as its own subscription, 12-month minimum (camera and cable cost us
      // ~£1,144, and its recordings ~£40 a month in Mux: paid back in about 10 months)
      if (body0.action === 'addCamera') {
        const stripe = stripeClient();
        if (!stripe) return res.status(503).json({ error: 'Payments are not set up yet' });
        const customer = await withRedis(r => r.get(`billing_customer:${slug}`));
        const commitEnd = new Date(Date.now() + 365 * 86400e3).toISOString().slice(0, 10);
        const meta = { kind: 'addon-camera', venueSlug: slug, minimumMonths: '12', commitEnd };
        const checkout = await stripe.checkout.sessions.create({
          mode: 'subscription',
          ...(customer ? { customer } : { customer_email: session.email }),
          line_items: [{ quantity: 1, price_data: { currency: 'gbp', unit_amount: 14900, tax_behavior: 'exclusive', recurring: { interval: 'month' }, product_data: { name: 'local / assets · PTZ camera (12-month minimum)' } } }],
          custom_text: { submit: { message: 'PTZ camera, £149 a month for at least 12 months. The camera stays ours and goes back when the rental ends.' } },
          success_url: 'https://local-assets.com/billing?camera=added', cancel_url: 'https://local-assets.com/billing',
          metadata: meta, subscription_data: { metadata: meta },
        });
        return res.status(200).json({ url: checkout.url });
      }
      if (body0.action === 'cancelPlan' || body0.action === 'resumePlan') {
        const out = await withRedis(async redis => {
          const a = (await readAssignments(redis, slug)).venue || {};
          const subId = a.subscriptionId || getVenuesConfig()[slug]?.subscription || '';
          const stripe = stripeClient();
          if (stripe && subId) {
            // A plan with a 12-month minimum closes when the minimum ends, not at the end of this month
            const cur = await stripe.subscriptions.retrieve(subId);
            const ce = cur.metadata && cur.metadata.commitEnd ? Math.floor(Date.parse(cur.metadata.commitEnd + 'T23:59:59Z') / 1000) : 0;
            const cancel = body0.action === 'cancelPlan';
            const sub = await stripe.subscriptions.update(subId, cancel
              ? (ce > Date.now() / 1000 ? { cancel_at: ce } : { cancel_at_period_end: true })
              : { cancel_at_period_end: false, cancel_at: '' });
            const end = sub.cancel_at || sub.current_period_end || sub.items?.data?.[0]?.current_period_end;
            console.log('[billing]', body0.action, slug, subId, ce > Date.now() / 1000 ? 'minimum until ' + cur.metadata.commitEnd : '');
            return { ok: true, cancelAtPeriodEnd: !!(sub.cancel_at_period_end || sub.cancel_at), periodEnd: end ? end * 1000 : null, commitEnd: ce > Date.now() / 1000 ? ce * 1000 : null };
          }
          // No subscription (account set up by hand): local / assets is told and closes it
          if (body0.action === 'cancelPlan') {
            await redis.hSet(`billing_cancel_requests`, slug, JSON.stringify({ email: session.email, at: new Date().toISOString(), reason: String(body0.reason || '').slice(0, 500) }));
            if ((process.env.LA_RESEND_API_KEY || process.env.RESEND_API_KEY)) {
              const { Resend } = await import('resend');
              await new Resend((process.env.LA_RESEND_API_KEY || process.env.RESEND_API_KEY)).emails.send({ from: 'local / assets <noreply@local-assets.com>', to: process.env.ORDERS_EMAIL || 'info@local-assets.com', subject: `Cancellation request: ${venueName}`, html: `<p>${venueName} (${session.email}) asked to cancel their account.</p><p>${String(body0.reason || '').replace(/[<>]/g, '')}</p>` }).catch(() => {});
            }
            return { ok: true, requested: true };
          }
          return { ok: true };
        });
        return res.status(200).json(out);
      }
      if (body0.action !== 'changePlan') return res.status(403).json({ error: admins().includes(session.email) ? `You're now signed in to ${venueName || 'another account'}, not local / assets (switched in another tab or the account menu). Switch back to local / assets, then save again.` : 'Only local / assets can change billing', code: 'not_admin' });
      const stripe = stripeClient();
      if (!stripe) return res.status(503).json({ error: 'Payments are not set up yet' });
      const out = await withRedis(async redis => {
        const acctType = (await redis.get(`brand_org_type:${slug}`)) || (await redis.get(`account_type:${slug}`)) || 'venue';
        const plan = planForType((await readPlans(redis)).find(p => p.id === String(body0.plan || '')), acctType);
        if (!plan || !(plan.price > 0)) return { status: 400, error: 'Unknown plan' };
        const a = (await readAssignments(redis, slug)).venue || {};
        const subId = a.subscriptionId || getVenuesConfig()[slug]?.subscription || '';
        const price = { currency: 'gbp', unit_amount: Math.round(plan.price * 100), recurring: { interval: 'month' } };
        if (subId) {
          const sub = await stripe.subscriptions.retrieve(subId).catch(() => null);
          if (sub && sub.status !== 'canceled' && sub.items.data[0]) {
            const p = await stripe.prices.create({ ...price, product_data: { name: `local / assets · ${plan.name}` } });
            // Paid before it's switched: the difference for the rest of this month is invoiced and charged now
            // (pending_if_incomplete): if the card is declined or needs confirming, the plan stays as it was until paid
            const updated = await stripe.subscriptions.update(subId, { items: [{ id: sub.items.data[0].id, price: p.id }], proration_behavior: 'always_invoice', payment_behavior: 'pending_if_incomplete', expand: ['latest_invoice'] });
            const metadata = { ...sub.metadata, tier: plan.id, ...(commitEndFor(plan.id, acctType) && !(sub.metadata.commitEnd > new Date().toISOString().slice(0, 10)) ? { commitEnd: commitEndFor(plan.id, acctType), minimumMonths: '12' } : {}) };
            if (updated.pending_update) {
              // Applied by api/stripe-webhook.js when that invoice is paid (Stripe drops the change after 23 hours)
              await redis.set(`billing_pending_plan:${subId}`, JSON.stringify({ slug, plan: plan.id, metadata }), { EX: 23 * 3600 });
              const inv = updated.latest_invoice;
              return { status: 402, error: 'The payment for ' + plan.name + ' didn\'t go through, so your plan hasn\'t changed yet. Pay the invoice to switch.', payUrl: inv?.hosted_invoice_url || '' };
            }
            await stripe.subscriptions.update(subId, { metadata });
            await redis.hSet(assignKey(slug), 'venue', JSON.stringify({ ...a, plan: plan.id, subscription: true, subscriptionId: subId }));
            console.log('[billing] plan changed (paid)', slug, plan.id);
            return { status: 200, changed: true, plan: plan.name };
          }
        }
        const customer = await redis.get(`billing_customer:${slug}`);
        // Moving on from the Trial Month within 30 days: its join fee comes off the first month (once)
        const credit = a.trialFee > 0 && a.trialAt && Date.now() - a.trialAt <= 30 * 86400e3 && !a.trialCredited
          ? await stripe.coupons.create({ amount_off: Math.round(a.trialFee * 100), currency: 'gbp', duration: 'once', max_redemptions: 1, name: 'Trial Month credit' }).catch(e => { console.error('[billing] trial credit', e.message); return null; })
          : null;
        const checkout = await stripe.checkout.sessions.create({
          ...(credit ? { discounts: [{ coupon: credit.id }] } : {}),
          mode: 'subscription',
          ...(customer ? { customer } : { customer_email: session.email }),
          line_items: [{ quantity: 1, price_data: { ...price, product_data: { name: `local / assets · ${plan.name}` } } }],
          success_url: 'https://local-assets.com/billing?plan=updated', cancel_url: 'https://local-assets.com/billing',
          metadata: { kind: 'upgrade', venueSlug: slug, tier: plan.id, ...(credit ? { trialCredit: '1' } : {}) },
          subscription_data: { metadata: { kind: 'upgrade', venueSlug: slug, tier: plan.id, ...(commitEndFor(plan.id, acctType) ? { commitEnd: commitEndFor(plan.id, acctType), minimumMonths: '12' } : {}) } },
        });
        return { status: 200, url: checkout.url };
      });
      const { status, ...rest } = out;
      return res.status(status).json(rest);
    }
    if (!isAdmin) return res.status(403).json({ error: admins().includes(session.email) ? `You're now signed in to ${venueName || 'another account'}, not local / assets (switched in another tab or the account menu). Switch back to local / assets, then save again.` : 'Only local / assets can change billing', code: 'not_admin' });
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});

    // Sign-ups waiting for their video storage (a Mux environment created by local / assets)
    if (body.action === 'pendingClients') {
      const reg = await withRedis(r => readRegistryRaw(r));
      const ready = await withRedis(r => poolSize(r));
      return res.status(200).json({ ready, clients: Object.entries(reg).filter(([, v]) => v.status === 'pending').map(([slug, v]) => ({ slug, name: v.name, type: v.type, plan: v.plan, email: (v.emails || [])[0] || '', createdAt: v.createdAt })) });
    }
    // Ready video storage: empty Mux environments a new sign-up takes straight away
    if (body.action === 'muxPool') {
      const pool = await withRedis(r => listPool(r));
      // Accounts that have no video storage yet (e.g. added by hand to VENUES_CONFIG): ready storage can be given to them
      const cfg = getVenuesConfig();
      const without = Object.entries(cfg).filter(([slug, v]) => slug !== ADMIN_VENUE && !/^local\s*[\/-]?\s*assets\b/i.test(String(v?.name || '')) && !venueAuth(slug)).map(([slug, v]) => ({ slug, name: v?.name || slug }));
      return res.status(200).json({ pool, without });
    }
    // Give one ready environment to an existing account that has no video storage
    if (body.action === 'giveReady') {
      const slug = String(body.slug || ''), key = String(body.key || '');
      const v = getVenuesConfig()[slug];
      if (!v) return res.status(404).json({ error: 'Unknown account' });
      if (venueAuth(slug)) return res.status(400).json({ error: 'This account already has video storage' });
      const label = await withRedis(async r => {
        const reg = await readRegistryRaw(r);
        if (!reg[slug]) await saveRegistryEntry(r, slug, { name: String(v.name || slug).toUpperCase(), emails: v.emails || [], type: v.type || 'venue', plan: '', status: 'pending', attached: true, createdAt: new Date().toISOString() });
        return activateFromPool(r, slug, key);
      });
      if (!label) return res.status(400).json({ error: 'That ready storage could not be used (already taken, or Mux did not accept it). Try another one.' });
      console.log('[billing] ready storage given to', slug, label);
      return res.status(200).json({ ok: true, label, pool: await withRedis(r => listPool(r)) });
    }
    if (body.action === 'muxPoolAdd') {
      const out = await withRedis(r => addToPool(r, { label: body.label, tokenId: body.tokenId, tokenSecret: body.tokenSecret, webhookSecret: body.webhookSecret }));
      if (out.error) return res.status(400).json({ error: out.error });
      console.log('[billing] ready storage added', out.key);
      return res.status(200).json({ ok: true, pool: await withRedis(r => listPool(r)) });
    }
    if (body.action === 'muxPoolRemove') {
      await withRedis(r => removeFromPool(r, String(body.key || '')));
      return res.status(200).json({ ok: true, pool: await withRedis(r => listPool(r)) });
    }
    // Open an account by hand on one ready environment: no sign-up and no payment. It is billed only
    // once a plan is assigned under Bill to.
    if (body.action === 'openAccount') {
      const name = String(body.name || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 60);
      const type = ['venue', 'label', 'artist', 'management'].includes(body.type) ? body.type : 'venue';
      const emails = [...new Set(String(body.emails || '').split(/[\s,;]+/).map(e => e.toLowerCase().trim()).filter(Boolean))];
      if (!name) return res.status(400).json({ error: 'Type the account name' });
      if (!emails.length) return res.status(400).json({ error: 'Add at least one login email' });
      const badEmail = emails.find(e => !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(e));
      if (badEmail) return res.status(400).json({ error: `Check this email: ${badEmail}` });
      if (emails.length > 20) return res.status(400).json({ error: 'Up to 20 login emails' });
      const base = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'client';
      const out = await withRedis(async r => {
        const existing = { ...getVenuesConfig(), ...(await readRegistryRaw(r)) };
        const taken = new Set([...Object.keys(existing), ...(await r.sMembers('la_deleted').catch(() => []))].map(k => k.toLowerCase()));
        let slug = base;
        for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`;
        await saveRegistryEntry(r, slug, { name: name.toUpperCase(), emails, type, plan: '', status: 'pending', manual: true, createdAt: new Date().toISOString() });
        await r.set(`brand_org_type:${slug}`, type);
        await r.set(`brand_org_name:${slug}`, name);
        const label = await activateFromPool(r, slug, String(body.key || ''));
        return { slug, label };
      });
      console.log('[billing] account opened by hand', out.slug, type, out.label ? 'live' : 'waiting for storage');
      if (!out.label) return res.status(200).json({ ok: true, slug: out.slug, waiting: true, pool: await withRedis(r => listPool(r)) });
      return res.status(200).json({ ok: true, slug: out.slug, label: out.label, pool: await withRedis(r => listPool(r)) });
    }
    // A sign-up still waiting: give it the next ready environment
    if (body.action === 'useReady') {
      const slug = String(body.slug || '');
      const label = await withRedis(async r => { const reg = await readRegistryRaw(r); return reg[slug]?.status === 'pending' ? activateFromPool(r, slug) : null; });
      if (!label) return res.status(400).json({ error: 'No ready video storage left. Add one under Ready video storage.' });
      console.log('[billing] client activated from ready storage', slug, label);
      return res.status(200).json({ ok: true, label });
    }
    if (body.action === 'finishSetup') {
      const slug = String(body.slug || ''), id = String(body.tokenId || '').trim(), secret = String(body.tokenSecret || '').trim(), webhook = String(body.webhookSecret || '').trim();
      if (!id || !secret) return res.status(400).json({ error: 'Paste the access token ID and secret' });
      const check = await fetch('https://api.mux.com/video/v1/assets?limit=1', { headers: { Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64') }, signal: AbortSignal.timeout(15000) });
      if (!check.ok) return res.status(400).json({ error: check.status === 401 ? 'Mux rejected these keys. Copy them again from the environment\'s Access Tokens.' : `Mux answered ${check.status}` });
      const out = await withRedis(async r => {
        const reg = await readRegistryRaw(r);
        if (!reg[slug]) return null;
        await saveRegistryEntry(r, slug, { ...reg[slug], mux: sealSecret(`${id}:${secret}`), ...(webhook ? { muxWebhook: sealSecret(webhook) } : {}), status: 'active', activatedAt: new Date().toISOString() });
        return reg[slug];
      });
      if (!out) return res.status(404).json({ error: 'Unknown client' });
      console.log('[billing] client activated', slug);
      return res.status(200).json({ ok: true });
    }

    if (body.action === 'setRates') {
      const r = body.rates || {};
      const clean = {};
      for (const k of ['videoStorage', 'videoDelivery', 'videoDelivery4K', 'videoEncoding', 'liveRecording', 'fileStorage', 'margin']) {
        const n = Number(r[k]);
        if (Number.isFinite(n) && n >= 0 && n < 1000) clean[k] = n;
      }
      await withRedis(redis => redis.set('billing_rates', JSON.stringify({ ...DEFAULT_RATES, ...clean })));
      return res.status(200).json({ ok: true });
    }

    // Subscriptions keep the price they were started at: this lists the ones that differ from their plan's
    // price today (by account type) and, with apply, moves them to it from their next invoice (no proration)
    if (body.action === 'repriceSubscriptions') {
      const stripe = stripeClient();
      if (!stripe) return res.status(503).json({ error: 'Payments are not set up yet' });
      const rows = await withRedis(async redis => {
        const plans = await readPlans(redis), out = [];
        for (const s of billable) {
          const a = (await readAssignments(redis, s)).venue || {};
          const subId = a.subscriptionId || cfg[s]?.subscription || '';
          if (!subId || !a.plan) continue;
          const type = await accountTypeOf(redis, s);
          const plan = planForType(plans.find(p => p.id === a.plan) || null, type);
          if (!plan || !(plan.price > 0)) continue;
          const sub = await stripe.subscriptions.retrieve(subId).catch(() => null);
          const item = sub && !['canceled', 'incomplete_expired'].includes(sub.status) ? sub.items.data[0] : null;
          if (!item) continue;
          const from = (item.price?.unit_amount || 0) / 100, to = Math.round(plan.price * 100) / 100;
          if (Math.abs(from - to) < 0.01) continue;
          const row = { slug: s, name: cfg[s]?.name || s, type, plan: plan.name, from, to };
          if (body.apply) {
            const p = await stripe.prices.create({ currency: 'gbp', unit_amount: Math.round(to * 100), recurring: { interval: 'month' }, product_data: { name: `local / assets · ${plan.name}` } });
            await stripe.subscriptions.update(subId, { items: [{ id: item.id, price: p.id }], proration_behavior: 'none' });
            console.log('[billing] repriced', s, from, '→', to);
            row.done = true;
          }
          out.push(row);
        }
        return out;
      });
      return res.status(200).json({ rows });
    }

    // An example of the email a client gets on the 1st, for the account chosen in Bill to (this month so far),
    // sent to the address given. Nothing is invoiced or charged.
    if (body.action === 'exampleInvoiceEmail') {
      const to = String(body.to || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ error: 'Enter the email to send the example to' });
      const data = await withRedis(async redis => {
        const [rates, plans] = await Promise.all([readRates(redis), readPlans(redis)]);
        const a = (await readAssignments(redis, slug)).venue || {};
        const plan = planForType(plans.find(p => p.id === a.plan) || null, await accountTypeOf(redis, slug));
        const usage = await venueUsage(slug, auth, monthRange());
        const priced = priceUsage(usage, rates, plan);
        if (a.subscription) priced.total = priced.usageTotal;
        return { name: a.name || venueName, period: monthRange().label, plan: priced.planAmount && !a.subscription ? { name: plan.name, amount: priced.planAmount } : null, lines: priced.lines, total: priced.total, url: 'https://local-assets.com/billing', charged: false, example: true };
      });
      await sendInvoiceEmail(to, data);
      return res.status(200).json({ ok: true, to, total: data.total });
    }

    if (body.action === 'setKit') {
      const kit = cleanKit(body.kit);
      await withRedis(redis => redis.set('billing_kit', JSON.stringify(kit)));
      return res.status(200).json({ kit });
    }

    if (body.action === 'setPlans') {
      const plans = cleanPlans(body.plans);
      if (!plans.length) return res.status(400).json({ error: 'Add at least one plan' });
      await withRedis(redis => redis.set('billing_plans', JSON.stringify(plans)));
      return res.status(200).json({ plans });
    }

    if (body.action === 'assign') {
      const target = cleanTarget(body.target);
      const rec = { plan: cleanText(body.plan, 40), email: cleanText(body.email, 120), name: cleanText(body.name, 80), monthly: !!body.monthly, details: cleanDetails(body.details) };
      if (rec.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rec.email)) return res.status(400).json({ error: 'Enter a valid email' });
      const customerId = await withRedis(async redis => {
        await redis.hSet(assignKey(slug), target, JSON.stringify(rec));
        return redis.get(`billing_customer:${target === 'venue' ? slug : `${slug}:${target}`}`);
      });
      // The Stripe customer gets the details now, so the next invoice and Stripe's own records carry them
      const stripe = stripeClient();
      let stripeUpdated = false;
      if (stripe && customerId && rec.details.legalName) {
        try { await applyDetails(stripe, customerId, rec.details); if (rec.email) await stripe.customers.update(customerId, { email: rec.email }); stripeUpdated = true; }
        catch (e) { console.error('[billing] customer details', slug, target, e.message); }
      }
      return res.status(200).json({ ok: true, stripeUpdated });
    }

    if (body.action === 'setAccountType') {
      const t = String(body.accountType || '');
      if (!TYPE_LABEL[t]) return res.status(400).json({ error: 'Unknown type' });
      // One type for the account, shared with its Brand Kit
      await withRedis(r => Promise.all([r.set(`account_type:${slug}`, t), r.set(`brand_org_type:${slug}`, t)]));
      return res.status(200).json({ ok: true });
    }

    // Admin: delete an invoice. A draft is deleted, an unpaid one voided (it can no longer be paid);
    // a paid one stays in Stripe for the accounts. All of them leave the invoice lists.
    if (body.action === 'deleteInvoice') {
      const stripe = stripeClient();
      if (!stripe) return res.status(503).json({ error: 'Stripe is not connected' });
      const id = String(body.invoice || '');
      if (!/^in_[A-Za-z0-9]+$/.test(id)) return res.status(400).json({ error: 'Unknown invoice' });
      const inv = await stripe.invoices.retrieve(id).catch(() => null);
      if (!inv?.metadata?.venueSlug) return res.status(404).json({ error: 'Invoice not found' });
      let done = 'hidden';
      if (inv.status === 'draft') { await stripe.invoices.del(id); done = 'deleted'; }
      else if (inv.status === 'open' || inv.status === 'uncollectible') { await stripe.invoices.voidInvoice(id); done = 'voided'; }
      await withRedis(r => Promise.all([r.sAdd('billing_hidden', id), r.hDel(`billing_unpaid:${inv.metadata.venueSlug}`, id), r.hDel(`billing_status:${inv.metadata.venueSlug}`, id)]));
      console.log('[billing] invoice', id, done, 'by', session.email);
      return res.status(200).json({ ok: true, done });
    }

    if (body.action === 'setStatus') {
      const id = String(body.invoice || '');
      const status = STATUSES.includes(body.status) ? body.status : null;
      if (!/^in_[A-Za-z0-9]+$/.test(id) || !status) return res.status(400).json({ error: 'Unknown invoice or status' });
      const stripe = stripeClient();
      const inv = stripe ? await stripe.invoices.retrieve(id).catch(() => null) : null;
      if (!inv || !inv.metadata?.venueSlug) return res.status(404).json({ error: 'Invoice not found' });
      const invSlug = inv.metadata.venueSlug;
      // Stripe follows where it can: paid outside Stripe, or written off; it can't reopen a paid invoice
      if (status === 'paid' && inv.status === 'open') await stripe.invoices.pay(id, { paid_out_of_band: true }).catch(() => {});
      if (status === 'unpaid' && inv.status === 'open') await stripe.invoices.markUncollectible(id).catch(() => {});
      await withRedis(async redis => {
        await redis.hSet(`billing_status:${invSlug}`, id, status);
        // Not paid pauses the account it was for; paid or waiting lifts that
        if (status === 'unpaid') await redis.hSet(unpaidKey(invSlug), id, JSON.stringify({ target: inv.metadata?.target || 'venue', number: inv.number || '', url: inv.hosted_invoice_url || '' }));
        else await redis.hDel(unpaidKey(invSlug), id);
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
      const name = cleanText(body.name, 80) || (target === 'venue' ? (venueName) : target.replace(/^(artist|label|venue|management):/, ''));
      const det = cleanDetails(body.details);
      if (!det.legalName || !det.line1 || !det.city || !det.postcode) return res.status(400).json({ error: 'Add the billing details first: legal name, address, city and postcode' });
      const out = await withRedis(redis => invoiceVenue(redis, stripe, { slug, auth: auth, email, name, target, planId: cleanText(body.plan, 40) || null }, period));
      return res.status(200).json(out);
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    console.error('[billing]', slug, e.message);
    return res.status(500).json({ error: e.message });
  }
}
