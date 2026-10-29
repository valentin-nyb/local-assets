import { createClient } from 'redis';
import { getWebSessionAuth, findVenuesByEmail, signWebToken, venueChoicesTyped, freshVenues, endSignIn, signInEnded, platformAdmins, isAdminVenue, getVenuesConfig } from './_venues.js';

// The version of the Terms of Service and Privacy policy people agree to (their effective date).
// Changing it asks everyone to agree again the next time they open the dashboard.
export const TERMS_VERSION = '2026-10-26';

// Who is on the platform: each open page says it's still there about once a minute ({ ping }), kept per
// person and device (la_presence). The admin account reads it ({ presence }); entries over 30 days old go.
const PRESENCE_KEY = 'la_presence', PRESENCE_DAYS = 30;
const DEVICES = ['iPhone', 'iPad', 'Android', 'Mac', 'Windows', 'Linux', 'Other'];

// Switch the signed-in user to another venue they are listed in (VENUES_CONFIG).
// { refresh: true } renews the token for the current venue. { signOut: true } ends this sign-in (Log out).
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://local-assets.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  await freshVenues();
  const session = getWebSessionAuth(req);
  if (!session?.email) return res.status(401).json({ error: 'Not authenticated' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) {} }
  if (body?.ping) {
    const email = String(session.email).toLowerCase();
    const device = DEVICES.includes(body.ping.device) ? body.ping.device : 'Other';
    const page = String(body.ping.page || '').replace(/[^a-z0-9/_-]/gi, '').slice(0, 40);
    const entry = { email, slug: session.venueSlug || '', account: session.venue?.name || session.venueSlug || '', member: session.member?.name || null, page, device, app: !!body.ping.app, at: Date.now() };
    const redis = createClient({ url: (process.env.UPSTASH_REDIS_URL || process.env.REDIS_URL) });
    try { await redis.connect(); await redis.hSet(PRESENCE_KEY, email + '|' + device + (entry.app ? '|app' : ''), JSON.stringify(entry)); }
    finally { await redis.quit().catch(() => {}); }
    return res.status(200).json({ ok: true });
  }
  if (body?.presence) {
    if (!platformAdmins().includes(String(session.email).toLowerCase()) || !isAdminVenue(session.venue)) return res.status(403).json({ error: 'Admin only' });
    const redis = createClient({ url: (process.env.UPSTASH_REDIS_URL || process.env.REDIS_URL) });
    try {
      await redis.connect();
      const raw = await redis.hGetAll(PRESENCE_KEY) || {}, cutoff = Date.now() - PRESENCE_DAYS * 864e5, old = [], people = [];
      const cfg = getVenuesConfig();
      for (const [k, v] of Object.entries(raw)) {
        let e = null; try { e = JSON.parse(v); } catch (_) {}
        if (!e || e.at < cutoff) { old.push(k); continue; }
        people.push({ ...e, account: cfg[e.slug]?.name || e.account });
      }
      if (old.length) await redis.hDel(PRESENCE_KEY, old);
      people.sort((a, b) => b.at - a.at);
      return res.status(200).json({ now: Date.now(), people });
    } finally { await redis.quit().catch(() => {}); }
  }
  // The terms: whether this person has agreed to the current version, and recording that they have
  // (asked once, the first time they sign in; kept with the date so it can be shown later)
  if (body?.termsStatus || body?.acceptTerms) {
    const redis = createClient({ url: (process.env.UPSTASH_REDIS_URL || process.env.REDIS_URL) });
    try {
      await redis.connect();
      const email = String(session.email).toLowerCase();
      if (body.acceptTerms) {
        if (body.acceptTerms !== TERMS_VERSION) return res.status(409).json({ error: 'The terms have changed. Reload the page.', version: TERMS_VERSION });
        const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
        await redis.hSet('terms_accepted', email, JSON.stringify({ v: TERMS_VERSION, at: new Date().toISOString(), ip }));
        console.log('[switch-venue] terms accepted', email, TERMS_VERSION);
        return res.status(200).json({ ok: true, version: TERMS_VERSION });
      }
      let rec = null; try { rec = JSON.parse(await redis.hGet('terms_accepted', email) || 'null'); } catch (_) {}
      return res.status(200).json({ accepted: rec?.v === TERMS_VERSION, version: TERMS_VERSION });
    } finally { await redis.quit().catch(() => {}); }
  }
  // Log out, and renewals checked against Redis itself (the in-memory list can be a minute behind)
  if (body?.signOut || body?.refresh) {
    const redis = createClient({ url: (process.env.UPSTASH_REDIS_URL || process.env.REDIS_URL) });
    try {
      await redis.connect();
      if (body.signOut) { await endSignIn(redis, session.sid); console.log('[switch-venue] signed out', session.email); return res.status(200).json({ ok: true }); }
      if (await signInEnded(redis, session.sid)) return res.status(401).json({ error: 'Signed out' });
    } finally { await redis.quit().catch(() => {}); }
  }
  // Keeps an open page signed in: a fresh token for the same venue
  // and the current list of accounts, so the switcher drops a deleted one
  if (body?.refresh) return res.status(200).json({ webToken: signWebToken(session.email, session.venueSlug, session.member?.owner, session.sid), venue: session.member ? session.member.name : undefined, venueSlug: session.venueSlug, venues: await venueChoicesTyped(session.email), member: session.member || null });
  const slug = String(body?.venueSlug || '');

  // An artist with access to several artists here: the one chosen (as)
  const as = String(body?.as || '');
  const list = findVenuesByEmail(session.email);
  const venue = (as && list.find(v => v.slug === slug && v.member?.owner === as)) || list.find(v => v.slug === slug);
  if (!venue) return res.status(403).json({ error: 'You do not have access to that venue' });

  console.log('[switch-venue]', session.email, '→', venue.slug);
  return res.status(200).json({
    webToken:  signWebToken(session.email, venue.slug, venue.member?.owner, session.sid),
    venue:     venue.member ? venue.member.name : (venue.name || venue.slug),
    venueSlug: venue.slug,
    member:    venue.member || null,
    venues:    await venueChoicesTyped(session.email),
  });
}
