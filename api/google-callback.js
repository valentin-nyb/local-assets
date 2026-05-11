import { createClient } from 'redis';
import crypto from 'crypto';

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
    // Verify CSRF state
    const valid = await redis.get(`oauth:state:${state}`);
    if (!valid) {
      return res.status(400).send('Invalid or expired state — please try signing in again');
    }
    await redis.del(`oauth:state:${state}`);

    // Exchange authorization code for tokens
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
      return res.status(500).send('Authentication failed — please try again');
    }

    // Get the user's email from Google
    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const user = await userRes.json();

    const email = user.email?.toLowerCase()?.trim();
    if (!email) return res.status(400).send('Could not retrieve email from Google');

    // Check if this email is a registered client
    const clientId = await redis.get(`client:email:${email}`);
    if (!clientId) {
      res.writeHead(302, { Location: 'localassets://auth-error?reason=not-a-client' });
      return res.end();
    }

    // Create a 7-day session
    const sessionToken = crypto.randomBytes(32).toString('hex');
    await redis.set(`session:${sessionToken}`, clientId, { EX: 7 * 24 * 3600 });

    res.writeHead(302, { Location: `localassets://verified?session=${sessionToken}` });
    res.end();
  } finally {
    await redis.quit();
  }
}
