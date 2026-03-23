const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key'
};

function buildMuxAuthHeader(env) {
	if (!env.MUX_TOKEN_ID || !env.MUX_TOKEN_SECRET) {
		throw new Error('Missing MUX_TOKEN_ID or MUX_TOKEN_SECRET');
	}

	return `Basic ${btoa(`${env.MUX_TOKEN_ID}:${env.MUX_TOKEN_SECRET}`)}`;
}

export default {
	async fetch(request, env) {
		if (request.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: corsHeaders });
		}

		try {
			const incomingUrl = new URL(request.url);
			const upstreamBase = env.MUX_API_BASE || 'https://api.mux.com';
			const upstreamUrl = new URL(`${upstreamBase}${incomingUrl.pathname}${incomingUrl.search}`);
			const headers = new Headers(request.headers);

			headers.set('Authorization', buildMuxAuthHeader(env));
			headers.set('Content-Type', headers.get('Content-Type') || 'application/json');
			headers.delete('Host');

			const upstreamResponse = await fetch(upstreamUrl.toString(), {
				method: request.method,
				headers,
				body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body
			});

			const responseHeaders = new Headers(upstreamResponse.headers);
			Object.entries(corsHeaders).forEach(([key, value]) => responseHeaders.set(key, value));

			return new Response(upstreamResponse.body, {
				status: upstreamResponse.status,
				statusText: upstreamResponse.statusText,
				headers: responseHeaders
			});
		} catch (error) {
			return new Response(JSON.stringify({ error: error.message || 'Mux proxy failed' }), {
				status: 500,
				headers: {
					...corsHeaders,
					'Content-Type': 'application/json'
				}
			});
		}
	}
};

