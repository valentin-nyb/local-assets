import Stripe from 'stripe';
import { kv } from '@vercel/kv';
import { Resend } from 'resend';
import crypto from 'crypto';

// Vercel: disable body parsing so we get raw bytes for signature verification
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('POST only');

  const sk = process.env.STRIPE_SECRET_KEY;
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

    // Send magic link email
    try {
      await sendMagicLink(email);
      console.log(`[Stripe Webhook] Magic link sent to ${email}`);
    } catch (e) {
      console.error('[Stripe Webhook] Failed to send magic link:', e.message);
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

// ── MAGIC LINK HELPER ────────────────────────────────────────────────
async function sendMagicLink(email) {
  const token = crypto.randomBytes(32).toString('hex');
  await kv.set(`magic:${token}`, email, { ex: 3600 }); // 1 hour expiry

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY not set');

  const resend = new Resend(apiKey);
  const link = `https://localassets.tv/api/verify-magic-link?token=${token}`;

  await resend.emails.send({
    from: 'local/assets™ <noreply@localassets.tv>',
    to: email,
    subject: 'Your local/assets™ Portal Access',
    html: `
      <div style="font-family:monospace;background:#050505;color:#fff;padding:40px;max-width:500px;">
        <p style="color:#39FF14;font-size:10px;letter-spacing:0.3em;text-transform:uppercase;margin-bottom:24px;">[ local / assets™ ]</p>
        <h2 style="font-size:20px;margin-bottom:16px;">Welcome to your Asset Portal</h2>
        <p style="color:#aaa;font-size:13px;line-height:1.6;margin-bottom:24px;">Click below to access your client dashboard where you can view, upload, and manage your assets.</p>
        <a href="${link}" style="display:inline-block;background:#39FF14;color:#000;padding:12px 32px;text-decoration:none;font-weight:bold;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;">ACCESS PORTAL</a>
        <p style="color:#666;font-size:11px;margin-top:24px;">This link expires in 1 hour.</p>
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
