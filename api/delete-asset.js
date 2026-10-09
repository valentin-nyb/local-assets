import { del } from '@vercel/blob';
import { getWebSessionAuth } from './_venues.js';
import { thumbnailPrefix } from './_thumbnails.js';

// Permanently deletes one file from Distribution History.
//  - Mux assets: checked with the venue's own Mux token (another venue's asset returns 404),
//    then deleted in Mux.
//  - Uploaded thumbnails ("blob:<pathname>"): must live in this venue's thumbnails folder.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();

  const session = getWebSessionAuth(req);
  if (!session?.email) return res.status(401).json({ error: 'Not authenticated' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const id = String(body.id || '');

  try {
    if (id.startsWith('blob:')) {
      const pathname = id.slice(5);
      if (!session.venueSlug || !pathname.startsWith(thumbnailPrefix(session.venueSlug)) || pathname.includes('..')) {
        return res.status(403).json({ error: 'Not your file' });
      }
      const url = String(body.url || '');
      let ok = false;
      try { const u = new URL(url); ok = /\.public\.blob\.vercel-storage\.com$/.test(u.hostname) && decodeURIComponent(u.pathname.slice(1)) === pathname; } catch {}
      if (!ok) return res.status(400).json({ error: 'File link missing' });
      await del(url);
      return res.status(200).json({ ok: true });
    }

    if (!/^[A-Za-z0-9]{10,64}$/.test(id)) return res.status(400).json({ error: 'Invalid asset' });
    if (!session.muxAuth) return res.status(403).json({ error: 'No video account for this venue' });

    const check = await fetch(`https://api.mux.com/video/v1/assets/${id}`, {
      headers: { Authorization: session.muxAuth }, signal: AbortSignal.timeout(10000),
    });
    if (check.status === 404) return res.status(404).json({ error: 'Not found in your account' });
    if (!check.ok) return res.status(502).json({ error: `Cloud Storage error (${check.status})` });

    const r = await fetch(`https://api.mux.com/video/v1/assets/${id}`, {
      method: 'DELETE', headers: { Authorization: session.muxAuth }, signal: AbortSignal.timeout(10000),
    });
    if (!r.ok && r.status !== 404) return res.status(502).json({ error: `Cloud Storage error (${r.status})` });
    console.log('[delete-asset]', session.email, session.venueSlug, id);
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[delete-asset]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
