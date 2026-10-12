import Stripe from 'stripe';
import { createClient } from 'redis';
import { readPlans } from './_billing.js';

// Sign-up from the home page: a tier, the account type (venue, record label or artist) and its name.
// Stripe takes the monthly plan as a subscription; the account is created when payment completes
// (api/stripe-webhook.js), and local / assets finishes its video storage setup.
const TYPES = ['venue', 'label', 'artist'];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://local-assets.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const sk = process.env.LA_STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY;
  if (!sk) return res.status(503).json({ error: 'payments_not_configured' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch {} }
  const accountType = TYPES.includes(body?.accountType) ? body.accountType : null;
  const accountName = String(body?.accountName || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60);
  if (!accountType || !accountName) return res.status(400).json({ error: 'Choose the account type and enter its name' });

  const redis = createClient({ url: process.env.REDIS_URL });
  let plan;
  try { await redis.connect(); plan = (await readPlans(redis)).find(p => p.id === body?.tier); }
  finally { await redis.quit().catch(() => {}); }
  if (!plan || !(plan.price > 0)) return res.status(400).json({ error: 'Unknown plan' });

  try {
    const stripe = new Stripe(sk);
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'gbp', unit_amount: Math.round(plan.price * 100), tax_behavior: 'exclusive',
          recurring: { interval: 'month' },
          product_data: { name: `local / assets · ${plan.name}` },
        },
      }],
      success_url: 'https://local-assets.com/?signup=success',
      cancel_url: 'https://local-assets.com/?signup=cancelled',
      allow_promotion_codes: true,
      billing_address_collection: 'required',
      metadata: { kind: 'signup', tier: plan.id, tierName: plan.name, accountType, accountName },
      subscription_data: { metadata: { kind: 'signup', tier: plan.id, accountType, accountName } },
    });
    return res.status(200).json({ url: session.url });
  } catch (e) {
    console.error('[create-checkout]', e.message);
    return res.status(502).json({ error: e.message });
  }
}
