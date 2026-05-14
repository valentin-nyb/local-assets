import { createClient } from 'redis';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://local-assets.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Cookie');
  res.setHeader('Cache-Control', 'no-store, no-cache');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const redis = createClient({ url: process.env.REDIS_URL });
  try {
    await redis.connect();
    const { jobId } = req.query;

    if (jobId) {
      const raw = await redis.get(`pipeline:job:${jobId}`);
      if (!raw) return res.status(404).json({ error: 'Job not found' });
      return res.status(200).json(JSON.parse(raw));
    }

    const keys = await redis.keys('pipeline:job:*');
    const jobs = [];
    for (const key of keys) {
      const raw = await redis.get(key);
      if (!raw) continue;
      const job = JSON.parse(raw);
      if ((job.status === 'done' || job.status === 'error') &&
          Date.now() - (job.updatedAt || 0) > 3_600_000) continue;
      jobs.push(job);
    }
    jobs.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return res.status(200).json(jobs);
  } catch (e) {
    console.error('[pipeline-status] Redis error:', e.message);
    return res.status(500).json({ error: 'Failed to fetch pipeline status' });
  } finally {
    await redis.quit().catch(() => {});
  }
}
