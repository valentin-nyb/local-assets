import { createClient } from 'redis';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://local-assets.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store, no-cache');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const redis = createClient({ url: process.env.REDIS_URL });
  
  try {
    await redis.connect();
    
    if (req.method === 'GET') {
      // Example: Get a value from Redis
      const { key } = req.query;
      if (!key) return res.status(400).json({ error: 'Missing key parameter' });
      
      const result = await redis.get(key);
      return res.status(200).json({ key, value: result });
    }
    
    if (req.method === 'POST') {
      // Example: Set a value in Redis
      const { key, value, expirySeconds } = req.body || {};
      if (!key || !value) return res.status(400).json({ error: 'Missing key or value' });
      
      if (expirySeconds) {
        await redis.set(key, value, { EX: expirySeconds });
      } else {
        await redis.set(key, value);
      }
      
      return res.status(200).json({ success: true, key, value });
    }
    
    return res.status(405).json({ error: 'Method not allowed' });
    
  } catch (err) {
    console.error('[redis-example]', err.message);
    return res.status(500).json({ error: err.message });
  } finally {
    await redis.quit();
  }
}
