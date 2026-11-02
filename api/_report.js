import { format } from 'node:util';
import { waitUntil } from '@vercel/functions';

// Error reports to Rollbar (Vercel → Integrations → Rollbar holds the key, ROLLBAR_..._SERVER_TOKEN_...).
// Every endpoint imports this file: from then on anything written with console.error, by our code or by
// Vercel for an error an endpoint throws, also goes to Rollbar. Off when there's no key (this computer, tests).
// Rollbar's free plan counts 5,000 a month, so the same error is sent once per 10 minutes per running copy,
// and at most 20 reports a minute.
const TOKEN = Object.entries(process.env).find(([k]) => /^ROLLBAR_.*SERVER_TOKEN/.test(k))?.[1];
const seen = new Map();
let minute = 0, sentThisMinute = 0;

// Stack lines from Node and Chrome ("at fn (file:1:2)") and from Safari and Firefox ("fn@file:1:2"),
// oldest call first as Rollbar wants
function frames(stack) {
  const out = [];
  for (const line of String(stack || '').split('\n')) {
    const m = line.match(/^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/) || line.match(/^\s*([^@]*)@(.+?):(\d+):(\d+)$/);
    if (m) out.push({ method: m[1] || '(anonymous)', filename: m[2], lineno: Number(m[3]), colno: Number(m[4]) });
  }
  return out.reverse();
}

// err: an Error, or anything with name / message / stack (a browser report). note: what was said with it.
export function report(err, note = '', extra = {}) {
  if (!TOKEN) return;
  const message = [note, err?.message ?? (err == null ? '' : String(err))].filter(Boolean).join(' ').slice(0, 1000);
  // Node's own warnings ("(node:8) ExperimentalWarning: …", from Vercel's runtime) aren't errors of ours
  if (/^\(node:\d+\) \w*Warning:/.test(message)) return;
  const key = message.slice(0, 200);
  const now = Date.now();
  if (now - (seen.get(key) || 0) < 10 * 60 * 1000) return;
  if (Math.floor(now / 60000) !== minute) { minute = Math.floor(now / 60000); sentThisMinute = 0; }
  if (++sentThisMinute > 20) return;
  seen.set(key, now);
  if (seen.size > 500) seen.delete(seen.keys().next().value);

  const trace = frames(err?.stack);
  const body = trace.length
    ? { trace: { frames: trace, exception: { class: err.name || 'Error', message } } }
    : { message: { body: message } };
  const sent = fetch('https://api.rollbar.com/api/1/item/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Rollbar-Access-Token': TOKEN },
    body: JSON.stringify({ data: {
      environment: process.env.VERCEL_ENV || 'development', platform: extra.platform || 'node', language: 'javascript',
      level: 'error', timestamp: Math.floor(now / 1000), body,
      code_version: process.env.VERCEL_GIT_COMMIT_SHA || undefined,
      server: { host: process.env.VERCEL_URL || undefined },
      ...(extra.request ? { request: extra.request } : {}),
      ...(extra.client ? { client: extra.client } : {}),
    } }),
  }).catch(() => {});
  try { waitUntil(sent); } catch {}
}

if (TOKEN && !console.error.laReported) {
  const original = console.error;
  console.error = function (...args) {
    original.apply(console, args);
    try {
      const err = args.find(a => a instanceof Error);
      report(err || format(...args), err ? format(...args.filter(a => a !== err)) : '');
    } catch {}
  };
  console.error.laReported = true;
}
