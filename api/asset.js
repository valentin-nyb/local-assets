import { head } from '@vercel/blob';

// Branded links for brand-kit files: local-assets.com/asset/<venue>/<owner>/<category>/<file>
// (rewritten here as ?path=brand/...). Opening a link shows the file on a local-assets.com page,
// so the address bar never shows the storage URL. ?download downloads it; ?raw redirects to the file.
// Only brand-kit files are reachable this way.
const PATH = /^brand\/[A-Za-z0-9-]+\/(venue|(?:artist|venue|label)-[a-z0-9]+(?:-[a-z0-9]+)*)\/(logos|covers|artwork|photos|guidelines|fonts|other)\/[A-Za-z0-9._-]+$/;
const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;
const PDF = /\.pdf$/i;

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtSize(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + ' MB';
  return Math.max(1, Math.round(n / 1e3)) + ' KB';
}

function viewer(blob, path) {
  const file = path.split('/').pop();
  // addRandomSuffix turns "logo.png" into "logo-AbC123xyz.png"; show the original name
  const name = file.replace(/-[A-Za-z0-9]{20,40}(\.[^.]+)$/, '$1');
  const self = '/asset/' + path.slice('brand/'.length).split('/').map(encodeURIComponent).join('/');
  const body = IMAGE.test(file)
    ? `<img src="${esc(blob.url)}" alt="${esc(name)}">`
    : PDF.test(file)
      ? `<iframe src="${esc(blob.url)}" title="${esc(name)}"></iframe>`
      : `<p class="none">This file can't be shown in the browser.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name)} · local / assets</title>
<link rel="icon" href="/favicon/favicon.svg" type="image/svg+xml">
<meta name="robots" content="noindex">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; }
  html, body { height: 100%; }
  body { background: #0a0a0a; color: #fafafa; font: 14px/1.4 Inter, ui-sans-serif, system-ui, -apple-system, sans-serif; display: flex; flex-direction: column; }
  header { display: flex; align-items: center; gap: 16px; padding: 12px 16px; border-bottom: 1px solid #1f1f22; }
  .brand { font-weight: 700; letter-spacing: -.02em; color: #fafafa; text-decoration: none; white-space: nowrap; }
  .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #a1a1aa; }
  .meta { color: #71717a; white-space: nowrap; }
  .dl { height: 32px; padding: 0 14px; border-radius: 8px; background: #fafafa; color: #0a0a0a; font-weight: 600; font-size: 13px; text-decoration: none; display: inline-flex; align-items: center; white-space: nowrap; }
  main { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; padding: 24px; }
  img { max-width: 100%; max-height: 100%; object-fit: contain; }
  iframe { width: 100%; height: 100%; border: 0; border-radius: 8px; background: #fff; }
  .none { color: #a1a1aa; }
  @media (max-width: 640px) { .meta { display: none; } main { padding: 12px; } }
</style></head><body>
<header><a class="brand" href="/">local / assets</a><span class="name">${esc(name)}</span><span class="meta">${esc(fmtSize(blob.size))}</span><a class="dl" href="${esc(self)}?download">Download</a></header>
<main>${body}</main>
</body></html>`;
}

export default async function handler(req, res) {
  const path = String(req.query.path || '');
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).end();
  if (!PATH.test(path)) return res.status(404).send('Not found');
  try {
    const blob = await head(path);
    res.setHeader('Cache-Control', 'public, max-age=300');
    if ('download' in req.query) return res.redirect(302, blob.downloadUrl);
    if ('raw' in req.query) return res.redirect(302, blob.url);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(viewer(blob, path));
  } catch (e) {
    return res.status(404).send('This file is no longer available.');
  }
}
