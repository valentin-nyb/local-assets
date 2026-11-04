// Weekly numbers for the founders: MRR, churn, cost to serve each account and gross margin, emailed every
// Monday (api/billing.js ?cron=weekly) and kept week by week in Redis (metrics_weekly, newest first).
import { MUX_PRICES, readRunning, readAssignments, venueEntries, accountTypeOf, stripeFeesThisMonth, monthRange, readTestAccounts, stripeLive } from './_billing.js';
import { isAdminVenue } from './_venues.js';

const DAY = 86400e3;
export const METRICS_KEY = 'metrics_weekly';
const LIVE = ['active', 'past_due', 'trialing'];

// A subscription's price a month, in pounds (yearly and weekly prices brought to a month)
function monthly(sub) {
  let pence = 0;
  for (const it of sub.items?.data || []) {
    const p = it.price || {}, r = p.recurring || {};
    if ((p.currency || 'gbp') !== 'gbp') continue;
    const per = (p.unit_amount || 0) * (it.quantity || 1) / (r.interval_count || 1);
    pence += r.interval === 'year' ? per / 12 : r.interval === 'week' ? per * 52 / 12 : r.interval === 'day' ? per * 365 / 12 : per;
  }
  return pence / 100;
}

export async function weeklyMetrics(redis, stripe, overview) {
  const now = Date.now(), weekAgo = now - 7 * DAY, monthAgo = now - 30 * DAY;
  // Test accounts (marked in Billing → All accounts) count nowhere: not their payments, not their video
  const tests = await readTestAccounts(redis);
  // Only the live Stripe account counts: sandbox payments were tests, never money
  const liveStripe = stripeLive();
  const slugOf = o => o?.metadata?.venueSlug || o?.parent?.subscription_details?.metadata?.venueSlug || o?.subscription_details?.metadata?.venueSlug || '';

  // Subscriptions: what's live now, what started and what ended
  const subs = [], testCustomers = new Set();
  if (liveStripe) for await (const s of stripe.subscriptions.list({ status: 'all', limit: 100 })) {
    if (tests.has(slugOf(s))) { if (s.customer) testCustomers.add(String(s.customer)); continue; }
    subs.push(s);
  }
  const live = subs.filter(s => LIVE.includes(s.status));
  const endedAt = s => (s.ended_at || s.canceled_at || 0) * 1000;
  const ended = since => subs.filter(s => s.status === 'canceled' && endedAt(s) >= since);
  const started = since => subs.filter(s => s.created * 1000 >= since);
  const sum = list => Math.round(list.reduce((t, s) => t + monthly(s), 0) * 100) / 100;
  const mrr = sum(live);
  // 30-day churn: subscriptions that ended, out of those there at the start of the 30 days
  const atStart = live.filter(s => s.created * 1000 < monthAgo).length + ended(monthAgo).filter(s => s.created * 1000 < monthAgo).length;
  const atStartMrr = sum(live.filter(s => s.created * 1000 < monthAgo)) + sum(ended(monthAgo).filter(s => s.created * 1000 < monthAgo));
  const churn = { count7: ended(weekAgo).length, mrr7: sum(ended(weekAgo)), count30: ended(monthAgo).length,
    rate30: atStart ? ended(monthAgo).length / atStart : null, revenueRate30: atStartMrr ? sum(ended(monthAgo)) / atStartMrr : null };

  // Cash in: invoices paid in the last 30 days, before VAT
  let revenue30 = 0;
  if (liveStripe) for await (const inv of stripe.invoices.list({ status: 'paid', created: { gte: Math.floor((monthAgo - 31 * DAY) / 1000) }, limit: 100 })) {
    const paidAt = (inv.status_transitions?.paid_at || inv.created) * 1000;
    if (tests.has(slugOf(inv)) || testCustomers.has(String(inv.customer || ''))) continue;
    if (paidAt >= monthAgo && inv.currency === 'gbp') revenue30 += (inv.total_excluding_tax ?? inv.subtotal ?? inv.amount_paid) / 100;
  }

  // Accounts by plan and type (local / assets itself and test accounts left out)
  const accounts = { total: 0, paying: 0, free: 0, tests: 0, byType: {} };
  for (const { slug, cfg } of venueEntries()) {
    if (isAdminVenue({ slug, ...cfg })) continue;
    if (tests.has(slug)) { accounts.tests++; continue; }
    const a = (await readAssignments(redis, slug).catch(() => ({}))).venue || {};
    const type = await accountTypeOf(redis, slug).catch(() => 'venue');
    accounts.total++;
    accounts.byType[type] = (accounts.byType[type] || 0) + 1;
    if (a.plan === 'dj-trial') accounts.free++;
  }
  accounts.paying = live.length;

  // What running the platform costs a month: Mux and Stripe so far this month brought to a full month,
  // plus the fixed services (Billing → Running costs), in pounds
  const { start, end } = monthRange();
  const part = Math.max(0.1, Math.min(1, (now - start) / (end - start)));
  // Mux: only the clients' share of the bill (not local / assets' own, test or deleted accounts' video)
  const ovRows = (overview?.rows || []).filter(r => r.cost != null);
  const client = r => r.slug && r.type !== 'admin' && !tests.has(r.slug);
  const allMux = ovRows.reduce((t, r) => t + r.cost, 0), clientMux = ovRows.filter(client).reduce((t, r) => t + r.cost, 0);
  const muxGbp = (overview?.totals?.costGbp || 0) * (allMux > 0 ? clientMux / allMux : 0) / part;
  const stripeGbp = liveStripe ? (await stripeFeesThisMonth(stripe).catch(() => 0)) / part : 0;
  let fixed = 0;
  for (const r of await readRunning(redis)) if (!r.auto && r.cost > 0) fixed += r.cur === 'usd' ? r.cost * MUX_PRICES.usdToGbp : r.cost;
  const cost = Math.round((muxGbp + stripeGbp + fixed) * 100) / 100;
  // Each venue's own video cost (from the overview), on average, plus its share of the fixed costs
  const venueRows = ovRows.filter(r => r.type === 'venue' && client(r));
  const venueMux = venueRows.length ? venueRows.reduce((t, r) => t + r.cost, 0) * MUX_PRICES.usdToGbp / part / venueRows.length : null;

  return {
    at: now, live: liveStripe, mrr, arr: Math.round(mrr * 12), subscriptions: live.length,
    newMrr7: sum(started(weekAgo).filter(s => LIVE.includes(s.status))), newCount7: started(weekAgo).filter(s => LIVE.includes(s.status)).length,
    churn, revenue30: Math.round(revenue30 * 100) / 100, accounts,
    cost: { monthly: cost, mux: Math.round(muxGbp * 100) / 100, stripe: Math.round(stripeGbp * 100) / 100, fixed: Math.round(fixed * 100) / 100,
      perAccount: accounts.total ? Math.round(cost / accounts.total * 100) / 100 : null,
      perVenue: venueMux == null ? null : Math.round((venueMux + (accounts.total ? fixed / accounts.total : 0)) * 100) / 100 },
    // Gross margin on the monthly run rate: subscriptions against what it all costs a month
    margin: mrr > 0 ? (mrr - cost) / mrr : null,
  };
}

const money = n => n == null ? '—' : '£' + Number(n).toLocaleString('en-GB', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
const pct = n => n == null ? '—' : (Math.round(n * 1000) / 10) + '%';
const esc = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// The email: this week next to last week, with the change
export function metricsEmail(m, prev) {
  const change = (a, b, fmt) => b == null || a == null ? '' : a === b ? 'same' : (a > b ? '+' : '−') + fmt(Math.abs(a - b));
  const rows = [
    ['MRR', money(m.mrr), money(prev?.mrr), change(m.mrr, prev?.mrr, money), `${m.subscriptions} live subscriptions · ARR ${money(m.arr)}`],
    ['New this week', money(m.newMrr7), money(prev?.newMrr7), '', `${m.newCount7} new subscription${m.newCount7 === 1 ? '' : 's'}`],
    ['Churned this week', money(m.churn.mrr7), money(prev?.churn?.mrr7), '', `${m.churn.count7} cancelled`],
    ['Churn, last 30 days', pct(m.churn.rate30), pct(prev?.churn?.rate30), '', `${m.churn.count30} cancelled · revenue churn ${pct(m.churn.revenueRate30)}`],
    ['Cash in, last 30 days', money(m.revenue30), money(prev?.revenue30), change(m.revenue30, prev?.revenue30, money), 'Paid invoices, before VAT'],
    ['Running cost a month', money(m.cost.monthly), money(prev?.cost?.monthly), change(m.cost.monthly, prev?.cost?.monthly, money), `Mux ${money(m.cost.mux)} · Stripe ${money(m.cost.stripe)} · services ${money(m.cost.fixed)}`],
    ['Cost per venue', money(m.cost.perVenue), money(prev?.cost?.perVenue), '', 'A venue\'s video a month, plus its share of the services'],
    ['Cost per account', money(m.cost.perAccount), money(prev?.cost?.perAccount), '', `${m.accounts.total} accounts · ${m.accounts.free} on Free`],
    ['Gross margin', pct(m.margin), pct(prev?.margin), '', 'MRR against the running cost a month'],
  ];
  const types = Object.entries(m.accounts.byType).map(([t, n]) => `${n} ${t}${n === 1 ? '' : 's'}`).join(' · ');
  const date = new Date(m.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const td = 'padding:10px 12px;border-bottom:1px solid #e4e4e7;font:14px/1.4 Helvetica,Arial,sans-serif;vertical-align:top';
  const html = `<div style="max-width:680px;margin:0 auto;color:#09090b">
<p style="font:600 12px Helvetica,Arial,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#71717a">Weekly numbers · ${esc(date)}</p>
<h1 style="font:700 28px Helvetica,Arial,sans-serif;margin:4px 0 6px">MRR ${esc(money(m.mrr))}</h1>
<p style="font:14px Helvetica,Arial,sans-serif;color:#52525b;margin:0 0 18px">Gross margin ${esc(pct(m.margin))} · churn ${esc(pct(m.churn.rate30))} (30 days) · cost per venue ${esc(money(m.cost.perVenue))}</p>
<table style="border-collapse:collapse;width:100%"><tr>${['', 'This week', 'Last week', 'Change', ''].map(h => `<th style="${td};text-align:left;font-weight:600;color:#71717a;font-size:12px">${h}</th>`).join('')}</tr>
${rows.map(r => `<tr><td style="${td};font-weight:600">${esc(r[0])}</td><td style="${td}">${esc(r[1])}</td><td style="${td};color:#71717a">${esc(r[2])}</td><td style="${td}">${esc(r[3])}</td><td style="${td};color:#71717a;font-size:12px">${esc(r[4])}</td></tr>`).join('')}
</table>
<p style="font:12px/1.5 Helvetica,Arial,sans-serif;color:#71717a;margin-top:16px">Accounts: ${esc(types || 'none yet')}${m.accounts.tests ? ` (${m.accounts.tests} test account${m.accounts.tests === 1 ? '' : 's'} left out)` : ''}. Mux and Stripe are this month so far brought to a full month; services are the fixed costs in Billing → Running costs. Discounts and VAT are left out of MRR.</p>
<p style="font:12px Helvetica,Arial,sans-serif;color:#71717a">LOCAL / ASSETS LTD · company no. 17559431</p></div>`;
  const text = rows.map(r => `${r[0]}: ${r[1]}${r[2] !== '—' ? ` (last week ${r[2]})` : ''}`).join('\n');
  return { subject: `Weekly numbers: MRR ${money(m.mrr)} · margin ${pct(m.margin)} · churn ${pct(m.churn.rate30)}`, html, text };
}
