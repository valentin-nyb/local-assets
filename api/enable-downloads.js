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
      // Skip if static renditions already exist (ready or preparing)
      const srStatus = asset.static_renditions?.status;
      if (srStatus === 'ready' || srStatus === 'preparing') {
        skipped++;
        continue;
      }
      try {
        const resp = await muxPost(`/video/v1/assets/${asset.id}/static-renditions`, {
          resolution: 'highest'
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
