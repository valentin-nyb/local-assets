importScripts('/vendor/client-zip-2.5.1-worker.js');

const CACHE_NAME = 'la-v5';

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── Session ZIP downloads ─────────────────────────────────────────────
// The dashboard registers a file list here, then opens /__la-zip/<id>/<name>.zip.
// The ZIP is assembled as a stream while it downloads, so multi-GB masters never
// have to fit in memory.
const zipJobs = new Map();

self.addEventListener('message', event => {
  const msg = event.data || {};
  if (msg.type === 'la-zip' && msg.id && Array.isArray(msg.files)) {
    zipJobs.set(msg.id, msg);
    if (event.ports[0]) event.ports[0].postMessage({ ok: true });
  }
  // 'la-zip-ping' messages only keep this worker alive during long downloads.
});

async function notifyClients(message) {
  const all = await self.clients.matchAll({ includeUncontrolled: true });
  all.forEach(c => c.postMessage(message));
}

async function* zipEntries(job) {
  for (const f of job.files) {
    const name = job.folder + '/' + f.path;
    try {
      const res = await fetch(f.url, { mode: 'cors' });
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
      yield { name, input: res };
    } catch (e) {
      yield { name: name + '.FAILED.txt', input: 'Could not download ' + f.url + ' (' + e.message + '). Try downloading this file from the dashboard.' };
    }
  }
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith('/__la-zip/')) return;

  const id = url.pathname.split('/')[2];
  const job = zipJobs.get(id);
  if (!job) {
    event.respondWith(new Response('This download link has expired. Click Download on the dashboard again.', { status: 404 }));
    return;
  }
  zipJobs.delete(id);

  const zip = downloadZip(zipEntries(job));
  let sent = 0;
  const counted = zip.body.pipeThrough(new TransformStream({
    transform(chunk, ctl) { sent += chunk.byteLength; ctl.enqueue(chunk); },
    flush() { notifyClients({ type: 'la-zip-done', id, bytes: sent }); },
  }));
  event.respondWith(new Response(counted, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="' + job.folder + '.zip"',
      'Cache-Control': 'no-store',
    },
  }));
});
