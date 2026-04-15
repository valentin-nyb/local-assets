import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Replace these with your real Stripe Price IDs from the Dashboard
const TIER_PRICES = {
  'starter-distribution': { priceId: 'price_REPLACE_STARTER_DISTRO', name: 'Starter (Distribution)' },
  'liveset-distribution':  { priceId: 'price_REPLACE_LIVESET_DISTRO', name: 'Live Set (Distribution)' },
  'starter-creative':      { priceId: 'price_REPLACE_STARTER_CREATIVE', name: 'Starter (Creative)' },
  'liveset-creative':      { priceId: 'price_REPLACE_LIVESET_CREATIVE', name: 'Live-Set (Creative)' },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e) {} }

  const tierKey = body?.tier;
  const tier = TIER_PRICES[tierKey];
  if (!tier) return res.status(400).json({ error: 'Invalid tier: ' + tierKey });

  const origin = body?.origin || 'https://localassets.tv';

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: tier.priceId, quantity: 1 }],
      success_url: origin + '/index.html?payment=success&tier=' + tierKey,
      cancel_url: origin + '/index.html?payment=cancelled',
      metadata: { tier: tierKey, tierName: tier.name },
    });

    return res.status(200).json({ url: session.url });
  } catch (error) {
    console.error('Stripe checkout error:', error);
    return res.status(500).json({ error: error.message });
  }
}
