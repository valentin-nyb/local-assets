import Stripe from 'stripe';
import { createClient } from 'redis';
import { readPlans, planForType, commitEndFor } from './_billing.js';

// Sign-up from the home page: a tier, the account type (venue, record label or artist) and its name.
// Monthly plans are a Stripe subscription; pay as you go saves the card (and takes any sign-up fee,
// e.g. the DJ Trial Month). The account is created when Stripe confirms (api/stripe-webhook.js),
// with ready video storage when there is some (api/_mux-pool.js).
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
  // The old stand-alone pay-as-you-go plan (now a toggle on every plan) can't be signed up for
  if (!plan || plan.id === 'payg') return res.status(400).json({ error: 'Unknown plan' });
  // The Trial Month is for a venue, an artist or a label, and is named for the one signing up
  // ...and its join price is the one for that type: £49 artist, £149 record label, £349 venue
  const TRIAL_FEES = { artist: 49, label: 149, venue: 349 };
  if (plan.id === 'dj-trial') plan = { ...plan, name: ({ venue: 'Venue', artist: 'Artist', label: 'Label' }[accountType] || 'Artist') + ' Trial Month', signupFee: TRIAL_FEES[accountType] || TRIAL_FEES.artist };
  // A monthly plan at the price for this account type (record labels half, artists a quarter of a venue's)
  plan = planForType(plan, accountType);
  const fee = Number(plan.signupFee) > 0 ? Number(plan.signupFee) : 0;

  try {
    const stripe = new Stripe(sk);
    // Pay as you go (usage above the plan charged to the card on the 1st): chosen at sign-up, always on without a monthly price
    const payg = !(plan.price > 0) || body?.payg === true;
    const commitEnd = commitEndFor(plan.id, accountType);   // Live-Set, and Pro with its camera: 12-month minimum
    const metadata = { kind: 'signup', tier: plan.id, tierName: plan.name, accountType, accountName, payg: payg ? '1' : '0', ...(commitEnd ? { commitEnd, minimumMonths: '12' } : {}) };
    const common = {
      success_url: 'https://local-assets.com/?signup=success',
      cancel_url: 'https://local-assets.com/?signup=cancelled',
      billing_address_collection: 'required',
      metadata,
    };
    const feeItem = fee ? [{ quantity: 1, price_data: { currency: 'gbp', unit_amount: Math.round(fee * 100), tax_behavior: 'exclusive', product_data: { name: `local / assets · ${plan.name} · sign-up` } } }] : [];
    let session;
    if (plan.price > 0) {
      // A monthly plan: Stripe subscription (plus any one-off sign-up fee on the first invoice)
      session = await stripe.checkout.sessions.create({ ...common, mode: 'subscription', allow_promotion_codes: true,
        line_items: [{ quantity: 1, price_data: { currency: 'gbp', unit_amount: Math.round(plan.price * 100), tax_behavior: 'exclusive', recurring: { interval: 'month' }, product_data: { name: `local / assets · ${plan.name}` } } }, ...feeItem],
        subscription_data: { metadata } });
    } else if (fee) {
      // Pay as you go with a sign-up fee (the Trial Month): the fee now, and the card is kept for usage on the 1st
      session = await stripe.checkout.sessions.create({ ...common, mode: 'payment', allow_promotion_codes: true, customer_creation: 'always',
        line_items: feeItem, payment_intent_data: { setup_future_usage: 'off_session', metadata },
        invoice_creation: { enabled: true, invoice_data: { description: `local / assets · ${plan.name}`, metadata } } });
    } else {
      // Pay as you go: nothing to pay now, the card is saved for the usage charged on the 1st
      session = await stripe.checkout.sessions.create({ ...common, mode: 'setup', currency: 'gbp', customer_creation: 'always',
        setup_intent_data: { metadata, description: `local / assets · ${plan.name}: usage charged monthly` } });
    }
    return res.status(200).json({ url: session.url });
  } catch (e) {
    console.error('[create-checkout]', e.message);
    return res.status(502).json({ error: e.message });
  }
}
