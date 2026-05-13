import { findVenueByEmail } from './_venues.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();

  const { credential } = req.body || {};
  if (!credential) return res.status(400).json({ error: 'Missing credential' });

  // Verify the Google ID token
  let payload;
  try {
    const r = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`,
      { signal: AbortSignal.timeout(8000) }
    );
    payload = await r.json();
    if (!r.ok || payload.error) {
      return res.status(401).json({ error: 'Invalid token' });
    }
  } catch (e) {
    return res.status(500).json({ error: 'Token verification failed' });
  }

  // Verify audience matches our client
  const clientId =
    process.env.GOOGLE_CLIENT_ID ||
    '892380654488-ro2ptu81b44vru1ahhfm9naku0ckvb9v.apps.googleusercontent.com';
  if (payload.aud !== clientId) {
    return res.status(401).json({ error: 'Token audience mismatch' });
  }

  const email = (payload.email || '').toLowerCase().trim();
  if (!email) return res.status(401).json({ error: 'No email in token' });

  const venueEntry = findVenueByEmail(email);
  const allowed = (process.env.ADMIN_EMAILS || '')
    .split(',').map(e => e.toLowerCase().trim()).filter(Boolean);

  // Allowed if: ADMIN_EMAILS is empty, OR email is in ADMIN_EMAILS,
  // OR email is in VENUES_CONFIG.
  const isAllowed = allowed.length === 0 || allowed.includes(email) || venueEntry !== null;

  console.error('[admin-verify] login attempt', {
    email,
    adminEmailsRaw: process.env.ADMIN_EMAILS || '(empty)',
    allowedList: allowed,
    foundInVenuesConfig: !!venueEntry,
    isAllowed,
  });

  if (!isAllowed) {
    return res.status(403).json({ error: 'not_allowed' });
  }

  return res.status(200).json({
    ok: true,
    email: payload.email,
    name: payload.name || payload.email,
    picture: payload.picture || '',
  });
}
