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

// Returns a Basic auth string using ONLY venue-specific credentials.
// NEVER falls back to global env vars — if a venue has no explicit Mux creds, returns null.
// This enforces strict per-venue isolation: a client can only ever see their own assets.
export function getMuxAuthForVenue(venue) {
  const id     = (venue?.mux_token_id     || '').trim();
  const secret = (venue?.mux_token_secret || '').trim();
  if (!id || !secret) return null;
  return 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');
}

// ── Signed web-session token (HMAC-SHA256, 10-min TTL) ────────────────────────

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

// ── Request helper ────────────────────────────────────────────────────────────
// Email source priority:
//   1. Signed webToken in Authorization header (tamper-proof)
//   2. X-User-Email header (transparent, used when token is absent/expired)
// Mux credentials come ONLY from the matched venue — no global fallback.

export function getWebSessionAuth(req) {
  // 1. Try signed webToken
  let email = null;
  const raw   = (req.headers.authorization || req.headers['x-la-token'] || '').trim();
  const token = raw.startsWith('Bearer ') ? raw.slice(7).trim() : raw;
  if (token) {
    const payload = verifyWebToken(token);
    if (payload?.email) email = payload.email.toLowerCase().trim();
  }

  // 2. Fall back to X-User-Email if no valid token
  if (!email) {
    const hdr = (req.headers['x-user-email'] || '').toLowerCase().trim();
    if (hdr) email = hdr;
  }

  if (!email) {
    console.error('[_venues] getWebSessionAuth: no email from token or header');
    return null;
  }

  const venue   = findVenueByEmail(email);
  const muxAuth = getMuxAuthForVenue(venue); // null if no venue-specific creds

  console.error('[_venues] getWebSessionAuth', JSON.stringify({
    email,
    tokenPresent:   !!token,
    venueFound:     venue?.slug ?? null,
    hasMuxCreds:    !!muxAuth,
    VENUES_CONFIG:  process.env.VENUES_CONFIG ? process.env.VENUES_CONFIG.slice(0, 120) : '(not set)',
  }));

  return { email, venueSlug: venue?.slug || '', venue, muxAuth };
}
