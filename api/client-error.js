import { report } from './_report.js';

// Errors in the pages (sent by la-errors.js), passed on to Rollbar with the server's key so no key is in
// the pages. Public, as any visitor's page can break; only text is kept, cut short, and _report.js limits
// how many are sent.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = null; } }
  if (!b || typeof b.message !== 'string') return res.status(400).end();
  const text = (v, n) => typeof v === 'string' ? v.slice(0, n) : '';
  report({ name: text(b.name, 100) || 'Error', message: text(b.message, 500), stack: text(b.stack, 4000) }, '[browser]', {
    platform: 'browser',
    request: { url: text(b.page, 500) },
    client: { javascript: { browser: text(req.headers['user-agent'], 300) } },
  });
  return res.status(204).end();
}
