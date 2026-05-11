#!/usr/bin/env node
// Usage:
//   node scripts/add-client.js add "Client Name" client@gmail.com [muxTokenId] [muxTokenSecret] [muxEnvKey]
//   node scripts/add-client.js list
//   node scripts/add-client.js remove client@gmail.com
//   node scripts/add-client.js set-mux client@gmail.com muxTokenId muxTokenSecret [muxEnvKey]

import { createClient } from 'redis';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Load .env.local
try {
  const env = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] ??= m[2].trim().replace(/^["']|["']$/g, '');
  }
} catch {}

const redis = createClient({ url: process.env.REDIS_URL });
redis.on('error', err => { console.error('Redis error:', err); process.exit(1); });
await redis.connect();

const [,, command, ...args] = process.argv;

if (command === 'add') {
  const [name, email, muxTokenId, muxTokenSecret, muxEnvKey] = args;
  if (!name || !email) {
    console.error('Usage: node scripts/add-client.js add "Client Name" client@gmail.com [muxTokenId] [muxTokenSecret] [muxEnvKey]');
    process.exit(1);
  }
  const normalizedEmail = email.toLowerCase().trim();
  const existing = await redis.get(`client:email:${normalizedEmail}`);
  if (existing) {
    console.log(`⚠️  ${normalizedEmail} is already registered (clientId: ${existing})`);
    process.exit(0);
  }
  const clientId = crypto.randomBytes(12).toString('hex');
  const record = { clientId, name, email: normalizedEmail, createdAt: new Date().toISOString() };
  if (muxTokenId)     record.muxTokenId     = muxTokenId;
  if (muxTokenSecret) record.muxTokenSecret = muxTokenSecret;
  if (muxEnvKey)      record.muxEnvKey      = muxEnvKey;
  await redis.set(`client:email:${normalizedEmail}`, clientId);
  await redis.hSet(`client:${clientId}`, record);
  console.log(`✓ Added client:`);
  console.log(`  Name:      ${name}`);
  console.log(`  Email:     ${normalizedEmail}`);
  console.log(`  ClientID:  ${clientId}`);
  if (muxTokenId) console.log(`  MUX:       ${muxTokenId} (env key: ${muxEnvKey || 'not set'}`);

} else if (command === 'list') {
  const keys = await redis.keys('client:email:*');
  if (keys.length === 0) {
    console.log('No clients registered.');
  } else {
    console.log(`${keys.length} client(s):\n`);
    for (const key of keys.sort()) {
      const email = key.replace('client:email:', '');
      const clientId = await redis.get(key);
      const profile = await redis.hGetAll(`client:${clientId}`);
      console.log(`  ${profile.name || '(no name)'} — ${email}`);
    }
  }

} else if (command === 'remove') {
  const [email] = args;
  if (!email) {
    console.error('Usage: node scripts/add-client.js remove client@gmail.com');
    process.exit(1);
  }
  const normalizedEmail = email.toLowerCase().trim();
  const clientId = await redis.get(`client:email:${normalizedEmail}`);
  if (!clientId) {
    console.log(`No client found for ${normalizedEmail}`);
    process.exit(0);
  }
  await redis.del(`client:email:${normalizedEmail}`);
  await redis.del(`client:${clientId}`);
  console.log(`✓ Removed ${normalizedEmail}`);

} else if (command === 'set-mux') {
  const [email, muxTokenId, muxTokenSecret, muxEnvKey] = args;
  if (!email || !muxTokenId || !muxTokenSecret) {
    console.error('Usage: node scripts/add-client.js set-mux email@gmail.com muxTokenId muxTokenSecret [muxEnvKey]');
    process.exit(1);
  }
  const normalizedEmail = email.toLowerCase().trim();
  const clientId = await redis.get(`client:email:${normalizedEmail}`);
  if (!clientId) { console.log(`No client found for ${normalizedEmail}`); process.exit(1); }
  const update = { muxTokenId, muxTokenSecret };
  if (muxEnvKey) update.muxEnvKey = muxEnvKey;
  await redis.hSet(`client:${clientId}`, update);
  console.log(`✓ MUX credentials set for ${normalizedEmail}`);
  console.log(`  Token ID:  ${muxTokenId}`);
  console.log(`  Env Key:   ${muxEnvKey || '(not set)'}`);

} else {
  console.log(`Commands:
  add "Name" email@gmail.com [muxTokenId] [muxTokenSecret] [muxEnvKey]
                               — register a new client (MUX credentials optional, add later with set-mux)
  set-mux email muxTokenId muxTokenSecret [muxEnvKey]
                               — attach a MUX environment to an existing client
  list                         — show all registered clients
  remove email@gmail.com       — remove a client`);
}

await redis.quit();
