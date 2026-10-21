// Every API endpoint, called with no sign-in, must refuse (or be one of the few public ones).
// Runs with no secrets or database: nothing here can reach a real account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const API = path.resolve('api');
// Public on purpose: Brand Kit file links, plan prices, sign-in and OAuth callbacks, signed webhooks
const PUBLIC = new Set(['asset.js', 'plans.js', 'google-auth.js', 'google-callback.js', 'verify-magic-link.js',
  'soundcloud-callback.js', 'soundcloud-venue-callback.js', 'youtube-callback.js', 'mux-webhook.js', 'stripe-webhook.js',
  'order-camera.js', 'create-checkout.js', 'next-event.js', 'list-assets.js']);
const REFUSED = new Set([400, 401, 403, 404, 405]);

function fakeRes() {
  return { code: 200, setHeader() {}, getHeader() {}, status(c) { this.code = c; return this; }, json() { return this; }, send() { return this; }, end() { return this; }, redirect(a) { this.code = typeof a === 'number' ? a : 302; return this; } };
}

for (const f of fs.readdirSync(API).filter(f => f.endsWith('.js') && !f.startsWith('_') && !PUBLIC.has(f))) {
  test(`${f} refuses callers who aren't signed in`, async () => {
    const { default: handler } = await import(path.join(API, f));
    for (const method of ['GET', 'POST']) {
      const res = fakeRes();
      await Promise.race([handler({ method, headers: {}, query: {}, body: {}, url: '/api/' + f.slice(0, -3), cookies: {} }, res), new Promise(r => setTimeout(r, 3000))]);
      assert.ok(REFUSED.has(res.code), `${method} answered ${res.code}`);
    }
  });
}
