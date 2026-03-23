function getMuxProxyBaseUrl() {
  const baseUrl = process.env.MUX_PROXY_BASE_URL;

  if (!baseUrl) {
    throw new Error('Missing MUX_PROXY_BASE_URL');
  }

  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
}

export function buildMuxProxyUrl(path) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${getMuxProxyBaseUrl()}${normalizedPath}`;
}

export async function muxProxyFetch(path, options = {}) {
  const headers = new Headers(options.headers || {});

  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  return fetch(buildMuxProxyUrl(path), {
    ...options,
    headers
  });
}