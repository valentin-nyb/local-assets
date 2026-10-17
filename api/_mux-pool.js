import crypto from 'crypto';
import { sealSecret, openSecret, getVenuesConfig, readRegistryRaw, saveRegistryEntry } from './_venues.js';

// Ready video storage: empty Mux environments local / assets creates ahead of time (Billing → Ready video
// storage). A new sign-up takes one straight away, so the account works from its first login.
// Redis "mux_pool": a list of JSON { key, label, mux: <sealed "id:secret">, muxWebhook: <sealed>, addedAt }.
// Keys are only ever stored sealed and never sent back to the browser.
const POOL_KEY = 'mux_pool';

const authOf = (id, secret) => 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');

// The token must work and the environment must be empty: a client never gets an environment that
// already holds someone's videos or live streams
export async function checkEmptyEnvironment(id, secret) {
  const get = path => fetch(`https://api.mux.com/video/v1/${path}?limit=1`, { headers: { Authorization: authOf(id, secret) }, signal: AbortSignal.timeout(15000) });
  const a = await get('assets');
  if (a.status === 401 || a.status === 403) return 'Mux rejected these keys. Copy them again from the environment\'s Access Tokens (Mux Video read and write).';
  if (!a.ok) return `Mux answered ${a.status}`;
  if (((await a.json()).data || []).length) return 'This environment already has videos. Use a new, empty environment for each client.';
  const l = await get('live-streams');
  if (l.ok && ((await l.json()).data || []).length) return 'This environment already has live streams. Use a new, empty environment for each client.';
  return null;
}

// Token IDs already given to an account or waiting in the pool
async function tokenIdsInUse(redis) {
  const used = new Set();
  for (const [slug, v] of Object.entries(getVenuesConfig())) {
    if (v.mux_token_id) used.add(String(v.mux_token_id).trim());
    const env = slug.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    for (const k of [env, env.replace(/_TEAM$/, ''), env.replace(/_TEAM$/, '') + '_TEAM']) if (process.env[`${k}_MUX_TOKEN_ID`]) used.add(process.env[`${k}_MUX_TOKEN_ID`].trim());
  }
  for (const k of ['MUX_TOKEN_ID', 'LOCAL_ASSETS_ADMIN_MUX_TOKEN_ID', 'assets_MUX_TOKEN_ID', 'PROD_MUX_TOKEN_ID']) if (process.env[k]) used.add(process.env[k].trim());
  for (const e of await readPool(redis)) used.add(openSecret(e.mux).split(':')[0]);
  return used;
}

async function readPool(redis) {
  return (await redis.lRange(POOL_KEY, 0, -1)).map(x => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean);
}

export async function listPool(redis) {
  return (await readPool(redis)).map(e => ({ key: e.key, label: e.label, webhook: !!e.muxWebhook, addedAt: e.addedAt }));
}

export async function addToPool(redis, { label, tokenId, tokenSecret, webhookSecret }) {
  const id = String(tokenId || '').trim(), secret = String(tokenSecret || '').trim(), wh = String(webhookSecret || '').trim();
  if (!id || !secret) return { error: 'Paste the access token ID and secret' };
  if (!wh) return { error: 'Paste the webhook signing secret, so recordings in this environment are processed' };
  if ((await tokenIdsInUse(redis)).has(id)) return { error: 'This access token is already used by an account or the ready list' };
  const bad = await checkEmptyEnvironment(id, secret);
  if (bad) return { error: bad };
  const entry = { key: crypto.randomBytes(6).toString('hex'), label: String(label || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 60) || 'Mux environment',
    mux: sealSecret(`${id}:${secret}`), muxWebhook: sealSecret(wh), addedAt: new Date().toISOString() };
  await redis.rPush(POOL_KEY, JSON.stringify(entry));
  return { ok: true, key: entry.key };
}

export async function removeFromPool(redis, key) {
  for (const raw of await redis.lRange(POOL_KEY, 0, -1)) {
    try { if (JSON.parse(raw).key === key) { await redis.lRem(POOL_KEY, 1, raw); return true; } } catch {}
  }
  return false;
}

// Gives the oldest ready environment to an account and makes it active. Returns its label, or null when
// none is ready (the account then waits in Finish setup).
// With `key`, gives that one ready environment (an account opened by hand from Billing).
export async function activateFromPool(redis, slug, key = null) {
  const reg = await readRegistryRaw(redis);
  if (!reg[slug]) return null;
  for (let tries = 0; tries < (key ? 1 : 5); tries++) {
    let raw = null;
    if (key) {
      raw = (await redis.lRange(POOL_KEY, 0, -1)).find(x => { try { return JSON.parse(x).key === key; } catch { return false; } }) || null;
      if (raw && !(await redis.lRem(POOL_KEY, 1, raw))) raw = null;
    } else raw = await redis.lPop(POOL_KEY);
    if (!raw) return null;
    let e; try { e = JSON.parse(raw); } catch { continue; }
    const [id, secret] = openSecret(e.mux).split(':');
    // Checked again at hand-over: still valid and still empty
    let bad;
    try { bad = id && secret ? await checkEmptyEnvironment(id, secret) : 'unreadable'; }
    catch (err) { bad = null; console.error('[mux-pool] check failed, used as checked when added', e.label, err.message); }
    if (bad && /^Mux answered/.test(bad)) { await redis.lPush(POOL_KEY, raw); console.error('[mux-pool] Mux unavailable, kept', e.label, bad); return null; }
    if (bad) { console.error('[mux-pool] removed from the ready list', e.label, bad); continue; }
    await saveRegistryEntry(redis, slug, { ...reg[slug], mux: e.mux, muxWebhook: e.muxWebhook, muxLabel: e.label, status: 'active', activatedAt: new Date().toISOString() });
    console.log('[mux-pool] activated', slug, 'with', e.label);
    return e.label;
  }
  return null;
}

export const poolSize = redis => redis.lLen(POOL_KEY);
