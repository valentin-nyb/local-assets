// This helper ensures all Mux requests use your new high-power keys
export async function muxFetch(path, options = {}) {
  const tokenId = process.env.PROD_MUX_TOKEN_ID;
  const tokenSecret = process.env.PROD_MUX_TOKEN_SECRET;

  const auth = btoa(`${tokenId}:${tokenSecret}`);

  const res = await fetch(`https://api.mux.com${path}`, {
    ...options,
    headers: {
      ...options.headers,
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
  });

  return res;
}