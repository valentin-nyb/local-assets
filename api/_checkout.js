// Stripe Checkout with a "I agree to the Terms of Service" tick-box before paying.
// Stripe shows it only once a terms link is saved in the Stripe dashboard (Settings → Public details);
// until then the tick-box is refused, so the checkout opens without it rather than failing.
export async function createCheckout(stripe, params) {
  try {
    return await stripe.checkout.sessions.create({ ...params, consent_collection: { ...(params.consent_collection || {}), terms_of_service: 'required' } });
  } catch (e) {
    if (!/terms of service|consent_collection/i.test(e?.message || '')) throw e;
    console.error('[checkout] terms tick-box unavailable (add the terms URL in Stripe → Settings → Public details):', e.message);
    return stripe.checkout.sessions.create(params);
  }
}
