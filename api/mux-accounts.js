import { getWebSessionAuth } from './_venues.js';

// Admin check: which Mux key sets are configured, how many videos each holds, and which share an
// environment. Never returns key values.
const SETS = ['LOCAL_ASSETS_ADMIN', 'assets', 'PROD', ''];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const session = getWebSessionAuth(req);
  const admins = (process.env.BILLING_ADMINS || 'info@local-assets.com').split(/[\s,]+/).map(x => x.toLowerCase());
  if (!session?.email || !admins.includes(session.email)) return res.status(403).json({ error: 'Admin only' });
  const out = [];
  for (const s of SETS) {
    const id = (process.env[s ? `${s}_MUX_TOKEN_ID` : 'MUX_TOKEN_ID'] || '').trim();
    const secret = (process.env[s ? `${s}_MUX_TOKEN_SECRET` : 'MUX_TOKEN_SECRET'] || '').trim();
    if (!id || !secret) { out.push({ set: s || 'MUX', configured: false }); continue; }
    const auth = 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');
    try {
      const ids = [];
      for (let page = 1; page <= 10; page++) {
        const r = await fetch(`https://api.mux.com/video/v1/assets?limit=100&page=${page}`, { headers: { Authorization: auth }, signal: AbortSignal.timeout(15000) });
        const b = await r.json();
        if (!r.ok) throw new Error(b?.error?.messages?.[0] || r.status);
        ids.push(...(b.data || []).map(a => a.id));
        if ((b.data || []).length < 100) break;
      }
      out.push({ set: s || 'MUX', configured: true, videos: ids.length, sample: ids.slice(0, 3).map(x => x.slice(0, 6)) });
    } catch (e) { out.push({ set: s || 'MUX', configured: true, error: String(e.message) }); }
  }
  console.log('[mux-accounts]', JSON.stringify(out));
  return res.status(200).json({ accounts: out });
}
