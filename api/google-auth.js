import crypto from 'crypto';

const REDIRECT_URI = 'https://local-assets.com/api/google-callback';

export default async function handler(req, res) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return res.status(500).json({ error: 'Google OAuth not configured' });

  const intent = req.query?.intent === 'client' ? 'client' : 'admin';
  const state = crypto.randomBytes(16).toString('hex');
  // Local development (npm run dev): after sign-in, the session is handed back to http://localhost:<port>
  const dev = intent === 'admin' && /^\d{4,5}$/.test(String(req.query?.dev || '')) ? String(req.query.dev) : '';
  res.setHeader('Set-Cookie', `la_google_state=${state}.${intent}${dev ? '.' + dev : ''}; Path=/api/google-callback; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);

  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  REDIRECT_URI,
    response_type: 'code',
    scope:         'openid email profile',
    state,
    access_type:   'online',
    prompt:        'select_account',
  });

  res.writeHead(302, { Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
  res.end();
}
