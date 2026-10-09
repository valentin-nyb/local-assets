import { head } from '@vercel/blob';

// Branded links for brand-kit files: local-assets.com/asset/<venue>/<owner>/<category>/<file>
// (rewritten here as ?path=brand/...). Redirects to the file in Vercel Blob, so links can be
// shared without exposing the storage URL. Only brand-kit files are reachable this way.
const PATH = /^brand\/[a-z0-9-]+\/(venue|artist-[a-z0-9]+(?:-[a-z0-9]+)*)\/(logos|guidelines|fonts|other)\/[A-Za-z0-9._-]+$/;

export default async function handler(req, res) {
  const path = String(req.query.path || '');
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).end();
  if (!PATH.test(path)) return res.status(404).send('Not found');
  try {
    const blob = await head(path);
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.redirect(302, 'download' in req.query ? blob.downloadUrl : blob.url);
  } catch (e) {
    return res.status(404).send('This file is no longer available.');
  }
}
