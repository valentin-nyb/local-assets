import crypto from 'crypto';
import JSON5 from 'json5';

// ── VENUES_CONFIG helpers ─────────────────────────────────────────────────────

export function getVenuesConfig() {
  const raw = process.env.VENUES_CONFIG || '{}';

  // 1. Direct parse
  try { return JSON.parse(raw); } catch (e1) {
    // 2. Escape bare + before parsing (Vercel may leave + unencoded, breaking JSON strings)
    try { return JSON.parse(raw.replace(/\+/g, '%2B')); } catch (e2) {
      // 3. Full URL-decode then parse
      try { return JSON.parse(decodeURIComponent(raw)); } catch (e3) {
        // 4. Hand-edited JSON: missing commas between lines, trailing commas, curly quotes
        try {
          const fixed = repairJson(raw);
          const cfg = JSON5.parse(fixed);   // also unquoted keys, single quotes, comments
          if (!getVenuesConfig._warned) { getVenuesConfig._warned = true; console.warn('[_venues] VENUES_CONFIG had JSON mistakes (missing or extra commas); read it after repairing them. Fix the value in Vercel when convenient.'); }
          return cfg;
        } catch (e4) {
          console.error('[_venues] VENUES_CONFIG parse failed — raw:', e1.message, '| +escape:', e2.message, '| decoded:', e3.message, '| repaired:', e4.message);
          return {};
        }
      }
    }
  }
}

function repairJson(raw) {
  return String(raw)
    .replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'")
    // whole-line // comments (not the // inside https:// values)
    .replace(/^[ \t]*\/\/.*$/gm, '')
    // a value or closing bracket at the end of a line, followed by a new key or object: add the comma
    .replace(/("|'|\d|true|false|null|\}|\])([ \t]*\r?\n\s*)(?=[^\s}\],:\/])/g, '$1,$2')
    // a comma right before a closing bracket: remove it
    .replace(/,(\s*[}\]])/g, '$1')
    // closing brackets missing at the end (value cut short when pasted)
    .replace(/[\s\S]*/, closeBrackets);
}

function closeBrackets(text) {
  const stack = [];
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') stack.pop();
  }
  return text.replace(/[\s,]*$/, '') + (quote || '') + stack.reverse().join('');
}

// Env-var key for a venue slug, e.g. "the-nest" → "THE_NEST"
function venueEnvKey(slug) {
  return slug ? slug.toUpperCase().replace(/[^A-Z0-9]+/g, '_') : '';
}

// Login emails for a venue, from its `emails` array in VENUES_CONFIG. Entries are
// also split on commas/whitespace, so ["a@x.com, b@y.com"] counts as two emails.
function venueEmails(cfg) {
  const list = Array.isArray(cfg.emails) ? cfg.emails : typeof cfg.emails === 'string' ? [cfg.emails] : [];
  return list.flatMap(e => String(e).split(/[\s,;]+/))
    .map(e => e.toLowerCase().trim()).filter(Boolean);
}

// All venues whose `emails` contain the given email. VENUES_CONFIG is the only
// source of login access: an email that isn't listed in a venue cannot sign in.
// An email listed in several venues can open any of them.
// local / assets admins (PLATFORM_ADMINS, default info@local-assets.com) can open every venue.
export const platformAdmins = () => (process.env.PLATFORM_ADMINS || 'info@local-assets.com').split(/[\s,;]+/).map(e => e.toLowerCase().trim()).filter(Boolean);
export function findVenuesByEmail(email) {
  if (!email) return [];
  const lower = email.toLowerCase().trim();
  const admin = platformAdmins().includes(lower);
  return Object.entries(getVenuesConfig())
    .filter(([, cfg]) => admin || venueEmails(cfg).includes(lower))
    .map(([slug, cfg]) => ({ slug, ...cfg }));
}

// The venue to use for this email: `preferredSlug` if the email belongs to it,
// otherwise the first venue it is listed in. Null if it is listed in none.
export function findVenueByEmail(email, preferredSlug) {
  const venues = findVenuesByEmail(email);
  const venue = venues.find(v => v.slug === preferredSlug) || venues[0] || null;
  if (venue) console.log('[_venues] findVenueByEmail:', email, '→', venue.slug, venues.length > 1 ? `(1 of ${venues.length})` : '');
  else console.error('[_venues] findVenueByEmail: no match for', email, '| venue slugs:', Object.keys(getVenuesConfig()));
  return venue;
}

// Public list of the venues an email can open, for the venue switcher.
export function venueChoices(email) {
  // The local / assets admin account first, then the clients A–Z
  const isAdmin = v => v.slug === (process.env.BILLING_ADMIN_VENUE || 'local-assets-admin') || /^local\s*[\/-]?\s*assets\b/i.test(String(v.name || '').trim());
  return findVenuesByEmail(email).map(v => ({ slug: v.slug, name: v.name || v.slug }))
    .sort((a, b) => (isAdmin(b) - isAdmin(a)) || a.name.localeCompare(b.name));
}

// Returns a Basic auth string using ONLY venue-specific credentials.
// NEVER falls back to global env vars — if a venue has no explicit Mux creds, returns null.
// This enforces strict per-venue isolation: a client can only ever see their own assets.
export function getMuxAuthForVenue(venue) {
  const envKey = venueEnvKey(venue?.slug);
  const id = (
    (envKey && process.env[`${envKey}_MUX_TOKEN_ID`]) ||
    venue?.mux_token_id || ''
  ).trim();
  const secret = (
    (envKey && process.env[`${envKey}_MUX_TOKEN_SECRET`]) ||
    venue?.mux_token_secret || ''
  ).trim();
  if (!id || !secret) return null;
  return 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');
}

// ── Signed web-session token (HMAC-SHA256, 1-hour TTL, renewed by open pages) ────────────────────────

const getSecret = () => process.env.LOCAL_ASSETS_API_KEY || 'dev-secret-change-me';

export function signWebToken(email, venueSlug) {
  const payload = { email, venueSlug, exp: Date.now() + 3_600_000 };
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
// The user is identified ONLY by the signed webToken (Authorization: Bearer …).
// Its venueSlug picks which of the user's venues is open; access is re-checked
// against VENUES_CONFIG on every request. Mux credentials come only from that venue.

export function getWebSessionAuth(req) {
  const raw   = (req.headers.authorization || req.headers['x-la-token'] || '').trim();
  const token = raw.startsWith('Bearer ') ? raw.slice(7).trim() : raw;
  const payload = token ? verifyWebToken(token) : null;
  const email = payload?.email ? payload.email.toLowerCase().trim() : null;

  if (!email) {
    console.error('[_venues] getWebSessionAuth: no valid session token');
    return null;
  }

  const venue   = findVenueByEmail(email, payload.venueSlug);
  const muxAuth = getMuxAuthForVenue(venue); // null if no venue-specific creds

  return { email, venueSlug: venue?.slug || '', venue, muxAuth };
}
