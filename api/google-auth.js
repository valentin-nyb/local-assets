import crypto from 'crypto';
import { createClient } from 'redis';

const REDIRECT_URI = 'https://local-assets.com/api/google-callback';

// The Mac app (a™): after Google sign-in in the browser, the app gets a one-time code through
// localassets://signed-in and swaps it here, with the secret only it holds, for the session.
async function appExchange(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const code = String(req.body?.code || ''), verifier = String(req.body?.verifier || '');
  if (!/^[A-Za-z0-9_-]{43}$/.test(code) || !/^[A-Za-z0-9_-]{43,128}$/.test(verifier)) return res.status(400).json({ error: 'Sign-in link not valid. Sign in again.' });
  const redis = createClient({ url: process.env.REDIS_URL });
  await redis.connect();
  let raw;
  try { raw = await redis.getDel('app_signin:' + code); } finally { await redis.quit().catch(() => {}); }
  if (!raw) return res.status(410).json({ error: 'This sign-in has expired. Sign in again.' });
  const { challenge, session } = JSON.parse(raw);
  const got = crypto.createHash('sha256').update(verifier).digest('base64url');
  if (got.length !== challenge.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(challenge))) return res.status(403).json({ error: 'Sign-in did not start in this app. Sign in again.' });
  return res.status(200).json({ session: JSON.parse(session) });
}

export default async function handler(req, res) {
  if (req.method === 'POST') return appExchange(req, res);
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return res.status(500).json({ error: 'Google OAuth not configured' });

  const intent = req.query?.intent === 'client' ? 'client' : 'admin';
  const state = crypto.randomBytes(16).toString('hex');
  // Local development (npm run dev): after sign-in, the session is handed back to http://localhost:<port>
  const dev = intent === 'admin' && /^\d{4,5}$/.test(String(req.query?.dev || '')) ? String(req.query.dev) : '';
  // The Mac app: the hash of its one-time secret, checked when it collects the session
  const app = intent === 'admin' && /^[A-Za-z0-9_-]{43}$/.test(String(req.query?.app || '')) ? String(req.query.app) : '';
  res.setHeader('Set-Cookie', `la_google_state=${state}.${intent}.${dev}.${app}; Path=/api/google-callback; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);

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
