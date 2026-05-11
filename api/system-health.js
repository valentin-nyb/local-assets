import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// df -P gives POSIX output: Filesystem 1024-blocks Used Available Capacity Mounted
async function getDiskUsagePct() {
  try {
    const { stdout } = await execAsync('df -P /');
    const line = stdout.trim().split('\n')[1];
    const parts = line.split(/\s+/);
    // parts[4] = "35%" capacity
    return parseFloat(parts[4]);
  } catch {
    return null;
  }
}

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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://local-assets.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const [diskPct, uploadMbps] = await Promise.all([
    getDiskUsagePct(),
    measureUploadMbps(),
  ]);

  return res.status(200).json({
    uploadMbps,
    diskPct,
    timestamp: Date.now(),
  });
}
