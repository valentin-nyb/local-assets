import './_report.js';   // errors go to Rollbar
import { createClient } from 'redis';
import { stripeClient } from './_billing.js';

// Where Stripe's card page sends people back (card-saved.html): the card becomes the payment card of the account
// it was saved for. No sign-in needed (the card page opens in the browser even from a™, where nobody may be
// signed in): Stripe's checkout id is the proof, and it is checked to be a finished card setup from our card
// page, for the Stripe customer that account already has.
//   POST { session: 'cs_…' }   → { ok, account }
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const cs = String(body.session || '');
  const stripe = stripeClient();
  if (!stripe || !/^cs_(test|live)_\w{10,}$/.test(cs)) return res.status(400).json({ error: 'Which card?' });
  const checkout = await stripe.checkout.sessions.retrieve(cs, { expand: ['setup_intent'] }).catch(() => null);
  const slug = checkout?.metadata?.venueSlug || '';
  if (!checkout || checkout.mode !== 'setup' || checkout.metadata?.kind !== 'card' || !slug) return res.status(404).json({ error: 'This isn\'t a card saved for local / assets™' });
  const redis = createClient({ url: (process.env.UPSTASH_REDIS_URL || process.env.REDIS_URL) });
  let mine = null;
  try { await redis.connect(); mine = await redis.get(`billing_customer:${slug}`); } finally { await redis.quit().catch(() => {}); }
  if (!mine || checkout.customer !== mine) return res.status(404).json({ error: 'This isn\'t a card saved for local / assets™' });
  const pm = checkout.setup_intent?.status === 'succeeded' ? checkout.setup_intent.payment_method : null;
  if (!pm) return res.status(409).json({ error: 'Stripe hasn\'t finished saving the card yet' });
  try {
    await stripe.customers.update(mine, { invoice_settings: { default_payment_method: typeof pm === 'object' ? pm.id : pm } });
  } catch (e) {
    console.error('[card-saved] could not set the card', slug, e.message);
    return res.status(502).json({ error: 'Stripe didn\'t take the card as the payment card. Try again from Billing.' });
  }
  console.log('[card-saved] card saved', slug);
  return res.status(200).json({ ok: true });
}
