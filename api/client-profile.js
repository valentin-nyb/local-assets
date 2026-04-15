import { kv } from '@vercel/kv';
import Stripe from 'stripe';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Cookie');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Authenticate via session cookie
  const cookie = parseCookie(req.headers.cookie || '');
  const sessionToken = cookie.la_session;
  if (!sessionToken) return res.status(401).json({ error: 'Not authenticated' });

  const clientId = await kv.get(`session:${sessionToken}`);
  if (!clientId) return res.status(401).json({ error: 'Session expired — please log in again' });

  const profile = await kv.hgetall(`client:${clientId}`);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });

  // If requesting billing portal
  if (req.query.action === 'billing-portal') {
    const sk = process.env.STRIPE_SECRET_KEY;
    if (!sk || !profile.stripeCustomerId) {
      return res.status(400).json({ error: 'Billing not available' });
    }
    const stripe = new Stripe(sk);
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: profile.stripeCustomerId,
      return_url: (req.headers.origin || 'https://localassets.tv') + '/client.html',
    });
    return res.status(200).json({ url: portalSession.url });
  }

  // Return profile (strip sensitive fields)
  const { stripeCustomerId, ...safeProfile } = profile;
  return res.status(200).json(safeProfile);
}

function parseCookie(str) {
  const obj = {};
  if (!str) return obj;
  str.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx < 0) return;
    const key = pair.substring(0, idx).trim();
    const val = pair.substring(idx + 1).trim();
    obj[key] = decodeURIComponent(val);
  });
  return obj;
}
