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

export default async function handler(req, res) {
  try {
    const result = await muxGet('/video/v1/assets?limit=100');
    const list = result.data || [];

    let created = 0;
    let skipped = 0;
    const errors = [];

    for (const asset of list) {
      // Skip if static renditions already exist
      const srFiles = asset.static_renditions?.files || [];
      const hasReady = srFiles.some(f => f.status === 'ready' || f.status === 'preparing');
      if (hasReady) {
        skipped++;
        continue;
      }
      // Determine if audio-only (no video tracks)
      const hasVideo = asset.tracks?.some(t => t.type === 'video');
      const resolution = hasVideo ? 'highest' : 'audio-only';
      try {
        const resp = await muxPost(`/video/v1/assets/${asset.id}/static-renditions`, {
          resolution
        });
        if (resp.status >= 200 && resp.status < 300) {
          created++;
        } else {
          errors.push({ id: asset.id, error: resp.data });
        }
      } catch (e) {
        errors.push({ id: asset.id, error: e.message });
      }
    }

    return res.status(200).json({ created, skipped, errors, total: list.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
