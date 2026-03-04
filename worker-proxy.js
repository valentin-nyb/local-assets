// worker-proxy.js
export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, x-api-key",
      "Access-Control-Expose-Headers": "ETag"
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    const url = new URL(request.url);
    const bucket = env.ASSETS_BUCKET;
    const PUBLIC_DOMAIN = env.PUBLIC_DOMAIN || "https://cloud.local-assets.com";

    if (!bucket) return new Response("R2 bucket binding missing", { status: 500, headers: corsHeaders });

    // ROUTE: GET /presign
    if (url.pathname === "/presign") {
      const fileName = url.searchParams.get("file");
      if (!fileName) return new Response("Missing file", { status: 400, headers: corsHeaders });

      if (typeof bucket.createUploadUrl !== "function") {
        return new Response(JSON.stringify({ error: "createUploadUrl unavailable in this runtime" }), {
          status: 501,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      const signedUrl = await bucket.createUploadUrl(fileName, {
        expiresIn: 3600,
        httpMetadata: { contentType: url.searchParams.get("type") }
      });

      return new Response(JSON.stringify({ url: signedUrl }), {
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // ROUTE: GET /list
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
          url: `${PUBLIC_DOMAIN}/asset?key=${encodeURIComponent(file.key)}`
        });
      });
      return new Response(JSON.stringify(Object.values(directory)), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ROUTE: GET /asset
    if (url.pathname === "/asset") {
      const key = url.searchParams.get("key");
      const object = await bucket.get(key);
      if (!object) return new Response("Not Found", { status: 404, headers: corsHeaders });
      const headers = new Headers(corsHeaders);
      object.writeHttpMetadata(headers);
      return new Response(object.body, { headers });
    }

    // ROUTE: PUT /upload
    if (url.pathname === "/upload" && request.method === "PUT") {
      const fileName = url.searchParams.get("file");
      const contentType = url.searchParams.get("type") || "application/octet-stream";
      if (!fileName) return new Response("Missing file", { status: 400, headers: corsHeaders });
      await bucket.put(fileName, request.body, { httpMetadata: { contentType } });
      return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    // ROUTE: POST /multipart/start
    if (url.pathname === "/multipart/start" && request.method === "POST") {
      const fileName = url.searchParams.get("file");
      const contentType = url.searchParams.get("type") || "application/octet-stream";
      if (!fileName) return new Response("Missing file", { status: 400, headers: corsHeaders });
      const multipart = await bucket.createMultipartUpload(fileName, { httpMetadata: { contentType } });
      return new Response(JSON.stringify({ uploadId: multipart.uploadId }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    // ROUTE: PUT /multipart/part
    if (url.pathname === "/multipart/part" && request.method === "PUT") {
      const uploadId = url.searchParams.get("uploadId");
      const partNumber = parseInt(url.searchParams.get("partNumber"));
      if (!uploadId || isNaN(partNumber)) return new Response("Missing uploadId or partNumber", { status: 400, headers: corsHeaders });
      const part = await bucket.uploadPart(uploadId, partNumber, request.body);
      return new Response(JSON.stringify({ etag: part.etag }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    // ROUTE: POST /multipart/complete
    if (url.pathname === "/multipart/complete" && request.method === "POST") {
      const uploadId = url.searchParams.get("uploadId");
      const parts = await request.json();
      if (!uploadId || !parts) return new Response("Missing uploadId or parts", { status: 400, headers: corsHeaders });
      await bucket.completeMultipartUpload(uploadId, parts);
      return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders });
  }
};
