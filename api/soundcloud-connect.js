import { kv } from '@vercel/kv';
import crypto from 'crypto';
import { findVenueByEmail } from './_venues.js';

export default async function handler(req, res) {
  // Get email from query param or header
  const email = req.query.email || req.headers['x-user-email'] || '';
  if (!email) {
    return res.status(401).json({ error: 'Email required' });
  }

  // Look up venue from VENUES_CONFIG
  const venue = findVenueByEmail(email);
  if (!venue) {
    return res.status(403).json({ error: 'No venue found for this email' });
  }

  if (!process.env.SOUNDCLOUD_CLIENT_ID) {
    return res.status(500).json({ error: 'SOUNDCLOUD_CLIENT_ID not configured' });
  }

  // Store venue slug in state parameter
  const state = crypto.randomBytes(16).toString('hex');
  await kv.set(`soundcloud:state:${state}`, JSON.stringify({ email, venueSlug: venue.slug }), { ex: 300 });

  const params = new URLSearchParams({
    client_id: process.env.SOUNDCLOUD_CLIENT_ID,
    redirect_uri: 'https://local-assets.com/api/soundcloud-callback',
    response_type: 'code',
    scope: 'non-expiring-profile',
    state,
  });

  res.writeHead(302, { Location: `https://soundcloud.com/connect?${params}` });
  res.end();
}
