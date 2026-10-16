import { getWebSessionAuth, getVenuesConfig, getMuxAuthForVenue, isAdminVenue, platformAdmins } from './_venues.js';
import { listThumbnailAssets } from './_thumbnails.js';
import crypto from 'crypto';

// Every asset in a Mux environment. The first page comes alone; if it's full, the next pages are fetched
// four at a time instead of one after another.
async function muxAllAssets(auth) {
  const page = async n => {
    const r = await fetch(`https://api.mux.com/video/v1/assets?limit=100&page=${n}`, { headers: { Authorization: auth }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) { const e = new Error('Mux ' + r.status); e.status = r.status; e.body = await r.text().catch(() => ''); throw e; }
    return (await r.json()).data || [];
  };
  const all = await page(1);
  if (all.length < 100) return all;
  for (let next = 2; next <= 40; next += 4) {
    const batch = await Promise.all([0, 1, 2, 3].map(i => page(next + i)));
    for (const b of batch) all.push(...b);
    if (batch.some(b => b.length < 100)) break;
  }
  return all;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://local-assets.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-Email');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const session = getWebSessionAuth(req);

  console.error('[list-assets] session:', JSON.stringify({
    email:          session?.email          ?? null,
    venueSlug:      session?.venueSlug      ?? null,
    hasMuxCreds:    !!session?.muxAuth,
    hasMuxTokenId:  !!(session?.venue?.mux_token_id),
    hasMuxSecret:   !!(session?.venue?.mux_token_secret),
  }));

  // Admin account: every client's Distribution History together, each asset marked with its account
  if (session?.email && platformAdmins().includes(session.email) && isAdminVenue(session.venue) && !req.headers['x-la-venue']) {
    // Every client at once, each with its videos and thumbnails fetched together
    const out = [];
    const clients = Object.entries(getVenuesConfig()).filter(([slug, cfg]) => !isAdminVenue({ slug, ...cfg }) && getMuxAuthForVenue({ slug, ...cfg }));
    const lists = await Promise.all(clients.map(async ([slug, cfg]) => {
      const tag = a => ({ ...a, _venue: slug, _venueName: cfg.name || slug });
      try {
        const [videos, thumbs] = await Promise.all([muxAllAssets(getMuxAuthForVenue({ slug, ...cfg })), listThumbnailAssets(slug).catch(() => [])]);
        return videos.concat(thumbs).map(tag);
      } catch (e) { console.error('[list-assets] admin view', slug, e.message); return []; }
    }));
    for (const l of lists) out.push(...l);
    // Isolation check: two clients whose keys reach the same Mux environment would see the same videos.
    // Logs a short fingerprint of each key (never the key) and any clients that share videos.
    const seen = {}, fp = {};
    for (const [slug, cfg] of Object.entries(getVenuesConfig())) {
      const auth = getMuxAuthForVenue({ slug, ...cfg });
      if (auth && !isAdminVenue({ slug, ...cfg })) fp[slug] = crypto.createHash('sha256').update(auth).digest('hex').slice(0, 8);
    }
    for (const a of out) if (a.id && !a.source) (seen[a.id] = seen[a.id] || new Set()).add(a._venue);
    const shared = {};
    for (const set of Object.values(seen)) if (set.size > 1) { const k = [...set].sort().join(' + '); shared[k] = (shared[k] || 0) + 1; }
    console.log('[list-assets] isolation', JSON.stringify({ keys: fp, videos: Object.fromEntries(Object.keys(fp).map(s => [s, out.filter(a => a._venue === s && !a.source).length])), shared }));
    return res.status(200).json(out);
  }

  // ?only=thumbs: just this account's session thumbnails (images, fast), e.g. for See session in Camera Control
  if (req.query?.only === 'thumbs') {
    if (!session?.venueSlug) return res.status(200).json([]);
    return res.status(200).json(await listThumbnailAssets(session.venueSlug).catch(() => []));
  }

  if (!session?.muxAuth) {
    console.error('[list-assets] no muxAuth — returning []');
    return res.status(200).json([]);
  }

  try {
    // Videos and uploaded thumbnails (plain images in Vercel Blob, not Mux assets) at the same time
    let allAssets;
    try {
      const [videos, thumbs] = await Promise.all([
        muxAllAssets(session.muxAuth),
        session.venueSlug ? listThumbnailAssets(session.venueSlug).catch(e => { console.error('[list-assets] thumbnail list failed:', e.message); return []; }) : [],
      ]);
      allAssets = videos.concat(thumbs);
    } catch (e) {
      if (e.status) { console.error('[list-assets] Mux error', e.status, e.body); return res.status(e.status).json({ error: e.body || e.message }); }
      throw e;
    }
    console.error('[list-assets] total assets returned:', allAssets.length);
    return res.status(200).json(allAssets);
  } catch (e) {
    console.error('[list-assets] exception:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
