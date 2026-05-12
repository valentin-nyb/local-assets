import crypto from 'crypto';

// ── VENUES_CONFIG helpers ─────────────────────────────────────────────────────

export function getVenuesConfig() {
  try { return JSON.parse(process.env.VENUES_CONFIG || '{}'); } catch(_) { return {}; }
}

// Returns the first venue whose `emails` array contains the given email, or null.
export function findVenueByEmail(email) {
  if (!email) return null;
  const lower = email.toLowerCase();
  const venues = getVenuesConfig();
  for (const [slug, cfg] of Object.entries(venues)) {
    if (Array.isArray(cfg.emails) && cfg.emails.some(e => e.toLowerCase() === lower)) {
      return { slug, ...cfg };
    }
  }
  return null;
}

// Returns a Basic auth string using venue-specific creds, falling back to global env vars.
export function getMuxAuthForVenue(venue) {
  const id     = (venue?.mux_token_id     || process.env.PROD_MUX_TOKEN_ID     || '').trim();
  const secret = (venue?.mux_token_secret || process.env.PROD_MUX_TOKEN_SECRET || '').trim();
  if (!id || !secret) return null;
  return 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');
}

// ── Signed web-session token (HMAC-SHA256, 10-min TTL) ────────────────────────
// Stored in la_admin.webToken; sent as Authorization: Bearer <token>

const getSecret = () => process.env.LOCAL_ASSETS_API_KEY || 'dev-secret-change-me';

export function signWebToken(email, venueSlug) {
  const payload = { email, venueSlug, exp: Date.now() + 600_000 };
  const data    = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig     = crypto.createHmac('sha256', getSecret()).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export function verifyWebToken(token) {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const data = token.slice(0, dot);
  const sig  = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', getSecret()).update(data).digest('base64url');
  try {
    if (sig.length !== expected.length ||
        !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch(_) { return null; }
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString());
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch(_) { return null; }
}

// ── Request helper: verify token → resolve venue → return Mux auth ────────────

export function getWebSessionAuth(req) {
  const raw   = (req.headers.authorization || req.headers['x-la-token'] || '').trim();
  const token = raw.startsWith('Bearer ') ? raw.slice(7).trim() : raw;
  if (!token) return null;
  const payload = verifyWebToken(token);
  if (!payload) return null;
  const venue   = findVenueByEmail(payload.email);
  const muxAuth = getMuxAuthForVenue(venue);
  return { email: payload.email, venueSlug: venue?.slug || payload.venueSlug, venue, muxAuth };
}
