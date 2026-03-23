// Vercel Serverless Function: /api/get-asset.js
// Fetches asset details from Mux by asset_id

import { muxProxyFetch } from '../mux-proxy-client.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const { asset_id } = req.query;
  if (!asset_id) {
    res.status(400).json({ error: 'Missing asset_id' });
    return;
  }
  if (!process.env.MUX_PROXY_BASE_URL) {
    res.status(500).json({ error: 'MUX_PROXY_BASE_URL not set' });
    return;
  }
  try {
    const muxRes = await muxProxyFetch(`/video/v1/assets/${asset_id}`, {
      method: 'GET'
    });
    const data = await muxRes.json();
    if (!muxRes.ok || !data.data) {
      res.status(muxRes.status || 500).json({ error: data.error || 'Failed to fetch asset from Mux' });
      return;
    }
    res.status(200).json(data.data);
  } catch (e) {
    res.status(500).json({ error: e.message || 'Unknown error' });
  }
}
