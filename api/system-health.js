import { getWebSessionAuth } from './_venues.js';

async function measureUploadMbps() {
  const SIZE = 512 * 1024;
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
    return Math.round(((SIZE * 8) / (secs * 1_000_000)) * 10) / 10;
  } catch {
    return null;
  }
}

async function getMuxStorageGB(muxAuth) {
  let totalBytes = 0;
  let page = 1;
  while (true) {
    const url = `https://api.mux.com/video/v1/assets?limit=100&page=${page}`;
    const res = await fetch(url, { headers: { Authorization: muxAuth }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) break;
    const { data } = await res.json();
    if (!data || data.length === 0) break;
    for (const asset of data) {
      for (const f of (asset.static_renditions?.files ?? [])) {
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-Email');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const session = getWebSessionAuth(req);
  const muxAuth = session?.muxAuth || null;

  console.error('[system-health] email:', session?.email ?? null, '| hasMuxAuth:', !!muxAuth);

  const [uploadMbps, storageGB] = await Promise.all([
    measureUploadMbps(),
    muxAuth ? getMuxStorageGB(muxAuth).catch(() => null) : Promise.resolve(null),
  ]);

  return res.status(200).json({
    uploadMbps,
    storageGB,
    storageLimitGB: 5000,
    timestamp: Date.now(),
  });
}
