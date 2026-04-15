import { kv } from '@vercel/kv';
import { Resend } from 'resend';
import crypto from 'crypto';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e) {} }

  const email = (body?.email || '').toLowerCase().trim();
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required' });
  }

  // Check if this email has a client profile
  const clientId = await kv.get(`client:email:${email}`);
  if (!clientId) {
    // Don't expose whether email exists — always say "sent"
    return res.status(200).json({ sent: true });
  }

  try {
    const token = crypto.randomBytes(32).toString('hex');
    await kv.set(`magic:${token}`, email, { ex: 3600 }); // 1 hour

    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Email service not configured' });

    const resend = new Resend(apiKey);
    const link = `https://local-assets.com/api/verify-magic-link?token=${token}`;

    await resend.emails.send({
      from: 'local/assets™ <noreply@local-assets.com>',
      to: email,
      subject: 'Your local/assets™ Login Link',
      html: `
        <div style="font-family:monospace;background:#050505;color:#fff;padding:40px;max-width:500px;">
          <p style="color:#39FF14;font-size:10px;letter-spacing:0.3em;text-transform:uppercase;margin-bottom:24px;">[ local / assets™ ]</p>
          <h2 style="font-size:20px;margin-bottom:16px;">Sign in to your Portal</h2>
          <p style="color:#aaa;font-size:13px;line-height:1.6;margin-bottom:24px;">Click below to access your client dashboard.</p>
          <a href="${link}" style="display:inline-block;background:#39FF14;color:#000;padding:12px 32px;text-decoration:none;font-weight:bold;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;">ACCESS PORTAL</a>
          <p style="color:#666;font-size:11px;margin-top:24px;">This link expires in 1 hour. If you didn't request this, ignore this email.</p>
        </div>
      `
    });

    return res.status(200).json({ sent: true });
  } catch (err) {
    console.error('Send magic link error:', err);
    return res.status(500).json({ error: 'Failed to send login link' });
  }
}
