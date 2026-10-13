#!/usr/bin/env node
// local / assets camera relay. Runs on a computer at the venue (the Mac mini) and passes the
// Camera Control commands from local-assets.com to the OBSBOT cameras on the venue network.
//
//   LA_RELAY_KEY=<key from Camera Control> node la-camera-relay.mjs
//
// It only sends OBSBOT VISCA commands, only to cameras on the local network (UDP 52381), and
// stops a camera that is moving if the connection to local-assets.com drops.
// Needs Node.js 18 or newer. Nothing else to install.

import dgram from 'node:dgram';

const VERSION = '1.0.0';
const KEY = (process.env.LA_RELAY_KEY || process.argv[2] || '').trim();
const BASE = (process.env.LA_URL || 'https://local-assets.com').replace(/\/$/, '');
const PORT = 52381;           // VISCA over IP
const HOLD_MS = 1500;         // a movement stops when the dashboard stops refreshing it

if (!KEY) {
  console.error('Set LA_RELAY_KEY to the relay key from Camera Control on local-assets.com.');
  process.exit(1);
}

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const privateHost = h => /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3})$/.test(h);
const validPayload = b => Array.isArray(b) && b.length >= 4 && b.length <= 16 && b[0] === 0x81 && b[b.length - 1] === 0xff && b.every(x => Number.isInteger(x) && x >= 0 && x <= 255);

// ── UDP to the cameras ──
const sock = dgram.createSocket('udp4');
const seq = new Map();        // camera → VISCA over IP sequence number
const reachable = new Set();  // cameras that answered
sock.on('message', (_m, r) => { if (r.port === PORT) reachable.add(r.address); });
sock.on('error', e => log('udp error', e.message));
sock.bind();

function packet(type, payload, n) {
  const h = Buffer.alloc(8);
  h.writeUInt16BE(type, 0);
  h.writeUInt16BE(payload.length, 2);
  h.writeUInt32BE(n >>> 0, 4);
  return Buffer.concat([h, Buffer.from(payload)]);
}
function send(ip, payload) {
  if (!seq.has(ip)) {
    // First contact: reset the camera's sequence counter
    seq.set(ip, 1);
    sock.send(packet(0x0200, [0x01], 0), PORT, ip);
  }
  const n = seq.get(ip);
  seq.set(ip, n + 1);
  sock.send(packet(0x0100, payload, n), PORT, ip);
}

// Movements (pan/tilt drive, zoom) keep going until a stop. Each one is refreshed by the dashboard
// while the button is held; if the refreshes stop coming, the relay stops the camera itself.
const holds = new Map();
const kindOf = b => (b[2] === 0x06 && b[3] === 0x01 ? 'move' : b[2] === 0x04 && b[3] === 0x07 ? 'zoom' : null);
const stopBytes = (kind, b) => (kind === 'move' ? [0x81, 0x01, 0x06, 0x01, b[4] || 1, b[5] || 1, 0x03, 0x03, 0xff] : [0x81, 0x01, 0x04, 0x07, 0x00, 0xff]);
function run(cmd) {
  const { ip, bytes, hold } = cmd || {};
  if (!privateHost(String(ip)) || !validPayload(bytes)) { log('ignored a command that is not for a camera on this network'); return; }
  const kind = kindOf(bytes);
  if (kind) {
    const k = ip + ':' + kind;
    clearTimeout(holds.get(k));
    holds.delete(k);
    if (hold) holds.set(k, setTimeout(() => { holds.delete(k); send(ip, stopBytes(kind, bytes)); }, HOLD_MS));
  }
  send(ip, bytes);
}

// ── local-assets.com ──
const headers = { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', 'User-Agent': 'la-camera-relay/' + VERSION };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function heartbeat() {
  try {
    await fetch(BASE + '/api/camera-relay', { method: 'POST', headers, body: JSON.stringify({ version: VERSION, reachable: [...reachable] }), signal: AbortSignal.timeout(10000) });
  } catch (e) { /* the poll loop reports connection problems */ }
}

async function loop() {
  let failures = 0;
  log('local / assets camera relay', VERSION, 'connecting to', BASE);
  heartbeat();
  setInterval(heartbeat, 30000);
  for (;;) {
    try {
      const r = await fetch(BASE + '/api/camera-relay?wait=1', { headers, signal: AbortSignal.timeout(28000) });
      if (r.status === 401) {
        const d = await r.json().catch(() => ({}));
        log('relay key refused:', d.error || r.status, '- trying again in 60 s');
        await sleep(60000);
        continue;
      }
      if (!r.ok) throw new Error('server ' + r.status);
      const { commands = [] } = await r.json();
      if (failures) log('connected');
      failures = 0;
      for (const c of commands) run(c);
    } catch (e) {
      if (e.name === 'TimeoutError') continue;
      failures++;
      // Connection lost: anything moving is stopped
      for (const [k, t] of holds) { clearTimeout(t); const [ip, kind] = k.split(':'); send(ip, stopBytes(kind, [])); }
      holds.clear();
      if (failures === 1 || failures % 20 === 0) log('connection problem:', e.message);
      await sleep(Math.min(15000, 1000 * failures));
    }
  }
}

loop();
