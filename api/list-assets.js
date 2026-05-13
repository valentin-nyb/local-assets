import { getWebSessionAuth } from './_venues.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://local-assets.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-Email');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const rawEmail = (req.headers['x-user-email'] || '').trim();
  const authHdr  = (req.headers['authorization'] || '').trim();
  console.error('[list-assets] incoming headers:', JSON.stringify({
    'x-user-email': rawEmail || '(not set)',
    'authorization': authHdr ? authHdr.slice(0, 20) + '…' : '(not set)',
  }));

  const session = getWebSessionAuth(req);

  console.error('[list-assets] session:', JSON.stringify({
    email:          session?.email          ?? null,
    venueSlug:      session?.venueSlug      ?? null,
    hasMuxCreds:    !!session?.muxAuth,
    hasMuxTokenId:  !!(session?.venue?.mux_token_id),
    hasMuxSecret:   !!(session?.venue?.mux_token_secret),
  }));

  if (!session?.muxAuth) {
    console.error('[list-assets] no muxAuth — returning []');
    return res.status(200).json([]);
  }

  try {
    const allAssets = [];
    let page = 1;
    while (true) {
      const url = `https://api.mux.com/video/v1/assets?limit=100&page=${page}`;
      console.error('[list-assets] fetching:', url);
      const r = await fetch(url, {
        headers: { Authorization: session.muxAuth },
        signal: AbortSignal.timeout(20000),
      });
      if (!r.ok) {
        const txt = await r.text();
        console.error('[list-assets] Mux error', r.status, txt);
        return res.status(r.status).json({ error: txt });
      }
      const { data } = await r.json();
      console.error('[list-assets] page', page, '— items:', data?.length ?? 0);
      if (!data || data.length === 0) break;
      allAssets.push(...data);
      if (data.length < 100) break;
      page++;
    }
    console.error('[list-assets] total assets returned:', allAssets.length);
    return res.status(200).json(allAssets);
  } catch (e) {
    console.error('[list-assets] exception:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
