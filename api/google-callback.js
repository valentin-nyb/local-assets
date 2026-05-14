import { findVenueByEmail } from './_venues.js';
import { signWebToken } from './_venues.js';

export default async function handler(req, res) {
  try {
    const { code, state } = req.query;
    if (!code) return res.redirect('/login.html?error=no_code');

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
    const email   = payload.email?.toLowerCase();
    if (!email) return res.redirect('/login.html?error=no_email');

    // Check if email is authorised
    const venue       = findVenueByEmail(email);
    const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.toLowerCase().trim()).filter(Boolean);
    if (!venue && !adminEmails.includes(email)) {
      console.error('[google-callback] unauthorized:', email);
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

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(`<!DOCTYPE html><html><body><script>
      localStorage.setItem('la_admin', ${JSON.stringify(sessionData)});
      window.location.href = '/dashboard';
    </script></body></html>`);

  } catch (e) {
    console.error('[google-callback] error:', e.message);
    return res.redirect('/login.html?error=server_error');
  }
}
