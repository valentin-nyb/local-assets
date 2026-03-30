import { muxFetch } from '../mux-proxy-client.js';

export default async function handler(req, res) {
  const { asset_id } = req.query;
  if (!asset_id) return res.status(400).json({ error: 'Missing asset_id' });

  try {
    const response = await muxFetch(`/video/v1/assets/${asset_id}`);
    const data = await response.json();
    
    if (!response.ok) throw new Error(data.error?.messages?.[0] || 'Mux Error');
    
    return res.status(200).json(data.data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}