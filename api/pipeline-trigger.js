import { getClientSession } from './_client-auth.js';
import { createClient } from 'redis';
import crypto from 'crypto';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://local-assets.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Cookie');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const session = await getClientSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const { uploadId, artistName } = req.body || {};
  if (!uploadId || !artistName) return res.status(400).json({ error: 'uploadId and artistName required' });

  const jobId = crypto.randomBytes(8).toString('hex');
  const artist = artistName.toUpperCase().trim();

  const redis = createClient({ url: process.env.REDIS_URL });
  await redis.connect();
  try {
    const job = { jobId, uploadId, artistName: artist };
    // Push to local server's queue
    await redis.lPush('pipeline:queue', JSON.stringify(job));
    // Set initial status so dashboard can show it immediately
    await redis.set(
      `pipeline:job:${jobId}`,
      JSON.stringify({ done: 0, total: 30, status: 'queued', artistName: artist, updatedAt: Date.now() }),
      { EX: 7200 }
    );
    console.log(`[Trigger] Queued job ${jobId} for "${artist}" (uploadId=${uploadId})`);
    return res.status(200).json({ jobId });
  } finally {
    await redis.quit();
  }
}
