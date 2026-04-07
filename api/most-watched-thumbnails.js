import fetch from 'node-fetch';

const TOKEN_ID = (process.env.PROD_MUX_TOKEN_ID || process.env.MUX_TOKEN_ID || '').trim();
const TOKEN_SECRET = (process.env.PROD_MUX_TOKEN_SECRET || process.env.MUX_TOKEN_SECRET || '').trim();
const AUTH = Buffer.from(`${TOKEN_ID}:${TOKEN_SECRET}`).toString('base64');

export default async function handler(req, res) {
  const { asset_id, playback_id } = req.query;
  if (!asset_id && !playback_id) {
    return res.status(400).json({ error: 'Missing asset_id or playback_id' });
  }

  try {
    // 1. Get playback_id if only asset_id is provided
    let pid = playback_id;
    if (!pid && asset_id) {
      const assetRes = await fetch(`https://api.mux.com/video/v1/assets/${asset_id}`, {
        headers: { Authorization: `Basic ${AUTH}` }
      });
      const assetData = await assetRes.json();
      pid = assetData.data?.playback_ids?.[0]?.id;
      if (!pid) return res.status(404).json({ error: 'No playback_id found for asset' });
    }

    // 2. Query Mux Data API for most watched times (using playing_time metric, breakdown by time offset)
    // We'll use the timeseries API to get watch time per minute, then pick the top 3
    const now = Math.floor(Date.now() / 1000);
    const timeframe = [now - 60 * 60 * 24 * 30, now]; // last 30 days
    const metric = 'playing_time';
    const group_by = 'minute';
    const url = `https://api.mux.com/data/v1/metrics/${metric}/timeseries?filters[]=playback_id:${pid}&group_by=${group_by}&timeframe[]=${timeframe[0]}&timeframe[]=${timeframe[1]}`;
    const dataRes = await fetch(url, { headers: { Authorization: `Basic ${AUTH}` } });
    const data = await dataRes.json();
    if (!data.data || !Array.isArray(data.data)) {
      return res.status(500).json({ error: 'No analytics data found' });
    }

    // Each entry: [timestamp, metric_value, views]
    // Find the 3 minutes with the highest playing_time
    const sorted = [...data.data].sort((a, b) => Number(b[1]) - Number(a[1]));
    const top3 = sorted.slice(0, 3).map(row => row[0]); // timestamps (ISO8601)
    // Convert ISO8601 to seconds offset from video start
    // We'll just use the minute offset (e.g. 10:00 = 600)
    const times = top3.map(ts => {
      const d = new Date(ts);
      return Math.floor((d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds()) / 1);
    });

    // 3. Build thumbnail URLs
    const thumbnails = times.map(t => `https://image.mux.com/${pid}/thumbnail.png?width=1920&time=${t}`);
    return res.status(200).json({ thumbnails });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
