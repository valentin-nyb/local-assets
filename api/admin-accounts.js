import { list, del } from '@vercel/blob';
import { createClient } from 'redis';
import { getWebSessionAuth, getVenuesConfig, isAdminVenue, refreshRegistry, getMuxAuthForVenue, MEMBERS_KEY, freshVenues, LOGINS_KEY, EDITS_KEY, accountLogins } from './_venues.js';
import { readAssignments, readPlans, stripeClient, accountTypeOf, DISCOUNTS_KEY, assignKey } from './_billing.js';
import { unpaidKey, readUnpaid } from './_suspend.js';
import { thumbnailPrefix } from './_thumbnails.js';
import { Resend } from 'resend';
import { accessInviteEmail, mailFrom } from './_emails.js';

// Resend's latest event for one email: sent, delivered, delivery_delayed, bounced, complained…
// waited for up to ms while it is still only "sent" or "queued"
async function deliveryOf(resend, id, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const ev = await resend.emails.get(id).then(x => x?.data?.last_event || null).catch(() => null);
    if ((ev && ev !== 'sent' && ev !== 'queued') || Date.now() >= end) return ev;
    await new Promise(r => setTimeout(r, 1500));
  }
}

// Admin only (local / assets): every client account, and what can be done to it.
//   GET                                   the accounts, each with its plan and status
//   POST { action: 'pause', slug }         paused by local / assets: uploads, clips, recording and publishing stop
//   POST { action: 'resume', slug }        running again
//   POST { action: 'cancel', slug }        the plan ends at the end of its paid month (or its minimum term)
//   POST { action: 'keep', slug }          a cancelled plan carries on
//   POST { action: 'discount', slug, percent }   a discount (0–100%) on its usage prices, from its next bill
//   (a new account is opened from Accounts → New account through api/billing.js openAccount)
//   POST { action: 'emailExample', to, kind?, slug? }   the access email (artist, or kind 'team'), as an example
//   POST { action: 'addLogin', slug, email }      a person signs in to the whole account; they get the access email
//   POST { action: 'removeLogin', slug, email }   an added login stops working (the account's own emails stay)
//   POST { action: 'delete', slug, confirm: slug }   deleted everywhere: plan cancelled now, every video and
//        camera in its video storage, its files, records and artist access. Run again if it says more is left.

export const config = { maxDuration: 300 };

const ADMIN_PAUSE = 'admin_pause';   // the pause entry, beside unpaid invoices (api/_suspend.js)
const KEYS = [
  'account_type', 'billing_assign', 'billing_customer', 'billing_status', 'billing_unpaid',
  'brand_file_label', 'brand_hidden_owners', 'brand_label_artist', 'brand_org_name', 'brand_org_type',
  'brand_owner_names', 'brand_owner_photo', 'brand_watermark', 'brand_video_wm', 'calendar_url',
  'cam_cmds', 'cam_relay_key', 'cam_relay_seen', 'cameras', 'contacts', 'sc_tokens', 'session_meta',
  'v_failed', 'v_intake', 'v_jobs', 'v_orig', 'v_ready', 'wm_marked', 'wm_raw', 'wm_swaps', 'youtube_token',
];
const admins = () => (process.env.BILLING_ADMINS || 'info@local-assets.com').split(/[\s,]+/).map(s => s.toLowerCase()).filter(Boolean);

async function withRedis(fn) {
  const redis = createClient({ url: process.env.REDIS_URL });
  await redis.connect();
  try { return await fn(redis); } finally { await redis.quit().catch(() => {}); }
}

const mux = (auth, path, opts = {}) => fetch('https://api.mux.com' + path, { ...opts, headers: { Authorization: auth, ...(opts.headers || {}) }, signal: AbortSignal.timeout(20000) });

// Every id in a Mux list (assets or live streams), page by page
async function muxIds(auth, kind) {
  const ids = [];
  for (let page = 1; page <= 50; page++) {
    const r = await mux(auth, `/video/v1/${kind}?limit=100&page=${page}`);
    if (!r.ok) throw new Error(`video storage answered ${r.status}`);
    const data = (await r.json()).data || [];
    ids.push(...data.map(x => x.id));
    if (data.length < 100) break;
  }
  return ids;
}

// The plan's Stripe subscription, if it has one
async function subscriptionOf(redis, slug) {
  const a = (await readAssignments(redis, slug)).venue || {};
  return a.subscriptionId || getVenuesConfig()[slug]?.subscription || '';
}

async function blobFiles(prefixes) {
  const urls = [];
  for (const prefix of prefixes) {
    let cursor;
    do {
      const page = await list({ prefix, cursor, limit: 1000 });
      urls.push(...page.blobs.map(b => b.url));
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
  }
  return urls;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const session = getWebSessionAuth(req);
  if (!session?.email || !admins().includes(String(session.email).toLowerCase()) || !isAdminVenue(session.venue)) {
    return res.status(403).json({ error: 'Only local / assets can do this. Switch to the local / assets account first.' });
  }
  await freshVenues(2000);   // an account just created (New account) or deleted shows straight away
  const cfg = getVenuesConfig();
  const clients = Object.entries(cfg).filter(([slug, v]) => !isAdminVenue({ slug, ...v }));

  try {
    if (req.method === 'GET') {
      const stripe = stripeClient();
      const accounts = await withRedis(async redis => {
        const plans = await readPlans(redis);
        const members = await redis.hGetAll(MEMBERS_KEY).catch(() => ({}));
        const discounts = await redis.hGetAll(DISCOUNTS_KEY).catch(() => ({}));
        return Promise.all(clients.map(async ([slug, v]) => {
          const unpaid = await readUnpaid(redis, slug);
          const asg = (await readAssignments(redis, slug)).venue || {};
          const subId = await subscriptionOf(redis, slug);
          let sub = null;
          if (stripe && subId) sub = await stripe.subscriptions.retrieve(subId).catch(() => null);
          const ends = sub && (sub.cancel_at || (sub.cancel_at_period_end ? (sub.current_period_end || sub.items?.data?.[0]?.current_period_end) : 0));
          const artists = Object.values(members || {}).reduce((n, raw) => { try { return n + JSON.parse(raw).filter(m => m.slug === slug).length; } catch { return n; } }, 0);
          return {
            slug, name: v.name || slug, logins: accountLogins(slug, v), type: await accountTypeOf(redis, slug).catch(() => v.type || 'venue'),
            email: asg.email || v.email || '', plan: (plans.find(p => p.id === asg.plan) || {}).name || asg.plan || '', planId: asg.plan || '',
            paused: unpaid.some(i => i.id === ADMIN_PAUSE), unpaid: unpaid.filter(i => i.id !== ADMIN_PAUSE && i.target === 'venue').map(i => i.number || i.id),
            subscription: sub ? sub.status : subId ? 'unknown' : 'none', endsAt: ends ? ends * 1000 : null,
            setupPending: v.status === 'pending', artists, video: !!getMuxAuthForVenue({ slug, ...v }), discount: Number(discounts?.[slug]) || 0,
          };
        }));
      });
      accounts.sort((a, b) => a.name.localeCompare(b.name));
      return res.status(200).json({ accounts });
    }
    if (req.method !== 'POST') return res.status(405).end();

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    // An example of the email an artist gets when given access (Brand Kit → Give access), sent to an address
    // typed by local / assets: for one client account (or the first), with one of its artists
    if (body.action === 'emailExample') {
      const to = String(body.to || '').trim().toLowerCase();
      if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(to)) return res.status(400).json({ error: 'Enter the email to send the example to' });
      const key = process.env.LA_RESEND_API_KEY || process.env.RESEND_API_KEY;
      if (!key) return res.status(503).json({ error: 'Email is not set up (no Resend key)' });
      const pick = clients.find(([s]) => s === String(body.slug || '')) || clients[0];
      const account = pick ? (pick[1].name || pick[0]) : 'Your venue';
      const artist = pick ? await withRedis(async r => Object.entries(await r.hGetAll(`brand_owner_names:${pick[0]}`) || {}).filter(([k]) => k.startsWith('artist-')).map(([, v]) => v)[0] || '').catch(() => '') : '';
      const m = accessInviteEmail({ kind: body.kind === 'team' ? 'team' : 'artist', artist: String(artist || 'Artist name').toUpperCase(), account, email: to, example: true });
      const resend = new Resend(key), from = mailFrom();
      const r = await resend.emails.send({ from, replyTo: 'info@local-assets.com', to, subject: m.subject, html: m.html, text: m.text }).catch(e => ({ error: e }));
      if (r?.error) return res.status(502).json({ error: 'Could not send it: ' + (r.error.message || r.error.name || 'email refused') });
      const id = r?.data?.id || null;
      // What Resend knows a few seconds later (delivered, bounced…), and whether the sender's domain is verified
      const status = id ? await deliveryOf(resend, id, 8000) : null;
      const domain = from.split('@')[1].replace(/>$/, '');
      const dom = await resend.domains.list().then(x => (x?.data?.data || x?.data || []).find(d => d.name === domain)).catch(() => null);
      console.log('[admin-accounts] access email example sent by', session.email, '| from', domain, '| id', id, '| status', status, '| domain', dom ? dom.status : 'not in Resend');
      return res.status(200).json({ ok: true, account, artist, id, from, status, domain: dom ? dom.status : 'missing' });
    }
    const slug = String(body.slug || '').trim();
    const entry = clients.find(([s]) => s === slug);
    if (!entry) return res.status(404).json({ error: 'No client account with that name' });
    const venue = { slug, ...entry[1] };
    const name = venue.name || slug;

    // People who sign in to the whole account: added here, each gets the access email saying what they can do
    if (body.action === 'addLogin' || body.action === 'removeLogin') {
      const email = String(body.email || '').trim().toLowerCase();
      if (!/^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i.test(email)) return res.status(400).json({ error: 'Enter a valid email' });
      const own = accountLogins(slug, venue).filter(l => !l.added).map(l => l.email);
      if (body.action === 'removeLogin' && own.includes(email)) return res.status(400).json({ error: 'This email is part of the account\'s own setup and can\'t be removed here.' });
      const list = await withRedis(async r => {
        let cur = []; try { cur = JSON.parse(await r.hGet(LOGINS_KEY, slug) || '[]'); } catch {}
        cur = cur.filter(e => e !== email);
        if (body.action === 'addLogin' && !own.includes(email)) cur.push(email);
        cur.length ? await r.hSet(LOGINS_KEY, slug, JSON.stringify(cur)) : await r.hDel(LOGINS_KEY, slug);
        await refreshRegistry(r);
        return cur;
      });
      let emailed = false, emailError = null, emailId = null, delivery = null;
      if (body.action === 'addLogin') {
        const key = process.env.LA_RESEND_API_KEY || process.env.RESEND_API_KEY;
        if (key) {
          const m = accessInviteEmail({ kind: 'team', account: name, email });
          const resend = new Resend(key);
          const r = await resend.emails.send({ from: mailFrom(), replyTo: 'info@local-assets.com', to: email, subject: m.subject, html: m.html, text: m.text }).catch(e => ({ error: e }));
          emailed = !r?.error;
          if (r?.error) { console.error('[admin-accounts] access email', slug, r.error.message || r.error); emailError = r.error.message || r.error.name || 'refused'; }
          // What Resend knows a few seconds later: delivered, bounced, suppressed…
          else if (r?.data?.id) { emailId = r.data.id; delivery = await deliveryOf(resend, emailId, 8000); console.log('[admin-accounts] access email', slug, 'id', emailId, 'status', delivery); }
        }
      }
      console.log('[admin-accounts]', body.action, slug, 'by', session.email);
      return res.status(200).json({ ok: true, logins: accountLogins(slug, venue), added: list.length, emailed, emailError, emailId, delivery });
    }
    // Accounts → Edit: the name, the type, the plan (when it isn't billed through Stripe) and the billing email
    if (body.action === 'edit') {
      const newName = String(body.name || '').replace(/[<>\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (!newName) return res.status(400).json({ error: 'Type the account name' });
      const type = ['venue', 'label', 'artist', 'management'].includes(body.type) ? body.type : null;
      const billEmail = String(body.billingEmail || '').trim().toLowerCase();
      if (billEmail && !/^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i.test(billEmail)) return res.status(400).json({ error: 'Enter a valid billing email' });
      const out = await withRedis(async r => {
        const asg = (await readAssignments(r, slug)).venue || null;
        const planId = body.plan === undefined ? null : String(body.plan || '');
        const billed = planId !== null && !!(await subscriptionOf(r, slug));
        // Checked before anything is saved
        if (billed && planId !== (asg?.plan || '')) return { error: `${name}'s plan is billed through Stripe: change it there, or cancel it first.` };
        if (planId && !billed && !(await readPlans(r)).some(p => p.id === planId)) return { error: 'Unknown plan' };
        await r.hSet(EDITS_KEY, slug, JSON.stringify({ name: newName.toUpperCase() }));
        await r.set(`brand_org_name:${slug}`, newName);
        if (type) await r.set(`brand_org_type:${slug}`, type);
        if (planId !== null && !billed) {
          // No plan: the billing details are kept for later
          if (!planId) { if (asg) await r.hSet(assignKey(slug), 'venue', JSON.stringify({ ...asg, plan: '' })); }
          else {
            const first = accountLogins(slug, venue)[0]?.email || '';
            await r.hSet(assignKey(slug), 'venue', JSON.stringify({ ...(asg || { name: '', monthly: true }), plan: planId, email: billEmail || asg?.email || first }));
          }
        }
        const now = (await readAssignments(r, slug)).venue;
        if (billEmail && now && now.email !== billEmail) await r.hSet(assignKey(slug), 'venue', JSON.stringify({ ...now, email: billEmail }));
        await refreshRegistry(r);
        return {};
      });
      if (out.error) return res.status(400).json({ error: out.error });
      console.log('[admin-accounts] edit', slug, 'by', session.email);
      return res.status(200).json({ ok: true });
    }
    if (body.action === 'pause' || body.action === 'resume') {
      await withRedis(r => body.action === 'pause'
        ? r.hSet(unpaidKey(slug), ADMIN_PAUSE, JSON.stringify({ target: 'venue', number: '', url: null, admin: true, at: new Date().toISOString(), by: session.email }))
        : r.hDel(unpaidKey(slug), ADMIN_PAUSE));
      console.log('[admin-accounts]', body.action, slug, 'by', session.email);
      return res.status(200).json({ ok: true, paused: body.action === 'pause' });
    }

    if (body.action === 'discount') {
      const pct = Math.round(Number(body.percent) * 10) / 10;
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) return res.status(400).json({ error: 'Enter a discount from 0 to 100%' });
      await withRedis(async r => {
        if (pct > 0) await r.hSet(DISCOUNTS_KEY, slug, String(pct)); else await r.hDel(DISCOUNTS_KEY, slug);
        // The billing overview is worked out again with it
        const keys = []; for await (const b of r.scanIterator({ MATCH: 'billing_overview:*', COUNT: 200 })) keys.push(...[].concat(b));
        if (keys.length) await r.del(keys);
      });
      console.log('[admin-accounts] discount', slug, pct + '%', 'by', session.email);
      return res.status(200).json({ ok: true, discount: pct });
    }

    if (body.action === 'cancel' || body.action === 'keep') {
      const stripe = stripeClient();
      const subId = await withRedis(r => subscriptionOf(r, slug));
      if (!stripe || !subId) return res.status(400).json({ error: `${name} has no plan in Stripe to ${body.action === 'cancel' ? 'cancel' : 'keep'}.` });
      const cur = await stripe.subscriptions.retrieve(subId);
      const ce = cur.metadata?.commitEnd ? Math.floor(Date.parse(cur.metadata.commitEnd + 'T23:59:59Z') / 1000) : 0;
      const sub = await stripe.subscriptions.update(subId, body.action === 'cancel'
        ? (ce > Date.now() / 1000 ? { cancel_at: ce } : { cancel_at_period_end: true })
        : { cancel_at_period_end: false, cancel_at: '' });
      const end = sub.cancel_at || (sub.cancel_at_period_end ? (sub.current_period_end || sub.items?.data?.[0]?.current_period_end) : 0);
      console.log('[admin-accounts]', body.action, slug, subId, 'by', session.email);
      return res.status(200).json({ ok: true, endsAt: end ? end * 1000 : null });
    }

    if (body.action === 'delete') {
      if (body.confirm !== slug) return res.status(400).json({ error: 'Type the account name exactly to confirm' });
      const done = { plan: null, videos: 0, cameras: 0, files: 0, records: 0, artists: 0, left: 0, notes: [] };

      // 1. The plan stops now (no further charges); paid invoices stay in Stripe for the accounts
      const stripe = stripeClient();
      const subId = await withRedis(r => subscriptionOf(r, slug));
      if (stripe && subId) {
        const sub = await stripe.subscriptions.retrieve(subId).catch(() => null);
        if (sub && sub.status !== 'canceled') { await stripe.subscriptions.cancel(subId); done.plan = 'cancelled'; }
      }

      // 2. Every video and camera in its own video storage (never one another account also uses)
      const auth = getMuxAuthForVenue(venue);
      const shared = auth && clients.some(([s, v]) => s !== slug && getMuxAuthForVenue({ slug: s, ...v }) === auth);
      if (auth && shared) done.notes.push('Its video storage is also used by another account, so no videos were deleted.');
      else if (auth) {
        const stopAt = Date.now() + 200e3;   // leave time for the rest; what's left goes on the next run
        for (const kind of ['live-streams', 'assets']) {
          let ids = [];
          try { ids = await muxIds(auth, kind); } catch (e) { done.notes.push(`Could not list its ${kind === 'assets' ? 'videos' : 'cameras'}: ${e.message}`); continue; }
          for (let i = 0; i < ids.length; i += 10) {
            if (Date.now() > stopAt) { done.left += ids.length - i; break; }
            const r = await Promise.all(ids.slice(i, i + 10).map(id => mux(auth, `/video/v1/${kind}/${id}`, { method: 'DELETE' }).then(x => x.ok || x.status === 404).catch(() => false)));
            const n = r.filter(Boolean).length;
            if (kind === 'assets') done.videos += n; else done.cameras += n;
            done.left += r.length - n;
          }
        }
      }
      if (done.left) {
        console.log('[admin-accounts] delete', slug, 'partly:', JSON.stringify(done));
        return res.status(200).json({ deleted: false, more: true, ...done });
      }

      // 3. Its files (only under its own folders: the file store is shared with other projects)
      const files = await blobFiles([`brand/${slug}/`, thumbnailPrefix(slug), `watermarks/${slug}/`]);
      for (let i = 0; i < files.length; i += 500) await del(files.slice(i, i + 500));
      done.files = files.length;

      // 4. Its records, artists' access to it, its sign-up entry; then it no longer logs in or shows anywhere
      await withRedis(async redis => {
        const keys = new Set();
        for (const k of KEYS) if (await redis.exists(`${k}:${slug}`)) keys.add(`${k}:${slug}`);
        for await (const batch of redis.scanIterator({ MATCH: `*:${slug}:*`, COUNT: 500 })) for (const k of [].concat(batch)) keys.add(k);
        let streams = [];
        try { streams = JSON.parse(await redis.get(`cameras:${slug}`) || '[]').map(c => c.streamId).filter(Boolean); } catch {}
        for (const id of streams) if (await redis.exists(`cam_sched:${id}`)) keys.add(`cam_sched:${id}`);
        if (keys.size) await redis.del([...keys]);
        done.records = keys.size;
        const members = await redis.hGetAll(MEMBERS_KEY).catch(() => ({}));
        for (const [email, raw] of Object.entries(members || {})) {
          let l = []; try { l = JSON.parse(raw); } catch {}
          const keep = l.filter(m => m.slug !== slug);
          if (keep.length === l.length) continue;
          done.artists += l.length - keep.length;
          if (keep.length) await redis.hSet(MEMBERS_KEY, email, JSON.stringify(keep)); else await redis.hDel(MEMBERS_KEY, email);
        }
        await redis.hDel('la_venues', slug);
        await redis.hDel(DISCOUNTS_KEY, slug);
        await redis.hDel(LOGINS_KEY, slug);
        await redis.hDel(EDITS_KEY, slug);
        await redis.sAdd('la_deleted', slug);
        await refreshRegistry(redis);
      });
      console.log('[admin-accounts] deleted', slug, 'by', session.email, JSON.stringify(done));
      return res.status(200).json({ deleted: true, ...done });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    console.error('[admin-accounts]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
