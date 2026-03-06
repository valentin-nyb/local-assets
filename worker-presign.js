// worker-presign.js — local / assets Worker
// Handles: presigned upload URLs, asset listing, asset serving

// ── AWS V4 Presigned URL helpers ──
async function hmacSha256(key, message) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    typeof key === "string" ? new TextEncoder().encode(key) : key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(message) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(message));
  return toHex(hash);
}

async function createPresignedPutUrl(objectKey, contentType, env) {
  const accessKeyId = env.R2_ACCESS_KEY_ID || env.S3_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY || env.S3_SECRET_ACCESS_KEY;
  const accountId = env.ACCOUNT_ID;
  const bucketName = env.R2_BUCKET_NAME || "venue-assets";
  const host = accountId + ".r2.cloudflarestorage.com";
  const region = "auto";
  const service = "s3";
  const expires = 3600;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z/, "Z");
  const dateStamp = amzDate.slice(0, 8);
  const credential = accessKeyId + "/" + dateStamp + "/" + region + "/" + service + "/aws4_request";

  const encodedKey = objectKey.split("/").map((s) => encodeURIComponent(s)).join("/");
  const canonicalUri = "/" + bucketName + "/" + encodedKey;

  const params = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", credential],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(expires)],
    ["X-Amz-SignedHeaders", "content-type;host"],
  ];
  params.sort((a, b) => a[0].localeCompare(b[0]));

  const canonicalQueryString = params.map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&");
  const canonicalHeaders = "content-type:" + contentType + "\nhost:" + host + "\n";
  const signedHeaders = "content-type;host";

  const canonicalRequest = [
    "PUT",
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const scope = dateStamp + "/" + region + "/" + service + "/aws4_request";
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");

  let signingKey = new TextEncoder().encode("AWS4" + secretAccessKey);
  for (const part of [dateStamp, region, service, "aws4_request"]) {
    signingKey = await hmacSha256(signingKey, part);
  }
  const signature = toHex(await hmacSha256(signingKey, stringToSign));

  return "https://" + host + canonicalUri + "?" + canonicalQueryString + "&X-Amz-Signature=" + signature;
}

export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, x-api-key",
      "Access-Control-Expose-Headers": "ETag",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    const url = new URL(request.url);
    const bucket = env.MY_BUCKET || env.ASSETS_BUCKET;
    const PUBLIC_DOMAIN = env.PUBLIC_DOMAIN || "https://cloud.local-assets.com";

    if (!bucket) return new Response("R2 bucket binding missing", { status: 500, headers: corsHeaders });

    // 1. Handle Presigning (The "Handshake")
    if (url.pathname === "/presign-upload") {
      const apiKey = request.headers.get("x-api-key");
      if (env.AUTH_KEY && apiKey !== env.AUTH_KEY) {
        return new Response("Unauthorized", { status: 401, headers: corsHeaders });
      }

      const fileName = url.searchParams.get("file");
      const contentType = url.searchParams.get("type") || "application/octet-stream";

      if (!fileName) return new Response("Missing file param", { status: 400, headers: corsHeaders });

      if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
        return new Response(JSON.stringify({ error: "R2 credentials not configured" }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      try {
        const signedUrl = await createPresignedPutUrl(fileName, contentType, env);
        const absoluteUrl = signedUrl.startsWith("http") ? signedUrl : `https://${signedUrl}`;
        return new Response(JSON.stringify({ url: absoluteUrl }), {
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
    }

    // 1.5 Handle Mux Upload URL
    if (url.pathname === "/get-mux-url") {
      const apiKey = request.headers.get("x-api-key");
      if (env.AUTH_KEY && apiKey !== env.AUTH_KEY) {
        return new Response("Unauthorized", { status: 401, headers: corsHeaders });
      }

      if (!env.wt1cSclqAHkUnxOJ1KSRZBIunpT45Zp+MlbuxudEcUTMDAe1kc+AAL24nxZclbTGZUEsPc9FkjB || !env.MUX_TOKEN_SECRET) {
        return new Response(JSON.stringify({ error: "Mux credentials not configured" }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      try {
        const response = await fetch("https://api.mux.com/video/v1/uploads", {
          method: "POST",
          headers: {
            "Authorization": `Basic ${btoa(`${env.MUX_TOKEN_ID}:${env.MUX_TOKEN_SECRET}`)}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            new_asset_settings: { playback_policy: ["public"] },
            cors_origin: "*",
          }),
        });

        const data = await response.json();
        return new Response(JSON.stringify(data.data), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
    }

    // 2. Handle Listing (The "Library")
    if (url.pathname === "/list") {
      const result = await bucket.list({ prefix: "venue_masters/" });
      const directory = {};
      result.objects.forEach((file) => {
        const parts = (file.key || "").split("/");
        if (parts.length < 4) return;
        const artist = parts[1].toUpperCase().replace(/_/g, " ");
        if (!directory[artist]) directory[artist] = { name: artist, slug: parts[1], assets: [] };
        directory[artist].assets.push({
          key: file.key,
          type: parts[2].toUpperCase(),
          url: PUBLIC_DOMAIN + "/asset?key=" + encodeURIComponent(file.key),
        });
      });
      return new Response(JSON.stringify(Object.values(directory)), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 3. Handle Asset Serving
    if (url.pathname === "/asset") {
      const key = url.searchParams.get("key");
      const object = await bucket.get(key);
      if (!object) return new Response("Not Found", { status: 404, headers: corsHeaders });
      const headers = new Headers(corsHeaders);
      object.writeHttpMetadata(headers);
      return new Response(object.body, { headers });
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders });
  },
};
