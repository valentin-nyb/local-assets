import { getClientSession, getMuxAuth } from './_client-auth.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://local-assets.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Cookie');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { asset_id } = req.query;
  if (!asset_id) return res.status(400).json({ error: 'Missing asset_id' });

  const session = await getClientSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const { auth } = getMuxAuth(session.profile);

  try {
    const response = await fetch(`https://api.mux.com/video/v1/assets/${asset_id}`, {
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' }
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.messages?.[0] || 'Mux error');
    return res.status(200).json(data.data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
