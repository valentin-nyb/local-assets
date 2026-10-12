import Stripe from 'stripe';
import { kv } from '@vercel/kv';
import { Resend } from 'resend';
import crypto from 'crypto';
import { createClient } from 'redis';
import { readRegistryRaw, saveRegistryEntry, getVenuesConfig } from './_venues.js';

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

  // ── PLAN CHOSEN FROM THE BILLING PAGE (no subscription before) ─────
  if (event.type === 'checkout.session.completed' && event.data.object.metadata?.kind === 'upgrade') {
    const cs = event.data.object, slug = cs.metadata.venueSlug;
    const redis = createClient({ url: process.env.REDIS_URL });
    try {
      await redis.connect();
      const prev = JSON.parse(await redis.hGet(`billing_assign:${slug}`, 'venue') || '{}');
      await redis.hSet(`billing_assign:${slug}`, 'venue', JSON.stringify({ ...prev, plan: cs.metadata.tier, email: prev.email || cs.customer_details?.email || '', monthly: true, subscription: true, subscriptionId: cs.subscription }));
      if (cs.customer) await redis.set(`billing_customer:${slug}`, cs.customer);
      console.log('[Stripe Webhook] plan started', slug, cs.metadata.tier);
    } catch (e) { console.error('[Stripe Webhook] upgrade', e.message); }
    finally { await redis.quit().catch(() => {}); }
    return res.status(200).json({ received: true });
  }

  // ── SIGN-UP FROM THE HOME PAGE → NEW CLIENT ACCOUNT ────────────────
  if (event.type === 'checkout.session.completed' && event.data.object.metadata?.kind === 'signup') {
    try { await createClientAccount(event.data.object); }
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

  if (process.env.RESEND_API_KEY) {
    const a = order.address || {};
    const esc = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    try {
      await new Resend(process.env.RESEND_API_KEY).emails.send({
        from: 'local/assets™ <noreply@local-assets.com>',
        to: process.env.ORDERS_EMAIL || 'info@local-assets.com',
        subject: `Camera order: ${quantity} × OBSBOT Tail 2 (${order.venueSlug || order.email})`,
        html: `<div style="font-family:monospace;font-size:13px;line-height:1.6">
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

// ── CLIENT LOGIN INSTRUCTIONS ────────────────────────────────────────
// A paid sign-up becomes a client account: login for the paying email, account type and name,
// its plan for usage billing, and a "finish setup" task for local / assets (its Mux environment).
async function createClientAccount(session) {
  const m = session.metadata || {};
  const email = (session.customer_details?.email || session.customer_email || '').toLowerCase().trim();
  const name = String(m.accountName || '').trim() || email;
  const type = ['venue', 'label', 'artist'].includes(m.accountType) ? m.accountType : 'venue';
  const base = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'client';
  const redis = createClient({ url: process.env.REDIS_URL });
  await redis.connect();
  try {
    const existing = { ...getVenuesConfig(), ...(await readRegistryRaw(redis)) };
    // Same email and name paying again (e.g. a second checkout): keep the one account
    const same = Object.entries(existing).find(([, v]) => (v.emails || []).map(String).includes(email) && String(v.name || '').toLowerCase() === name.toLowerCase());
    let slug = same ? same[0] : base;
    for (let i = 2; !same && existing[slug]; i++) slug = `${base}-${i}`;
    if (!same) {
      await saveRegistryEntry(redis, slug, {
        name: name.toUpperCase(), emails: [email], type, plan: m.tier || '', status: 'pending',
        stripeCustomer: session.customer || '', subscription: session.subscription || '', createdAt: new Date().toISOString(),
      });
      // The Brand Kit starts as this account's type and name
      await redis.set(`brand_org_type:${slug}`, type);
      await redis.set(`brand_org_name:${slug}`, name);
      // Usage above the plan is invoiced monthly; the plan itself is the Stripe subscription
      await redis.hSet(`billing_assign:${slug}`, 'venue', JSON.stringify({ plan: m.tier || '', email, name, monthly: true, subscription: true, subscriptionId: session.subscription || '' }));
      if (session.customer) await redis.set(`billing_customer:${slug}`, session.customer);
    }
    console.log('[Stripe Webhook] client account', same ? 'exists' : 'created', slug, type, email);
    if (process.env.RESEND_API_KEY && !same) {
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from: 'local / assets <noreply@local-assets.com>', to: process.env.ORDERS_EMAIL || 'info@local-assets.com',
        subject: `New client: ${name} (${type}) · finish setup`,
        html: `<p><b>${name}</b> (${type}) signed up for ${m.tierName || m.tier} with ${email}.</p><p>Create their Mux environment, then paste its access token in <a href="https://local-assets.com/billing">Billing → Finish setup</a> (signed in to local / assets).</p>`,
      }).catch(e => console.error('[Stripe Webhook] admin email', e.message));
      await resend.emails.send({
        from: 'local / assets <noreply@local-assets.com>', to: email,
        subject: 'Welcome to local / assets',
        html: `<div style="font-family:Helvetica,Arial,sans-serif;background:#050505;color:#fff;padding:40px;max-width:520px"><p style="color:#39FF14;font-size:11px;letter-spacing:.3em;text-transform:uppercase">local / assets</p><h2>Welcome, ${name}</h2><p style="color:#aaa;line-height:1.6">Your account is ready. Sign in with Google using this email (${email}) to set up your Brand Kit. We're preparing your private video storage and will let you know as soon as recordings can be uploaded.</p><a href="https://local-assets.com/login.html" style="display:inline-block;background:#39FF14;color:#000;padding:12px 28px;text-decoration:none;font-weight:bold">Sign in</a></div>`,
      }).catch(e => console.error('[Stripe Webhook] welcome email', e.message));
    }
  } finally { await redis.quit().catch(() => {}); }
}

async function sendGoogleLoginNotice(email) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY not set');

  const resend = new Resend(apiKey);
  const link = 'https://local-assets.com/client.html';

  await resend.emails.send({
    from: 'local/assets™ <noreply@local-assets.com>',
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
