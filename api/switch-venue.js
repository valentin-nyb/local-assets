import { getWebSessionAuth, findVenuesByEmail, signWebToken, venueChoices } from './_venues.js';

// Switch the signed-in user to another venue they are listed in (VENUES_CONFIG).
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://local-assets.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const session = getWebSessionAuth(req);
  if (!session?.email) return res.status(401).json({ error: 'Not authenticated' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) {} }
  const slug = String(body?.venueSlug || '');

  const venue = findVenuesByEmail(session.email).find(v => v.slug === slug);
  if (!venue) return res.status(403).json({ error: 'You do not have access to that venue' });

  console.log('[switch-venue]', session.email, '→', venue.slug);
  return res.status(200).json({
    webToken:  signWebToken(session.email, venue.slug),
    venue:     venue.name || venue.slug,
    venueSlug: venue.slug,
    venues:    venueChoices(session.email),
  });
}
