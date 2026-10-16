// Local development server: npm run dev → http://localhost:4600
// Serves the pages and scripts from this folder, so changes to HTML, CSS and JS show on reload with
// no deploy. Every /api call goes to the live platform (https://local-assets.com), so data is real and
// no keys are needed on this computer. Changes to files in api/ only take effect once deployed.
// Sign in on the local login page: Google hands the session back to this server.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 4600;
const LIVE = 'https://local-assets.com';
const PRIVATE = /^\/(api|server|db|scripts|relay|node_modules|electron-app)(\/|$)|\/\./;   // never served as files
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8' };

// Writes the session Google handed back, as the live sign-in does, then opens the dashboard
const SESSION_PAGE = `<!doctype html><meta charset="utf-8"><title>Signing in</title><script>
try {
  var s = location.hash.slice(1).replace(/-/g, '+').replace(/_/g, '/');
  var data = JSON.parse(decodeURIComponent(escape(atob(s))));
  localStorage.setItem('la_admin', JSON.stringify(data));
  if (data.venue && data.venue !== 'Admin') localStorage.setItem('la_venue_name', String(data.venue).toUpperCase()); else localStorage.removeItem('la_venue_name');
  localStorage.removeItem('la_revenue_cache_v2');
  location.replace('/dashboard');
} catch (e) { location.replace('/login.html?error=auth_failed'); }
</script>`;

function proxy(req, res) {
  const headers = { ...req.headers, host: 'local-assets.com', origin: LIVE, referer: LIVE + '/' };
  delete headers['accept-encoding'];
  delete headers.connection;
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', async () => {
    try {
      const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks);
      const r = await fetch(LIVE + req.url, { method: req.method, headers, body, redirect: 'manual' });
      const out = {};
      r.headers.forEach((v, k) => { if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'set-cookie'].includes(k)) out[k] = v; });
      if (out.location?.startsWith(LIVE)) out.location = out.location.slice(LIVE.length) || '/';
      res.writeHead(r.status, out);
      res.end(Buffer.from(await r.arrayBuffer()));
      console.log(`${req.method} ${req.url.split('?')[0]} → live ${r.status}`);
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Could not reach local-assets.com: ' + e.message }));
    }
  });
}

function serveFile(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (PRIVATE.test(p)) { res.writeHead(404); return res.end('Not found'); }
  if (p === '/') p = '/index.html';
  let file = path.join(ROOT, p);
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(404); return res.end('Not found'); }
  if (!path.extname(file) && fs.existsSync(file + '.html')) file += '.html';      // clean URLs, as on Vercel
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
}

http.createServer((req, res) => {
  const p = req.url.split('?')[0];
  if (p === '/__dev/session') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(SESSION_PAGE); }
  if (p.startsWith('/api/')) return proxy(req, res);
  if (p.startsWith('/asset/')) { req.url = '/api/asset?path=brand/' + p.slice(7); return proxy(req, res); }
  serveFile(req, res);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`local / assets dev → http://localhost:${PORT}  (pages from this folder, /api from ${LIVE})`);
});
