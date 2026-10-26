import Stripe from 'stripe';
import { getWebSessionAuth } from './_venues.js';
import { createCheckout } from './_checkout.js';

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
// Day hire: per camera per day, cheaper from 3 days. Delivery, collection and dashboard setup included.
export const CAMERA_RENTAL = { dayRate: 7900, longDayRate: 5900, longFrom: 3, maxDays: 30 };
const rentalRate = days => (days >= CAMERA_RENTAL.longFrom ? CAMERA_RENTAL.longDayRate : CAMERA_RENTAL.dayRate);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // Signed-in venues and visitors on the home page can both order; Stripe asks guests for their email
  const session = getWebSessionAuth(req) || {};
  const fromHome = req.body?.from === 'home' || !session.email;
  const back = fromHome ? 'https://local-assets.com/' : 'https://local-assets.com/camera';

  const sk = (process.env.LA_STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY);   // local / assets own Stripe account first, else the Vercel integration

  if (req.method === 'GET') {
    return res.status(200).json({
      available: !!sk,
      price: CAMERA_PRODUCT.unitAmount / 100,
      currency: CAMERA_PRODUCT.currency,
      maxQuantity: CAMERA_PRODUCT.maxQuantity,
      rental: { dayRate: CAMERA_RENTAL.dayRate / 100, longDayRate: CAMERA_RENTAL.longDayRate / 100, longFrom: CAMERA_RENTAL.longFrom, maxDays: CAMERA_RENTAL.maxDays },
    });
  }
  if (req.method !== 'POST') return res.status(405).end();
  if (!sk) return res.status(503).json({ error: 'payments_not_configured' });

  const qty = Math.min(Math.max(parseInt(req.body?.quantity, 10) || 1, 1), CAMERA_PRODUCT.maxQuantity);
  // Day hire: the first day (from tomorrow, within a year) and how many days
  const rent = req.body?.mode === 'rent';
  let days = 0, start = '';
  if (rent) {
    days = Math.min(Math.max(parseInt(req.body?.days, 10) || 1, 1), CAMERA_RENTAL.maxDays);
    start = String(req.body?.startDate || '');
    const t = Date.parse(start + 'T12:00:00Z');
    const tomorrow = new Date(); tomorrow.setUTCHours(0, 0, 0, 0); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !(t >= tomorrow.getTime()) || t > Date.now() + 366 * 86400e3) return res.status(400).json({ error: 'Choose the first day of the hire (from tomorrow)' });
  }
  const until = rent ? new Date(Date.parse(start + 'T12:00:00Z') + (days - 1) * 86400e3).toISOString().slice(0, 10) : '';
  const fmt = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

  try {
    const stripe = new Stripe(sk);
    const checkout = await createCheckout(stripe, {
      mode: 'payment',
      ...(session.email ? { customer_email: session.email } : {}),
      line_items: [rent ? {
        quantity: qty,
        adjustable_quantity: { enabled: true, minimum: 1, maximum: CAMERA_PRODUCT.maxQuantity },
        price_data: {
          currency: CAMERA_PRODUCT.currency,
          unit_amount: rentalRate(days) * days,
          tax_behavior: 'inclusive',
          product_data: {
            name: `${CAMERA_PRODUCT.name} hire · ${days} day${days > 1 ? 's' : ''}`,
            description: `${days === 1 ? fmt(start) : fmt(start) + ' to ' + fmt(until)}. £${rentalRate(days) / 100} per camera per day. UK delivery and collection, and setup with your local / assets dashboard, included.`,
            images: ['https://local-assets.com/img/obsbot-tail-2.png'],
          },
        },
      } : {
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
      success_url: back + '?order=success',
      cancel_url:  back + '?order=cancelled',
      metadata: { kind: 'camera_order', venueSlug: session.venueSlug || '', email: session.email || '', ...(rent ? { rental: 'yes', startDate: start, endDate: until, days: String(days) } : {}) },
      payment_intent_data: { metadata: { kind: 'camera_order', venueSlug: session.venueSlug || '', ...(rent ? { rental: 'yes', startDate: start, endDate: until } : {}) } },
    });
    return res.status(200).json({ url: checkout.url });
  } catch (e) {
    console.error('[order-camera]', e.message);
    return res.status(502).json({ error: e.message });
  }
}
