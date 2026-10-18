import { createClient } from 'redis';
import crypto from 'crypto';
import { findVenueByEmail, venueChoices, freshVenues } from './_venues.js';
import { signWebToken } from './_venues.js';

export default async function handler(req, res) {
  await freshVenues();
  const oauthCookie = parseCookie(req.headers.cookie || '').la_google_state || '';
  const [expectedState, intent = 'admin', devPort = '', appChallenge = ''] = oauthCookie.split('.');
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
    if (!venue) {
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
      venues:   venueChoices(email),
      role:     venue?.role     || 'admin',
      ts:       Date.now(),
    });

    console.error('[google-callback] web login OK:', email, 'venue:', venueSlug);

    res.setHeader('Set-Cookie', clearState);
    // Local development: the session goes to the dev server on this computer only (in the URL fragment,
    // which is never sent to a server)
    // The Mac app: park the session for two minutes under a one-time code and hand the code to the app.
    // Only the app that started the sign-in holds the secret that collects it.
    if (/^[A-Za-z0-9_-]{43}$/.test(appChallenge)) {
      const code = crypto.randomBytes(32).toString('base64url');
      const redis = createClient({ url: process.env.REDIS_URL });
      await redis.connect();
      try { await redis.set('app_signin:' + code, JSON.stringify({ challenge: appChallenge, session: sessionData }), { EX: 120 }); }
      finally { await redis.quit().catch(() => {}); }
      const link = 'localassets://signed-in?code=' + code;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(appHandoffPage(link));
    }
    if (/^\d{4,5}$/.test(devPort)) {
      return res.redirect(`http://localhost:${devPort}/__dev/session#` + Buffer.from(sessionData).toString('base64url'));
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(`<!DOCTYPE html><html><body><script>
      localStorage.setItem('la_admin', ${JSON.stringify(sessionData)});
      ${venue?.name
        ? `localStorage.setItem('la_venue_name', ${JSON.stringify(venue.name.toUpperCase())});`
        : `localStorage.removeItem('la_venue_name');`}
      localStorage.removeItem('la_revenue_cache_v2');
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

// The browser page after signing in for the Mac app, in the login page's style: the wordmark top left,
// the message in the middle, a quiet footer. It opens the app straight away.
function appHandoffPage(link) {
  return `<!DOCTYPE html><html lang="en" style="color-scheme:dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>local / assets™ — Signed in</title><link rel="icon" href="/favicon/favicon.ico">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--green:#39FF14;--bg:#070905;--fg:#fafafa;--mono:'JetBrains Mono',ui-monospace,monospace;--display:'Helvetica Neue',Helvetica,Arial,sans-serif;--col:min(100vw - 48px,420px);--gut:24px}
html,body{height:100%;background:var(--bg);color:var(--fg);font-family:var(--display);-webkit-font-smoothing:antialiased}
body{min-height:100dvh;display:flex;align-items:center;justify-content:center;overflow:hidden;
  background-image:radial-gradient(circle,#141a11 1.1px,transparent 1.2px);background-size:45px 45px;background-position:center}
.wordmark{position:fixed;top:calc(max(env(safe-area-inset-top),12px) + 28px);left:var(--gut);width:128px;aspect-ratio:1328/165;background:url(/logos/Green@2x.png) left center/contain no-repeat}
.wrap{width:var(--col);display:flex;flex-direction:column;align-items:flex-start}
.eyebrow{display:flex;align-items:center;gap:10px;font:500 10px/1 var(--mono);letter-spacing:.24em;text-transform:uppercase;color:var(--green);margin-bottom:18px}
.eyebrow::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--green);animation:pulse 1.6s ease-in-out infinite}
@keyframes pulse{50%{opacity:.35}}
h1{font-weight:700;font-size:clamp(28px,8.6vw,44px);line-height:.96;letter-spacing:-.02em;text-transform:uppercase}
h1 span{display:inline-block;white-space:nowrap;transition:color .3s,transform .3s}
@media (hover:hover){h1 span:hover{color:var(--green);transform:translateX(6px)}}
.lead{margin-top:16px;font-size:15px;line-height:1.5;color:#a1a1aa;max-width:40ch}
.btn{position:relative;isolation:isolate;overflow:hidden;margin-top:36px;display:flex;align-items:center;justify-content:center;gap:12px;width:100%;height:54px;
  background:#fafafa;border:1px solid #fafafa;border-radius:999px;color:#0a0a0a;font:500 15px/1 var(--display);text-decoration:none;transition:transform .15s ease,border-color .3s ease}
.btn::before{content:"";position:absolute;inset:-1px;z-index:-1;border-radius:inherit;background:var(--green);transform:scaleX(0);transform-origin:right center;transition:transform .42s cubic-bezier(.65,0,.35,1)}
@media (hover:hover){.btn:hover::before{transform:scaleX(1);transform-origin:left center}.btn:hover{border-color:var(--green)}}
.btn:active{transform:scale(.98)}
.btn i{width:15px;aspect-ratio:72/80;background:#0a0a0a;-webkit-mask:url(/logos/a-white.png) center/contain no-repeat;mask:url(/logos/a-white.png) center/contain no-repeat}
.note{margin-top:16px;font-size:12px;line-height:1.5;color:#71717a}
.foot{position:fixed;left:0;right:0;bottom:calc(max(env(safe-area-inset-bottom),12px) + 18px);text-align:center;font:400 10px var(--mono);letter-spacing:.18em;text-transform:uppercase;color:#52564f}
@media (min-width:980px){
  .wordmark{top:44px;left:4%;width:150px}
  h1{font-size:50px}
  .foot{bottom:32px}
}
</style></head>
<body>
<span class="wordmark" role="img" aria-label="local / assets"></span>
<main class="wrap">
  <p class="eyebrow">Signed in</p>
  <h1><span>Back to</span><br><span>the app</span></h1>
  <p class="lead">a™ is opening your workspace. You can close this tab.</p>
  <a class="btn" href="${link}"><i aria-hidden="true"></i>Open a™</a>
  <p class="note">Nothing happened? Press Open a™.</p>
</main>
<p class="foot">© 2026 local / assets™</p>
<script>location.href=${JSON.stringify(link)};</script>
</body></html>`;
}
