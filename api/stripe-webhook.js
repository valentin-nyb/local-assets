import Stripe from 'stripe';
import { kv } from '@vercel/kv';
import { Resend } from 'resend';
import crypto from 'crypto';
import { createClient } from 'redis';
import { readRegistryRaw, saveRegistryEntry, getVenuesConfig } from './_venues.js';
import { activateFromPool, poolSize } from './_mux-pool.js';
import { welcomeEmail, mailFrom } from './_emails.js';

// Vercel: disable body parsing so we get raw bytes for signature verification
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('POST only');

  const sk = (process.env.LA_STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY);   // local / assets own Stripe account first, else the Vercel integration
  const whSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!sk || !whSecret) return res.status(500).json({ error: 'Missing Stripe env vars' });

  const stripe = new Stripe(sk);

  // Read raw body for signature verification
  const buf = await buffer(req);
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(buf, sig, whSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // ── PLAN CHANGE PAID LATER: the card was declined or needed confirming when the plan was changed
  // (api/billing.js changePlan), so the switch waited; now its invoice is paid, Stripe applies it and so do we ─
  // (newer Stripe API versions name the subscription under parent.subscription_details)
  const paidSub = event.type === 'invoice.paid' ? (event.data.object.subscription || event.data.object.parent?.subscription_details?.subscription) : null;
  if (paidSub) {
    const subId = typeof paidSub === 'string' ? paidSub : paidSub.id;
    const redis = createClient({ url: process.env.REDIS_URL });
    try {
      await redis.connect();
      const pending = JSON.parse(await redis.get(`billing_pending_plan:${subId}`) || 'null');
      if (pending?.slug) {
        await stripe.subscriptions.update(subId, { metadata: pending.metadata || {} }).catch(e => console.error('[Stripe Webhook] pending plan metadata', e.message));
        const prev = JSON.parse(await redis.hGet(`billing_assign:${pending.slug}`, 'venue') || '{}');
        await redis.hSet(`billing_assign:${pending.slug}`, 'venue', JSON.stringify({ ...prev, plan: pending.plan, subscription: true, subscriptionId: subId }));
        await redis.del(`billing_pending_plan:${subId}`);
        console.log('[Stripe Webhook] plan changed after payment', pending.slug, pending.plan);
      }
    } catch (e) { console.error('[Stripe Webhook] pending plan', e.message); }
    finally { await redis.quit().catch(() => {}); }
    if (!event.data.object.metadata?.venueSlug) return res.status(200).json({ received: true });
  }

  // ── USAGE INVOICES: paid lifts a pause; written off as uncollectible pauses the account ─
  if ((event.type === 'invoice.paid' || event.type === 'invoice.marked_uncollectible') && event.data.object.metadata?.venueSlug) {
    const inv = event.data.object, slug = inv.metadata.venueSlug;
    const redis = createClient({ url: process.env.REDIS_URL });
    try {
      await redis.connect();
      if (event.type === 'invoice.paid') {
        await redis.hDel(`billing_unpaid:${slug}`, inv.id);
        await redis.hSet(`billing_status:${slug}`, inv.id, 'paid');
      } else {
        await redis.hSet(`billing_unpaid:${slug}`, inv.id, JSON.stringify({ target: inv.metadata.target || 'venue', number: inv.number || '', url: inv.hosted_invoice_url || '' }));
        await redis.hSet(`billing_status:${slug}`, inv.id, 'unpaid');
      }
    } catch (e) { console.error('[Stripe Webhook] invoice status', e.message); }
    finally { await redis.quit().catch(() => {}); }
    return res.status(200).json({ received: true });
  }

  // ── CAMERA ORDER (not a subscription — never creates a client profile) ─
  if (event.type === 'checkout.session.completed' && event.data.object.metadata?.kind === 'camera_order') {
    await recordCameraOrder(event.data.object, stripe);
    return res.status(200).json({ received: true });
  }

  // ── PTZ CAMERA RENTED (£149/month, 12-month minimum): kept with the account for shipping ─────
  if (event.type === 'checkout.session.completed' && event.data.object.metadata?.kind === 'addon-camera') {
    const cs = event.data.object, slug = cs.metadata.venueSlug;
    const redis = createClient({ url: process.env.REDIS_URL });
    try {
      await redis.connect();
      await redis.hSet(`billing_cameras:${slug}`, cs.subscription || cs.id, JSON.stringify({ at: Date.now(), commitEnd: cs.metadata.commitEnd, email: cs.customer_details?.email || '' }));
      console.log('[Stripe Webhook] PTZ camera rented', slug, cs.subscription);
    } catch (e) { console.error('[Stripe Webhook] camera rental', e.message); }
    finally { await redis.quit().catch(() => {}); }
    return res.status(200).json({ received: true });
  }

  // ── PLAN CHOSEN FROM THE BILLING PAGE (no subscription before) ─────
  if (event.type === 'checkout.session.completed' && event.data.object.metadata?.kind === 'upgrade') {
    const cs = event.data.object, slug = cs.metadata.venueSlug;
    const redis = createClient({ url: process.env.REDIS_URL });
    try {
      await redis.connect();
      const prev = JSON.parse(await redis.hGet(`billing_assign:${slug}`, 'venue') || '{}');
      await redis.hSet(`billing_assign:${slug}`, 'venue', JSON.stringify({ ...prev, plan: cs.metadata.tier, email: prev.email || cs.customer_details?.email || '', monthly: true, subscription: true, subscriptionId: cs.subscription, ...(cs.metadata.trialCredit === '1' ? { trialCredited: true } : {}) }));
      if (cs.customer) await redis.set(`billing_customer:${slug}`, cs.customer);
      console.log('[Stripe Webhook] plan started', slug, cs.metadata.tier);
    } catch (e) { console.error('[Stripe Webhook] upgrade', e.message); }
    finally { await redis.quit().catch(() => {}); }
    return res.status(200).json({ received: true });
  }

  // ── SIGN-UP FROM THE HOME PAGE → NEW CLIENT ACCOUNT ────────────────
  if (event.type === 'checkout.session.completed' && event.data.object.metadata?.kind === 'signup') {
    try { await createClientAccount(event.data.object, stripe); }
    catch (e) { console.error('[Stripe Webhook] signup failed:', e.message); }
    return res.status(200).json({ received: true });
  }

  // ── CHECKOUT COMPLETED → CREATE CLIENT PROFILE ─────────────────────
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = (session.customer_details?.email || session.customer_email || '').toLowerCase().trim();
    const tier = session.metadata?.tier || 'unknown';
    const tierName = session.metadata?.tierName || tier;
    const stripeCustomerId = session.customer;
    const subscriptionId = session.subscription;

    if (!email) {
      console.error('[Stripe Webhook] No email on checkout session:', session.id);
      return res.status(200).json({ received: true, warning: 'no email' });
    }

    console.log(`[Stripe Webhook] checkout.session.completed — ${email} — ${tierName}`);

    // Check if profile already exists
    const existingId = await kv.get(`client:email:${email}`);

    if (existingId) {
      // Update existing profile's subscription info
      await kv.hset(`client:${existingId}`, {
        tier, tierName, stripeCustomerId, subscriptionId,
        updatedAt: new Date().toISOString()
      });
      console.log(`[Stripe Webhook] Updated existing client: ${existingId}`);
    } else {
      // Create new client profile
      const clientId = 'cl_' + crypto.randomBytes(12).toString('hex');
      const profile = {
        id: clientId,
        email,
        tier,
        tierName,
        stripeCustomerId,
        subscriptionId,
        createdAt: new Date().toISOString(),
        status: 'active',
        assets: '[]'
      };

      await kv.hset(`client:${clientId}`, profile);
      await kv.set(`client:email:${email}`, clientId);
      if (stripeCustomerId) {
        await kv.set(`client:stripe:${stripeCustomerId}`, clientId);
      }
      console.log(`[Stripe Webhook] Created new client: ${clientId} for ${email}`);
    }

    // Send client portal sign-in instructions
    try {
      await sendGoogleLoginNotice(email);
      console.log(`[Stripe Webhook] Google login instructions sent to ${email}`);
    } catch (e) {
      console.error('[Stripe Webhook] Failed to send Google login instructions:', e.message);
    }
  }

  // ── SUBSCRIPTION CANCELLED ─────────────────────────────────────────
  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    const customerId = sub.customer;
    const clientId = await kv.get(`client:stripe:${customerId}`);
    if (clientId) {
      await kv.hset(`client:${clientId}`, { status: 'cancelled', cancelledAt: new Date().toISOString() });
      console.log(`[Stripe Webhook] Subscription cancelled for client: ${clientId}`);
    }
  }

  return res.status(200).json({ received: true });
}

// ── CAMERA ORDERS ────────────────────────────────────────────────────
// Kept in Redis (camera_orders) and emailed to the team; Stripe also lists them under Payments.
async function recordCameraOrder(session, stripe) {
  let quantity = 1;
  try {
    const items = await stripe.checkout.sessions.listLineItems(session.id, { limit: 5 });
    quantity = items.data.reduce((n, i) => n + (i.quantity || 0), 0) || 1;
  } catch (_) {}
  const ship = session.shipping_details || session.collected_information?.shipping_details || {};
  const order = {
    id: session.id,
    venueSlug: session.metadata?.venueSlug || '',
    email: session.customer_details?.email || session.metadata?.email || '',
    name: ship.name || session.customer_details?.name || '',
    phone: session.customer_details?.phone || '',
    address: ship.address || null,
    quantity,
    total: (session.amount_total || 0) / 100,
    currency: session.currency,
    paymentStatus: session.payment_status,
    rental: session.metadata?.rental === 'yes' ? { startDate: session.metadata.startDate, endDate: session.metadata.endDate, days: Number(session.metadata.days) || 1 } : null,
    createdAt: new Date().toISOString(),
  };
  console.log('[Stripe Webhook] camera order', order.id, order.venueSlug, 'x' + quantity);

  const redis = createClient({ url: process.env.REDIS_URL });
  try {
    await redis.connect();
    await redis.lPush('camera_orders', JSON.stringify(order));
  } catch (e) {
    console.error('[Stripe Webhook] could not store camera order:', e.message);
  } finally {
    await redis.quit().catch(() => {});
  }

  if ((process.env.LA_RESEND_API_KEY || process.env.RESEND_API_KEY)) {
    const a = order.address || {};
    const esc = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    try {
      await new Resend((process.env.LA_RESEND_API_KEY || process.env.RESEND_API_KEY)).emails.send({
        from: mailFrom('noreply', 'local/assets™'),
        to: process.env.ORDERS_EMAIL || 'info@local-assets.com',
        subject: order.rental
          ? `Camera hire: ${quantity} × OBSBOT Tail 2, ${order.rental.days} day${order.rental.days > 1 ? 's' : ''} from ${order.rental.startDate} (${order.venueSlug || order.email})`
          : `Camera order: ${quantity} × OBSBOT Tail 2 (${order.venueSlug || order.email})`,
        html: `<div style="font-family:monospace;font-size:13px;line-height:1.6">
          ${order.rental ? `<p><b>HIRE</b>: ${esc(order.rental.startDate)} to ${esc(order.rental.endDate)} (${order.rental.days} day${order.rental.days > 1 ? 's' : ''}). Deliver the day before, collect the day after.</p>` : ''}
          <p><b>${quantity} × OBSBOT Tail 2</b> — ${esc(order.currency?.toUpperCase())} ${order.total.toFixed(2)} (${esc(order.paymentStatus)})</p>
          <p>Venue: ${esc(order.venueSlug)}<br>Email: ${esc(order.email)}<br>Phone: ${esc(order.phone)}</p>
          <p>Ship to:<br>${esc(order.name)}<br>${[a.line1, a.line2, a.city, a.postal_code, a.country].filter(Boolean).map(esc).join('<br>')}</p>
          <p>Stripe session: ${esc(order.id)}</p></div>`,
      });
    } catch (e) {
      console.error('[Stripe Webhook] order email failed:', e.message);
    }
  }
}

// ── NEW CLIENT ACCOUNT FROM A SIGN-UP ────────────────────────────────
// A paid sign-up becomes a client account: login for the paying email, account type and name, its
// plan for usage billing, the card kept for the usage charged on the 1st, and its video storage
// (a ready Mux environment when there is one; otherwise local / assets finishes it in Billing).
async function saveCardForUsage(stripe, session) {
  if (!session.customer) return null;
  let pm = null;
  try {
    if (session.mode === 'setup' && session.setup_intent) pm = (await stripe.setupIntents.retrieve(session.setup_intent)).payment_method;
    else if (session.mode === 'payment' && session.payment_intent) pm = (await stripe.paymentIntents.retrieve(session.payment_intent)).payment_method;
    else if (session.mode === 'subscription' && session.subscription) pm = (await stripe.subscriptions.retrieve(session.subscription)).default_payment_method;
    pm = pm && typeof pm === 'object' ? pm.id : pm;
    if (pm) await stripe.customers.update(session.customer, { invoice_settings: { default_payment_method: pm } });
  } catch (e) { console.error('[Stripe Webhook] could not save the card', session.id, e.message); }
  return pm;
}

async function createClientAccount(session, stripe) {
  const m = session.metadata || {};
  const email = (session.customer_details?.email || session.customer_email || '').toLowerCase().trim();
  const name = String(m.accountName || '').trim() || email;
  const type = ['venue', 'label', 'artist'].includes(m.accountType) ? m.accountType : 'venue';
  const base = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'client';
  if (!email) { console.error('[Stripe Webhook] sign-up without an email', session.id); return; }
  // Pay as you go chosen (always for plans without a monthly price): usage is charged to the card on the 1st;
  // otherwise usage above the plan is invoiced by email
  const payg = m.payg === '1' || session.mode !== 'subscription';
  const card = payg ? await saveCardForUsage(stripe, session) : null;
  // The invoice details Stripe collected at checkout (billing address is required there)
  const cd = session.customer_details || {}, ad = cd.address || {};
  const details = { legalName: String(cd.name || name).slice(0, 100), line1: ad.line1 || '', line2: ad.line2 || '', city: ad.city || '', postcode: ad.postal_code || '', country: ad.country || 'GB', vat: '' };
  const redis = createClient({ url: process.env.REDIS_URL });
  await redis.connect();
  let slug, same, storage = null, left = 0;
  try {
    const existing = { ...getVenuesConfig(), ...(await readRegistryRaw(redis)) };
    // Same email and name paying again (e.g. a second checkout): keep the one account
    same = Object.entries(existing).find(([, v]) => (v.emails || []).map(String).includes(email) && String(v.name || '').toLowerCase() === name.toLowerCase());
    slug = same ? same[0] : base;
    for (let i = 2; !same && existing[slug]; i++) slug = `${base}-${i}`;
    if (!same) {
      // Only one webhook delivery creates the account
      if (!(await redis.set(`signup_done:${session.id}`, slug, { NX: true, EX: 30 * 86400 }))) { console.log('[Stripe Webhook] sign-up already handled', session.id); return; }
      await saveRegistryEntry(redis, slug, {
        name: name.toUpperCase(), emails: [email], type, plan: m.tier || '', status: 'pending',
        stripeCustomer: session.customer || '', subscription: session.subscription || '', createdAt: new Date().toISOString(),
      });
      // The Brand Kit starts as this account's type and name
      await redis.set(`brand_org_type:${slug}`, type);
      await redis.set(`brand_org_name:${slug}`, name);
      // Usage is invoiced on the 1st (charged to the saved card); a monthly plan itself is the Stripe subscription
      // The Trial Month's join fee (before VAT) comes off the first monthly plan within 30 days: kept with the account
      const trial = m.tier === 'dj-trial' ? { trialFee: Math.round(Number(session.amount_subtotal || 0)) / 100, trialAt: Date.now() } : {};
      await redis.hSet(`billing_assign:${slug}`, 'venue', JSON.stringify({ plan: m.tier || '', email, name, monthly: true, subscription: session.mode === 'subscription', subscriptionId: session.subscription || '', autoCharge: !!card, details, ...trial }));
      if (session.customer) await redis.set(`billing_customer:${slug}`, session.customer);
      storage = await activateFromPool(redis, slug).catch(e => { console.error('[Stripe Webhook] ready storage', e.message); return null; });
      left = await poolSize(redis).catch(() => 0);
    }
    console.log('[Stripe Webhook] client account', same ? 'exists' : 'created', slug, type, m.tier, storage ? 'live' : 'waiting for storage', card ? 'card saved' : 'no card');
  } finally { await redis.quit().catch(() => {}); }

  if (!(process.env.LA_RESEND_API_KEY || process.env.RESEND_API_KEY) || same) return;
  const esc = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const resend = new Resend((process.env.LA_RESEND_API_KEY || process.env.RESEND_API_KEY));
  await resend.emails.send({
    from: mailFrom(), to: process.env.ORDERS_EMAIL || 'info@local-assets.com',
    subject: storage ? `New client: ${name} (${type}) · live` : `New client: ${name} (${type}) · finish setup`,
    html: `<p><b>${esc(name)}</b> (${esc(type)}) signed up for ${esc(m.tierName || m.tier)} with ${esc(email)}.${card ? ' Card saved for usage on the 1st.' : ''}</p>` +
      (storage
        ? `<p>Their account is live on the ready Mux environment <b>${esc(storage)}</b>. ${left} ready environment${left === 1 ? '' : 's'} left${left < 2 ? ': add more in <a href="https://local-assets.com/billing">Billing → Ready video storage</a>' : ''}.</p>`
        : `<p>No ready Mux environment was left. Create one and add it in <a href="https://local-assets.com/billing">Billing → Finish setup</a>.</p>`),
  }).catch(e => console.error('[Stripe Webhook] admin email', e.message));
  // What they paid today and how they're billed from now on
  const paid = (session.amount_total || 0) / 100, money = n => '£' + n.toLocaleString('en-GB', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
  const line = session.mode === 'subscription' ? `${money(paid)} paid today, then billed monthly. ${payg ? 'Pay as you go is on: usage above your plan is charged to your card on the 1st.' : 'Usage above your plan is invoiced on the 1st.'}`
    : session.mode === 'payment' ? `${money(paid)} paid today. After that, pay only for what you use, charged to your card on the 1st.`
    : 'No monthly fee. What you use is charged to your card on the 1st.';
  const mail = welcomeEmail({ name, email, type, plan: { name: m.tierName || m.tier || 'local / assets', line }, ready: !!storage });
  await resend.emails.send({
    from: mailFrom(), to: email, replyTo: 'info@local-assets.com',
    subject: mail.subject, html: mail.html, text: mail.text,
  }).catch(e => console.error('[Stripe Webhook] welcome email', e.message));
}

async function sendGoogleLoginNotice(email) {
  const apiKey = (process.env.LA_RESEND_API_KEY || process.env.RESEND_API_KEY);
  if (!apiKey) throw new Error('RESEND_API_KEY not set');

  const resend = new Resend(apiKey);
  const link = 'https://local-assets.com/client.html';

  await resend.emails.send({
    from: mailFrom('noreply', 'local/assets™'),
    to: email,
    subject: 'Your local/assets™ Client Portal',
    html: `
      <div style="font-family:monospace;background:#050505;color:#fff;padding:40px;max-width:500px;">
        <p style="color:#39FF14;font-size:10px;letter-spacing:0.3em;text-transform:uppercase;margin-bottom:24px;">[ local / assets™ ]</p>
        <h2 style="font-size:20px;margin-bottom:16px;">Welcome to your Asset Portal</h2>
        <p style="color:#aaa;font-size:13px;line-height:1.6;margin-bottom:24px;">Sign in with Google using this email address to access your client dashboard.</p>
        <a href="${link}" style="display:inline-block;background:#39FF14;color:#000;padding:12px 32px;text-decoration:none;font-weight:bold;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;">OPEN CLIENT PORTAL</a>
      </div>
    `
  });
}

// ── RAW BODY READER ──────────────────────────────────────────────────
function buffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
