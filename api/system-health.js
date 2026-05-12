import { promisify } from 'util';
import { exec } from 'child_process';
import { getClientSession, getMuxAuth } from './_client-auth.js';

const execAsync = promisify(exec);

// Time a POST of a fixed payload to measure upload throughput
async function measureUploadMbps() {
  const SIZE = 512 * 1024; // 512 KB
  const payload = 'x'.repeat(SIZE);
  const start = Date.now();
  try {
    await fetch('https://httpbin.org/post', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: payload,
      signal: AbortSignal.timeout(12000),
    });
    const secs = (Date.now() - start) / 1000;
    const mbps = (SIZE * 8) / (secs * 1_000_000);
    return Math.round(mbps * 10) / 10;
  } catch {
    return null;
  }
}

// Paginate MUX assets and sum static_renditions filesize bytes
async function getMuxStorageGB(auth) {
  let totalBytes = 0;
  let page = 1;
  const base = 'https://api.mux.com';
  const headers = {
    'Authorization': 'Basic ' + Buffer.from(`${auth.tokenId}:${auth.tokenSecret}`).toString('base64'),
  };

  while (true) {
    const url = `${base}/video/v1/assets?limit=100&page=${page}`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    if (!res.ok) break;
    const { data } = await res.json();
    if (!data || data.length === 0) break;

    for (const asset of data) {
      const files = asset.static_renditions?.files ?? [];
      for (const f of files) {
        totalBytes += parseInt(f.filesize || 0, 10);
      }
    }

    if (data.length < 100) break;
    page++;
  }

  return Math.round((totalBytes / 1e9) * 100) / 100;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://local-assets.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Resolve MUX credentials for this client (falls back to global env)
  let muxAuth = null;
  try {
    const { profile } = await getClientSession(req);
    muxAuth = getMuxAuth(profile);
  } catch {
    // Fall back to env-level credentials
    const tokenId = process.env.MUX_TOKEN_ID;
    const tokenSecret = process.env.MUX_TOKEN_SECRET;
    if (tokenId && tokenSecret) {
      muxAuth = { tokenId, tokenSecret };
    }
  }

  const [uploadMbps, storageGB] = await Promise.all([
    measureUploadMbps(),
    muxAuth ? getMuxStorageGB(muxAuth).catch(() => null) : Promise.resolve(null),
  ]);

  return res.status(200).json({
    uploadMbps,
    storageGB,
    storageLimitGB: 5000, // 5 TB default display limit
    timestamp: Date.now(),
  });
}
