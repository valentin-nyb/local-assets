import { getClientSession, getMuxAuth } from './_client-auth.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://local-assets.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Cookie');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const session = await getClientSession(req);
  if (!session) {
    console.error('[list-assets] No session — cookie:', req.headers.cookie ? 'present' : 'missing');
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { tokenId, tokenSecret } = getMuxAuth(session.profile);
  const authHeader = 'Basic ' + Buffer.from(`${tokenId}:${tokenSecret}`).toString('base64');

  try {
    const allAssets = [];
    let page = 1;

    while (true) {
      const response = await fetch(
        `https://api.mux.com/video/v1/assets?limit=100&page=${page}`,
        {
          headers: { Authorization: authHeader },
          signal: AbortSignal.timeout(20000),
        }
      );
      if (!response.ok) {
        const text = await response.text();
        return res.status(response.status).json({ error: text });
      }
      const json = await response.json();
      const assets = json.data || [];
      allAssets.push(...assets);
      if (assets.length < 100) break;
      page++;
    }

    return res.status(200).json(allAssets);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
