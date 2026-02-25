// Cloudflare Worker proxy for R2 asset access with authz + streaming
// Configure env bindings via wrangler.toml:
// - R2_BUCKET (R2 binding)
// - JWT_SECRET (secret; set with `wrangler secret put JWT_SECRET`)
// - ACL_SERVICE_URL (optional; service to validate ownership/role)
// - LOG_ENDPOINT (optional; where to send access logs)

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const authz = request.headers.get("Authorization") || "";
    const token = parseBearer(authz);
    if (!token) {
      return forbidden("Missing token");
    }

    let payload;
    try {
      payload = await verifyJwt(token, env.JWT_SECRET);
    } catch (err) {
      return forbidden("Invalid token");
    }

    const { client_id: clientId, user_id: userId, role } = payload || {};
    if (!clientId || !userId) {
      return forbidden("Invalid claims");
    }

    const url = new URL(request.url);
    const objectKey = normalizeKey(url.pathname);
    if (!objectKey || !objectKey.startsWith(`clients/${clientId}/assets/`)) {
      return forbidden("Asset not in client scope");
    }

    // Optional: external ACL/ownership check
    if (env.ACL_SERVICE_URL) {
      const ok = await checkOwnership(env, { clientId, userId, role, objectKey });
      if (!ok) return forbidden("Access denied");
    }

    const object = await env.R2_BUCKET.get(objectKey);
    if (!object || !object.body) {
      return new Response("Not Found", { status: 404 });
    }

    const response = new Response(object.body, {
      status: 200,
      headers: {
        "Content-Type": object.httpMetadata?.contentType || "application/octet-stream",
        "Cache-Control": "private, max-age=300",
        "Content-Security-Policy": "default-src 'none'; media-src 'self'; img-src 'self'; frame-ancestors 'none';",
        "X-Content-Type-Options": "nosniff"
      }
    });

    ctx.waitUntil(logAccess(env, { clientId, userId, role, objectKey, ip: request.headers.get("CF-Connecting-IP") }));

    return response;
  }
};

function parseBearer(header) {
  const parts = header.split(" ");
  return parts.length === 2 && parts[0].toLowerCase() === "bearer" ? parts[1] : null;
}

function forbidden(message) {
  return new Response(message, { status: 403 });
}

function normalizeKey(pathname) {
  const cleaned = pathname.replace(/^\/+/, "");
  return cleaned.length ? cleaned : null;
}

async function verifyJwt(token, secret) {
  if (!secret) throw new Error("Missing JWT secret");
  const [headerB64, payloadB64, sigB64] = token.split(".");
  if (!headerB64 || !payloadB64 || !sigB64) throw new Error("Malformed");

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const data = `${headerB64}.${payloadB64}`;
  const signature = base64UrlToUint8Array(sigB64);
  const valid = await crypto.subtle.verify("HMAC", key, signature, enc.encode(data));
  if (!valid) throw new Error("Bad signature");

  const payloadJson = atobSafe(payloadB64);
  return JSON.parse(payloadJson);
}

function base64UrlToUint8Array(str) {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function atobSafe(b64url) {
  const pad = b64url.length % 4 === 0 ? "" : "=".repeat(4 - (b64url.length % 4));
  return atob(b64url.replace(/-/g, "+").replace(/_/g, "/") + pad);
}

async function checkOwnership(env, { clientId, userId, role, objectKey }) {
  try {
    const res = await fetch(env.ACL_SERVICE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, userId, role, objectKey })
    });
    return res.ok;
  } catch (err) {
    return false;
  }
}

async function logAccess(env, { clientId, userId, role, objectKey, ip }) {
  if (!env.LOG_ENDPOINT) return;
  try {
    await fetch(env.LOG_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, userId, role, objectKey, ip, ts: Date.now() })
    });
  } catch (err) {
    // swallow log errors
  }
}
