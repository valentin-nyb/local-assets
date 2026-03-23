export async function muxFetch(path, options = {}) {
  const { MUX_TOKEN_ID, MUX_TOKEN_SECRET } = process.env;

  if (!MUX_TOKEN_ID || !MUX_TOKEN_SECRET) {
    throw new Error('Missing MUX_TOKEN_ID or MUX_TOKEN_SECRET environment variables');
  }

  const credentials = Buffer.from(`${MUX_TOKEN_ID}:${MUX_TOKEN_SECRET}`).toString('base64');
  const headers = new Headers(options.headers || {});

  headers.set('Authorization', `Basic ${credentials}`);

  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  
  return fetch(`https://api.mux.com${normalizedPath}`, {
    ...options,
    headers
  });
}