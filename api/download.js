import { list } from '@vercel/blob';
import { getWebSessionAuth } from './_venues.js';

// The a™ installer for Mac, only for signed-in accounts (customers): the files live in Blob storage under
// random names (apps/mac/local-assets-<arch>-<random>.dmg) and their addresses are handed out here, never
// published or kept in this (public) repository. The newest upload for each Mac type is the one given.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).end();
  const session = getWebSessionAuth(req);
  if (!session?.email) return res.status(401).json({ error: 'Sign in to download' });
  const arch = req.query.arch === 'x64' ? 'x64' : 'arm64';
  try {
    const { blobs } = await list({ prefix: `apps/mac/local-assets-${arch}`, limit: 100 });
    const latest = blobs.filter(b => /\.dmg$/i.test(b.pathname)).sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))[0];
    if (!latest) return res.status(404).json({ error: 'The installer is not available yet' });
    console.log('[download]', session.email, arch);
    return res.status(200).json({ url: latest.url, size: latest.size, arch });
  } catch (e) {
    console.error('[download]', e.message);
    return res.status(500).json({ error: 'Could not get the installer' });
  }
}
