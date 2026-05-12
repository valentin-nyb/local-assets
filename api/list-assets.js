import { getWebSessionAuth } from './_venues.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://local-assets.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const session = getWebSessionAuth(req);
  if (!session?.muxAuth) {
    return res.status(200).json([]);
  }

  try {
    const allAssets = [];
    let page = 1;
    while (true) {
      const r = await fetch(
        `https://api.mux.com/video/v1/assets?limit=100&page=${page}`,
        { headers: { Authorization: session.muxAuth }, signal: AbortSignal.timeout(20000) }
      );
      if (!r.ok) {
        const txt = await r.text();
        return res.status(r.status).json({ error: txt });
      }
      const { data } = await r.json();
      if (!data || data.length === 0) break;
      allAssets.push(...data);
      if (data.length < 100) break;
      page++;
    }
    return res.status(200).json(allAssets);
  } catch (e) {
    console.error('[list-assets]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
