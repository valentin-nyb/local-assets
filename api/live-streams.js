import { getWebSessionAuth } from './_venues.js';
import { listLiveStreams } from './_live.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).end();

  const session = getWebSessionAuth(req);
  if (!session?.email) return res.status(401).json({ error: 'Not authenticated' });
  if (!session.muxAuth) return res.status(200).json({ streams: [] });

  try {
    return res.status(200).json({ streams: await listLiveStreams(session.muxAuth) });
  } catch (e) {
    console.error('[live-streams]', e.message);
    return res.status(502).json({ error: 'Could not load cameras from Mux' });
  }
}
