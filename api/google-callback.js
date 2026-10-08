import { createClient } from 'redis';
import crypto from 'crypto';
import { findVenueByEmail } from './_venues.js';
import { signWebToken } from './_venues.js';

export default async function handler(req, res) {
  const oauthCookie = parseCookie(req.headers.cookie || '').la_google_state || '';
  const [expectedState, intent = 'admin'] = oauthCookie.split('.');
  const clearState = 'la_google_state=; Path=/api/google-callback; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
  try {
    const { code, state } = req.query;
    if (!code) {
      res.setHeader('Set-Cookie', clearState);
      return res.redirect(intent === 'client' ? '/client.html?error=google_failed' : '/login.html?error=no_code');
    }
    if (!expectedState || !state || state !== expectedState) {
      res.setHeader('Set-Cookie', clearState);
      return res.redirect(intent === 'client' ? '/client.html?error=google_state' : '/login.html?error=auth_failed');
    }

    // Exchange code for tokens with Google
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri:  'https://local-assets.com/api/google-callback',
        grant_type:    'authorization_code',
      }),
    });

    const tokens = await tokenRes.json();
    if (!tokens.id_token) {
      console.error('[google-callback] no id_token:', tokens);
      return res.redirect('/login.html?error=no_token');
    }

    // Decode the JWT payload to get email (Google already verified the signature)
    const payload = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64url').toString());
    const email   = payload.email?.toLowerCase().trim();
    if (!email || payload.email_verified !== true) {
      res.setHeader('Set-Cookie', clearState);
      return res.redirect(intent === 'client' ? '/client.html?error=no_email' : '/login.html?error=no_email');
    }

    if (intent === 'client') {
      const redis = createClient({ url: process.env.REDIS_URL });
      await redis.connect();
      try {
        let clientId = await redis.get(`client:email:${email}`);
        const allowedEmails = (process.env.CLIENT_EMAILS || '').split(',').map(value => value.toLowerCase().trim()).filter(Boolean);
        if (!clientId && allowedEmails.includes(email)) {
          clientId = 'cl_' + crypto.randomBytes(12).toString('hex');
          await redis.hSet(`client:${clientId}`, {
            id: clientId,
            email,
            name: payload.name || email,
            createdAt: new Date().toISOString(),
            status: 'active',
            assets: '[]',
          });
          await redis.set(`client:email:${email}`, clientId);
        }
        if (!clientId) {
          res.setHeader('Set-Cookie', clearState);
          return res.redirect('/client.html?error=not_registered');
        }

        const profile = await redis.hGetAll(`client:${clientId}`);
        if (!Object.keys(profile).length) {
          res.setHeader('Set-Cookie', clearState);
          return res.redirect('/client.html?error=profile_missing');
        }

        const sessionToken = crypto.randomBytes(32).toString('hex');
        await redis.set(`session:${sessionToken}`, clientId, { EX: 7 * 24 * 3600 });
        res.setHeader('Set-Cookie', [
          clearState,
          `la_session=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${7 * 24 * 3600}`,
        ]);
        return res.redirect('/client.html');
      } finally {
        await redis.quit();
      }
    }

    // Check if email is authorised
    const venue       = findVenueByEmail(email);
    const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.toLowerCase().trim()).filter(Boolean);
    if (!venue && !adminEmails.includes(email)) {
      console.error('[google-callback] unauthorized:', email);
      res.setHeader('Set-Cookie', clearState);
      return res.redirect('/login.html?error=unauthorized');
    }

    // Sign a short-lived webToken (no Redis — pure HMAC)
    const venueSlug = venue?.slug || '';
    const webToken  = signWebToken(email, venueSlug);

    const sessionData = JSON.stringify({
      email,
      webToken,
      name:     payload.name    || '',
      picture:  payload.picture || '',
      venue:    venue?.name     || 'Admin',
      venueSlug,
      role:     venue?.role     || 'admin',
      ts:       Date.now(),
    });

    console.error('[google-callback] web login OK:', email, 'venue:', venueSlug);

    res.setHeader('Set-Cookie', clearState);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(`<!DOCTYPE html><html><body><script>
      localStorage.setItem('la_admin', ${JSON.stringify(sessionData)});
      ${venue?.name
        ? `localStorage.setItem('la_venue_name', ${JSON.stringify(venue.name.toUpperCase())});`
        : `localStorage.removeItem('la_venue_name');`}
      localStorage.removeItem('la_revenue_cache');
      window.location.href = '/dashboard';
    </script></body></html>`);

  } catch (e) {
    console.error('[google-callback] error:', e.message);
    res.setHeader('Set-Cookie', clearState);
    if (intent === 'client') return res.redirect('/client.html?error=google_failed');
    return res.redirect('/login.html?error=server_error');
  }
}

function parseCookie(cookieHeader) {
  return Object.fromEntries(cookieHeader.split(';').map(part => {
    const separator = part.indexOf('=');
    return separator < 0 ? ['', ''] : [part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())];
  }).filter(([key]) => key));
}
