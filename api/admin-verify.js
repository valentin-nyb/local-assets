import { findVenueByEmail } from './_venues.js';

// Hardcoded fallback while VENUES_CONFIG is being stabilised
const ALLOWED = [
  'valentin@notyourbrew.com',
  'smack.valentin@gmail.com',
  'info@local-assets.com',
];

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

  const venueEntry    = findVenueByEmail(email);
  const inHardcoded   = ALLOWED.includes(email);
  const inVenueConfig = venueEntry !== null;
  const isAllowed     = inHardcoded || inVenueConfig;

  console.error('[admin-verify] login attempt', JSON.stringify({
    email,
    inHardcodedList:     inHardcoded,
    foundInVenuesConfig: inVenueConfig,
    venueSlug:           venueEntry?.slug ?? null,
    isAllowed,
  }));

  if (!isAllowed) {
    return res.status(403).json({ error: 'unauthorized' });
  }

  return res.status(200).json({
    ok: true,
    email: payload.email,
    name: payload.name || payload.email,
    picture: payload.picture || '',
  });
}
