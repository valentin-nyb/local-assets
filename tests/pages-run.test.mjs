// Every page opened in a real browser (headless Chrome) as a client, as the admin and as an artist with access,
// with the API answered by sample data: a script error on any page fails the tests, and with them the deploy.
// (A client dashboard once stopped loading because of an error that only happened on client accounts.)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';

const CHROME = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(p => p && fs.existsSync(p));
const pages = fs.readdirSync('.').filter(f => f.endsWith('.html'));

const now = Math.floor(Date.now() / 1000) - 86400;
const tracks = [{ type: 'video' }, { type: 'audio' }];
const ASSETS = [
  { id: 'm1', status: 'ready', duration: 3600, created_at: String(now), passthrough: 'DJ ONE', playback_ids: [{ id: 'p1' }], tracks },
  ...[1, 2, 3].map(n => ({ id: 'c' + n, status: 'ready', duration: 30, created_at: String(now), passthrough: 'DJ ONE // SOCIAL // 0' + n, meta: { external_id: 'm1' }, playback_ids: [{ id: 'pc' + n }], tracks })),
  { id: 'u61', status: 'ready', duration: 20, created_at: String(now), passthrough: 'DJ ONE // SOCIAL // 61', meta: { external_id: 'm1', creator_id: 'la-upload' }, playback_ids: [{ id: 'pu' }], tracks: [{ type: 'video' }] },
  { id: 'cam1', status: 'ready', duration: 3600, created_at: String(now), passthrough: 'DJ ONE // CAM1', playback_ids: [{ id: 'pk' }], tracks },
];
const SESSIONS = {
  client: { role: 'client', venueSlug: 'CAFE-1001', venue: 'CAFE 1001', name: 'CAFE 1001', email: 'client@example.com' },
  admin: { role: 'admin', venueSlug: 'local-assets-admin', venue: 'local / assets', name: 'local / assets', email: 'info@local-assets.com' },
  member: { role: 'client', venueSlug: 'CAFE-1001', venue: 'CAFE 1001', name: 'CAFE 1001', email: 'artist@example.com', member: { name: 'DJ ONE' } },
};

// Collects the page's own uncaught errors (cross-origin scripts only ever report "Script error.") and prints them
const PROBE = `<script>window.__laErrs=[];addEventListener('error',function(e){if(e.message&&e.message!=='Script error.')__laErrs.push(e.message+' (line '+e.lineno+')')});
addEventListener('unhandledrejection',function(e){var r=e.reason;__laErrs.push('Unhandled: '+(r&&r.message||r))});
setTimeout(function(){var p=document.createElement('pre');p.id='LA_ERRS';p.textContent=JSON.stringify(__laErrs);(document.body||document.documentElement).appendChild(p)},6000)</script>`;

let server, port;
before(async () => {
  server = http.createServer((q, r) => {
    const u = new URL(q.url, 'http://x');
    if (u.pathname.startsWith('/api/')) {
      r.setHeader('Content-Type', 'application/json');
      if (u.pathname === '/api/list-assets') return r.end(JSON.stringify(u.searchParams.get('only') === 'thumbs' ? [] : ASSETS));
      if (u.pathname === '/api/switch-venue') return r.end(JSON.stringify({ ok: true, accepted: true, version: 'test' }));
      return r.end('{}');
    }
    if (u.pathname === '/__as') {   // signs in as the given account, then opens the page
      const s = { ts: Date.now(), webToken: 'test', venues: [], ...SESSIONS[u.searchParams.get('who')] };
      r.setHeader('Content-Type', 'text/html');
      return r.end(`<script>localStorage.setItem('la_admin',${JSON.stringify(JSON.stringify(s))});location.replace(${JSON.stringify('/' + u.searchParams.get('p'))})</script>`);
    }
    const f = path.join('.', decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname));
    if (!path.extname(f) && fs.existsSync(f + '.html')) return r.writeHead(302, { Location: u.pathname + '.html' + u.search }).end();   // clean URLs, as on Vercel
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.statusCode = 404; return r.end(''); }
    let body = fs.readFileSync(f);
    if (f.endsWith('.html')) body = String(body).replace(/<head[^>]*>/i, m => m + PROBE);
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' }[path.extname(f)];
    if (type) r.setHeader('Content-Type', type);
    r.end(body);
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  port = server.address().port;
});
after(() => server?.close());

function open(page, who) {
  return new Promise((ok, bad) => {
    execFile(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--virtual-time-budget=10000', '--dump-dom',
      `http://127.0.0.1:${port}/__as?who=${who}&p=${encodeURIComponent(page)}`], { timeout: 60000, maxBuffer: 64 << 20 }, (e, out) => {
      if (e && !out) return bad(e);
      const m = String(out).match(/<pre id="LA_ERRS">([^<]*)<\/pre>/);
      ok(m ? JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')) : ['the page never finished loading']);
    });
  });
}

for (const who of Object.keys(SESSIONS)) {
  test(`every page opens without script errors as ${who === 'member' ? 'an artist with access' : 'the ' + who}`, { skip: !CHROME && !process.env.CI && 'no Chrome on this machine' }, async () => {
    assert.ok(CHROME, 'Chrome is needed to open the pages');
    // Four browsers at a time; a page that times out once is opened again before it counts as broken
    const results = [], queue = [...pages];
    await Promise.all([0, 1, 2, 3].map(async () => {
      for (let p; (p = queue.shift());) {
        let errs = await open(p, who);
        if (errs[0] === 'the page never finished loading') errs = await open(p, who);
        results.push([p, errs]);
      }
    }));
    assert.deepEqual(Object.fromEntries(results.filter(([, e]) => e.length)), {});
  });
}
