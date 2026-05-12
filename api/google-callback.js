import { createClient } from 'redis';
import crypto from 'crypto';
import { findVenueByEmail } from './_venues.js';

const REDIRECT_URI = 'https://local-assets.com/api/google-callback';

async function getRedis() {
  const client = createClient({ url: process.env.REDIS_URL });
  await client.connect();
  return client;
}

export default async function handler(req, res) {
  const { code, state, error } = req.query;

  if (error) {
    res.writeHead(302, { Location: 'localassets://auth-error?reason=cancelled' });
    return res.end();
  }

  if (!code || !state) {
    return res.status(400).send('Missing code or state');
  }

  const redis = await getRedis();
  try {
    // Verify CSRF state and extract mode
    const stateRaw = await redis.get(`oauth:state:${state}`);
    if (!stateRaw) {
      return res.status(400).send('Invalid or expired state — please try signing in again');
    }
    await redis.del(`oauth:state:${state}`);

    let mode = 'app';
    try { mode = JSON.parse(stateRaw).mode || 'app'; } catch (e) {}

    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri:  REDIRECT_URI,
        grant_type:    'authorization_code',
      }),
    });

    const tokens = await tokenRes.json();
    if (!tokenRes.ok) {
      console.error('Token exchange error:', tokens);
      if (mode === 'web') {
        res.writeHead(302, { Location: '/login.html?err=auth_failed' });
        return res.end();
      }
      return res.status(500).send('Authentication failed — please try again');
    }

    // Get user profile from Google
    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const user = await userRes.json();

    const email   = user.email?.toLowerCase()?.trim();
    const name    = user.name || user.email || '';
    const picture = user.picture || '';

    if (!email) {
      if (mode === 'web') {
        res.writeHead(302, { Location: '/login.html?err=no_email' });
        return res.end();
      }
      return res.status(400).send('Could not retrieve email from Google');
    }

    // ── Web (website admin) flow ──────────────────────────────────────────────
    if (mode === 'web') {
      // ADMIN_EMAILS is the sole access gate (empty = allow everyone).
      // VENUES_CONFIG is used only for role + venue assignment, never for blocking.
      const allowed = (process.env.ADMIN_EMAILS || '')
        .split(',').map(e => e.toLowerCase().trim()).filter(Boolean);
      if (allowed.length > 0 && !allowed.includes(email)) {
        res.writeHead(302, { Location: '/login.html?err=not_allowed' });
        return res.end();
      }

      // Look up role and venue from VENUES_CONFIG (best-effort, no blocking)
      const venueEntry = findVenueByEmail(email);
      const role = venueEntry?.role || 'admin';
      const assignedVenue = (venueEntry?.name || '').toUpperCase();

      const pendingToken = crypto.randomBytes(24).toString('hex');
      await redis.set(
        `web:pending:${pendingToken}`,
        JSON.stringify({ email, name, picture, role, venue: assignedVenue }),
        { EX: 120 }
      );

      res.writeHead(302, { Location: `/login.html?_s=${pendingToken}` });
      return res.end();
    }

    // ── App flow ─────────────────────────────────────────────────────────────
    let clientId = await redis.get(`client:email:${email}`);

    if (!clientId) {
      const adminEmails = (process.env.ADMIN_EMAILS || '')
        .split(',').map(e => e.toLowerCase().trim()).filter(Boolean);

      const isAdmin = adminEmails.length === 0 || adminEmails.includes(email);
      if (!isAdmin) {
        res.writeHead(302, { Location: 'localassets://auth-error?reason=not-a-client' });
        return res.end();
      }

      // Auto-create admin client record
      clientId = `admin:${crypto.randomBytes(8).toString('hex')}`;
      await redis.set(`client:email:${email}`, clientId);
      await redis.hSet(`client:${clientId}`, {
        email, name, picture, role: 'admin', createdAt: Date.now().toString(),
      });
    }

    const sessionToken = crypto.randomBytes(32).toString('hex');
    await redis.set(`session:${sessionToken}`, clientId, { EX: 7 * 24 * 3600 });

    res.writeHead(302, { Location: `localassets://verified?session=${sessionToken}` });
    res.end();
  } finally {
    await redis.quit();
  }
}
