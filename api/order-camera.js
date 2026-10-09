import Stripe from 'stripe';
import { getWebSessionAuth } from './_venues.js';

// Camera orders: OBSBOT Tail 2 sold by local / assets through Stripe Checkout.
// Payment methods (card, Apple Pay, Klarna, …) come from the Stripe dashboard settings,
// so turning on Klarna there is all that's needed for monthly payments.
export const CAMERA_PRODUCT = {
  name: 'OBSBOT Tail 2',
  description: 'AI-powered PTZR 4K live production camera with NDI HX3. Setup and integration with your local / assets dashboard included.',
  unitAmount: 129900, // pence
  currency: 'gbp',
  maxQuantity: 10,
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const session = getWebSessionAuth(req);
  if (!session?.email) return res.status(401).json({ error: 'Not authenticated' });

  const sk = process.env.STRIPE_SECRET_KEY;

  if (req.method === 'GET') {
    return res.status(200).json({
      available: !!sk,
      price: CAMERA_PRODUCT.unitAmount / 100,
      currency: CAMERA_PRODUCT.currency,
      maxQuantity: CAMERA_PRODUCT.maxQuantity,
    });
  }
  if (req.method !== 'POST') return res.status(405).end();
  if (!sk) return res.status(503).json({ error: 'payments_not_configured' });

  const qty = Math.min(Math.max(parseInt(req.body?.quantity, 10) || 1, 1), CAMERA_PRODUCT.maxQuantity);

  try {
    const stripe = new Stripe(sk);
    const checkout = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: session.email,
      line_items: [{
        quantity: qty,
        adjustable_quantity: { enabled: true, minimum: 1, maximum: CAMERA_PRODUCT.maxQuantity },
        price_data: {
          currency: CAMERA_PRODUCT.currency,
          unit_amount: CAMERA_PRODUCT.unitAmount,
          tax_behavior: 'inclusive', // £1,299 includes VAT
          product_data: { name: CAMERA_PRODUCT.name, description: CAMERA_PRODUCT.description, images: ['https://local-assets.com/img/obsbot-tail-2.png'] },
        },
      }],
      shipping_address_collection: { allowed_countries: ['GB'] },
      phone_number_collection: { enabled: true },
      success_url: 'https://local-assets.com/camera?order=success',
      cancel_url:  'https://local-assets.com/camera?order=cancelled',
      metadata: { kind: 'camera_order', venueSlug: session.venueSlug || '', email: session.email },
      payment_intent_data: { metadata: { kind: 'camera_order', venueSlug: session.venueSlug || '' } },
    });
    return res.status(200).json({ url: checkout.url });
  } catch (e) {
    console.error('[order-camera]', e.message);
    return res.status(502).json({ error: e.message });
  }
}
