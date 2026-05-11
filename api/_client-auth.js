// Shared helper: authenticates the request via la_session cookie,
// returns the client profile (including per-client MUX credentials).
import { createClient } from 'redis';

function parseCookie(str) {
  const obj = {};
  if (!str) return obj;
  for (const pair of str.split(';')) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    obj[pair.substring(0, idx).trim()] = decodeURIComponent(pair.substring(idx + 1).trim());
  }
  return obj;
}

export async function getClientSession(req) {
  const sessionToken = parseCookie(req.headers.cookie || '').la_session;
  if (!sessionToken) return null;

  const redis = createClient({ url: process.env.REDIS_URL });
  await redis.connect();
  try {
    const clientId = await redis.get(`session:${sessionToken}`);
    if (!clientId) return null;

    const profile = await redis.hGetAll(`client:${clientId}`);
    if (!profile || Object.keys(profile).length === 0) return null;

    return { clientId, profile };
  } finally {
    await redis.quit();
  }
}

// Returns a Mux-compatible Basic auth header for this client,
// falling back to the global credentials if none are stored.
export function getMuxAuth(profile) {
  const tokenId     = profile.muxTokenId     || process.env.PROD_MUX_TOKEN_ID || process.env.MUX_TOKEN_ID     || '';
  const tokenSecret = profile.muxTokenSecret || process.env.PROD_MUX_TOKEN_SECRET || process.env.MUX_TOKEN_SECRET || '';
  return {
    tokenId,
    tokenSecret,
    auth: Buffer.from(`${tokenId}:${tokenSecret}`).toString('base64'),
    envKey: profile.muxEnvKey || process.env.MUX_ENVIRONMENT_KEY || '',
  };
}
