import { kv } from '@vercel/kv';
import crypto from 'crypto';

export default async function handler(req, res) {
  const { token } = req.query;
  if (!token || typeof token !== 'string') {
    return res.status(400).send('Missing or invalid token');
  }

  // Look up the magic link token
  const email = await kv.get(`magic:${token}`);
  if (!email) {
    return res.status(401).send(`
      <html><body style="font-family:monospace;background:#050505;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
        <div style="text-align:center;">
          <p style="color:#39FF14;font-size:10px;letter-spacing:0.3em;margin-bottom:16px;">[ local / assets™ ]</p>
          <h2 style="font-size:18px;margin-bottom:8px;">Link Expired</h2>
          <p style="color:#888;font-size:13px;">This magic link has expired or already been used.</p>
          <a href="/client.html" style="color:#39FF14;font-size:12px;margin-top:16px;display:inline-block;">Request a new link →</a>
        </div>
      </body></html>
    `);
  }

  // Delete used token (single-use)
  await kv.del(`magic:${token}`);

  // Look up the client ID
  const clientId = await kv.get(`client:email:${email}`);
  if (!clientId) {
    return res.status(404).send('No client profile found for this email');
  }

  // Create session token (7 days)
  const sessionToken = crypto.randomBytes(32).toString('hex');
  await kv.set(`session:${sessionToken}`, clientId, { ex: 7 * 24 * 3600 });

  // Set HttpOnly cookie and redirect to portal
  const maxAge = 7 * 24 * 3600;
  res.setHeader('Set-Cookie', `la_session=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`);
  res.writeHead(302, { Location: '/client.html' });
  res.end();
}
