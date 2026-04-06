const TOKEN_ID = (process.env.PROD_MUX_TOKEN_ID || process.env.MUX_TOKEN_ID || '').trim();
const TOKEN_SECRET = (process.env.PROD_MUX_TOKEN_SECRET || process.env.MUX_TOKEN_SECRET || '').trim();
const AUTH = Buffer.from(`${TOKEN_ID}:${TOKEN_SECRET}`).toString('base64');

async function muxGet(path) {
  const r = await fetch(`https://api.mux.com${path}`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${AUTH}` }
  });
  return r.json();
}

async function muxPost(path, body) {
  const r = await fetch(`https://api.mux.com${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${AUTH}` },
    body: JSON.stringify(body)
  });
  return { status: r.status, data: await r.json() };
}

async function muxDelete(path) {
  const r = await fetch(`https://api.mux.com${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Basic ${AUTH}` }
  });
  return r.status;
}

export default async function handler(req, res) {
  try {
    const result = await muxGet('/video/v1/assets?limit=100');
    const list = result.data || [];

    let created = 0;
    let skipped = 0;
    let fixed = 0;
    const errors = [];
    const details = [];

    for (const asset of list) {
      const name = asset.passthrough || asset.id;
      const srFiles = asset.static_renditions?.files || [];
      const hasReady = srFiles.some(f => f.status === 'ready');
      const hasPreparing = srFiles.some(f => f.status === 'preparing');
      const hasSkipped = srFiles.some(f => f.status === 'skipped');

      // Already done or in progress
      if (hasReady || hasPreparing) {
        skipped++;
        details.push({ name, action: 'skipped', reason: hasReady ? 'ready' : 'preparing' });
        continue;
      }

      // Determine correct resolution
      const hasVideo = asset.tracks?.some(t => t.type === 'video');
      const resolution = hasVideo ? 'highest' : 'audio-only';

      // If skipped/errored, delete existing renditions first
      if (hasSkipped || srFiles.some(f => f.status === 'errored')) {
        try {
          await muxDelete(`/video/v1/assets/${asset.id}/static-renditions`);
          details.push({ name, action: 'deleted-old', resolution });
        } catch (e) {
          errors.push({ name, error: 'delete failed: ' + e.message });
          continue;
        }
      }

      try {
        const resp = await muxPost(`/video/v1/assets/${asset.id}/static-renditions`, { resolution });
        if (resp.status >= 200 && resp.status < 300) {
          created++;
          details.push({ name, action: 'created', resolution });
        } else {
          errors.push({ name, error: resp.data });
        }
      } catch (e) {
        errors.push({ name, error: e.message });
      }
    }

    return res.status(200).json({ created, skipped, fixed, errors, details, total: list.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
