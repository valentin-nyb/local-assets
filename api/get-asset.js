// Vercel Serverless Function: /api/get-asset.js
// Fetches asset details from Mux by asset_id

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
  const muxTokenId = process.env.49c2dd4c-5ba5-4e93-b60b-54afee697b41;
  const muxTokenSecret = process.env.M3W9cB0gXQ2ki+nYpJc9pdWYW5q0ZlCORrd8URup4lqlUyxbiRfXssWRNdWRiQbEmIZkPSgIjTT;
  if (!muxTokenId || !muxTokenSecret) {
    res.status(500).json({ error: 'Mux credentials not set' });
    return;
  }
  try {
    const muxRes = await fetch(`https://api.mux.com/video/v1/assets/${asset_id}`, {
      method: 'GET',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(muxTokenId + ':' + muxTokenSecret).toString('base64'),
        'Content-Type': 'application/json',
      }
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
