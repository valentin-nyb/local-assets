import { createClient } from 'redis';
import { getWebSessionAuth } from './_venues.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://local-assets.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-Email');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const session = getWebSessionAuth(req);
  if (!session?.email) return res.status(401).json({ error: 'Not authenticated' });
  if (!session.venueSlug) return res.status(400).json({ error: 'No venue associated with this account' });

  const redis = createClient({ url: process.env.REDIS_URL });
  await redis.connect();
  try {
    await redis.del(`youtube_token:${session.venueSlug}`);
    console.log(`[youtube-disconnect] cleared tokens for venue: ${session.venueSlug}`);
    return res.status(200).json({ success: true });
  } finally {
    await redis.quit();
  