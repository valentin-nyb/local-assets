import { list, del } from '@vercel/blob';
import { createClient } from 'redis';
import { getWebSessionAuth, getVenuesConfig, isAdminVenue, refreshRegistry, getMuxAuthForVenue, MEMBERS_KEY, freshVenues } from './_venues.js';
import { readAssignments, readPlans, stripeClient, accountTypeOf, DISCOUNTS_KEY } from './_billing.js';
import { unpaidKey, readUnpaid } from './_suspend.js';
import { thumbnailPrefix } from './_thumbnails.js';
import { Resend } from 'resend';
import { accessInviteEmail, mailFrom } from './_emails.js';

// Admin only (local / assets): every client account, and what can be done to it.
//   GET                                   the accounts, each with its plan and status
//   POST { action: 'pause', slug }         paused by local / assets: uploads, clips, recording and publishing stop
//   POST { action: 'resume', slug }        running again
//   POST { action: 'cancel', slug }        the plan ends at the end of its paid month (or its minimum term)
//   POST { action: 'keep', slug }          a cancelled plan carries on
//   POST { action: 'discount', slug, percent }   a discount (0–100%) on its usage prices, from its next bill
//   (a new account is opened from Accounts → New account through api/billing.js openAccount)
//   POST { action: 'emailExample', to, slug? }   the artist-access email, as an example, to that address
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
            slug, name: v.name || slug, type: await accountTypeOf(redis, slug).catch(() => v.type || 'venue'),
            email: asg.email || v.email || '', plan: (plans.find(p => p.id === asg.plan) || {}).name || asg.plan || '',
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
      const m = accessInviteEmail({ artist: String(artist || 'Artist name').toUpperCase(), account, email: to, example: true });
      const r = await new Resend(key).emails.send({ from: mailFrom(), replyTo: 'info@local-assets.com', to, subject: m.subject, html: m.html, text: m.text }).catch(e => ({ error: e }));
      if (r?.error) return res.status(502).json({ error: 'Could not send it: ' + (r.error.message || r.error.name || 'email refused') });
      console.log('[admin-accounts] access email example sent by', session.email);
      return res.status(200).json({ ok: true, account, artist });
    }
    const slug = String(body.slug || '').trim();
    const entry = clients.find(([s]) => s === slug);
    if (!entry) return res.status(404).json({ error: 'No client account with that name' });
    const venue = { slug, ...entry[1] };
    const name = venue.name || slug;

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
