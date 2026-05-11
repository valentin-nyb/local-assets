import { getClientSession, getMuxAuth } from './_client-auth.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://local-assets.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Cookie');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const session = await getClientSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const { tokenId, tokenSecret } = getMuxAuth(session.profile);

  try {
    const { default: Mux } = await import('@mux/mux-node');
    const mux = new Mux({ tokenId, tokenSecret });
    const assets = await mux.video.assets.list({ limit: 100 });
    return res.status(200).json(assets);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
