import { getClientSession, getMuxAuth } from './_client-auth.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://local-assets.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Cookie');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { asset_id, playback_id } = req.query;
  if (!asset_id && !playback_id) return res.status(400).json({ error: 'Missing asset_id or playback_id' });

  const session = await getClientSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const { auth } = getMuxAuth(session.profile);

  try {
    let pid = playback_id;
    if (!pid && asset_id) {
      const assetRes = await fetch(`https://api.mux.com/video/v1/assets/${asset_id}`, {
        headers: { Authorization: `Basic ${auth}` }
      });
      const assetData = await assetRes.json();
      pid = assetData.data?.playback_ids?.[0]?.id;
      if (!pid) return res.status(404).json({ error: 'No playback_id found for asset' });
    }

    const now = Math.floor(Date.now() / 1000);
    const timeframe = [now - 60 * 60 * 24 * 30, now];
    const url = `https://api.mux.com/data/v1/metrics/playing_time/timeseries?filters[]=playback_id:${pid}&group_by=minute&timeframe[]=${timeframe[0]}&timeframe[]=${timeframe[1]}`;
    const dataRes = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
    const data = await dataRes.json();

    if (!data.data || !Array.isArray(data.data)) return res.status(500).json({ error: 'No analytics data' });

    const top3 = [...data.data].sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 3).map(row => row[0]);
    const times = top3.map(ts => {
      const d = new Date(ts);
      return d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
    });

    return res.status(200).json({ thumbnails: times.map(t => `https://image.mux.com/${pid}/thumbnail.png?width=1920&time=${t}`) });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
