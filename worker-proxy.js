// worker-proxy.js
export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, x-api-key",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    const url = new URL(request.url);
    
    // THIS REMOVES THE 'SMACKEPRANG' BRANDING FROM ALL LINKS
    const PUBLIC_DOMAIN = "https://cloud.local-assets.com";

    const bucket = env.ASSETS_BUCKET;
    if (!bucket) return new Response("R2 bucket binding missing", { status: 500, headers: corsHeaders });

    // ROUTE: GET /list
    if (url.pathname === "/list") {
      const result = await bucket.list({ prefix: "venue_masters/" });
      const directory = {};

      result.objects.forEach((file) => {
        const parts = (file.key || "").split("/");
        if (parts.length < 4) return;
        
        const artistSlug = parts[1];
        const artistName = artistSlug.toUpperCase().replace(/_/g, " ");
        const type = (parts[2] || "misc").toUpperCase();
        const format = (file.key || "").split(".").pop().toUpperCase();

        if (!directory[artistName]) {
          directory[artistName] = { name: artistName, slug: artistSlug, assets: [] };
        }
        
        directory[artistName].assets.push({
          key: file.key,
          type,
          size: file.size,
          lastModified: file.uploaded,
          format,
          // SUCCESS: This URL is now professional
          url: `${PUBLIC_DOMAIN}/asset?key=${encodeURIComponent(file.key)}`
        });
      });
      return new Response(JSON.stringify(Object.values(directory)), {
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
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
      if (!fileName) return new Response("Missing file", { status: 400, headers: corsHeaders });
      await bucket.put(fileName, request.body, {
        httpMetadata: { contentType: url.searchParams.get("type") }
      });
      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }

    // ROUTE: POST /multipart/start
    if (url.pathname === "/multipart/start" && request.method === "POST") {
      const fileName = url.searchParams.get("file");
      const contentType = url.searchParams.get("type") || "application/octet-stream";
      if (!fileName) return new Response("Missing file", { status: 400, headers: corsHeaders });

      const upload = await bucket.createMultipartUpload(fileName, {
        httpMetadata: { contentType }
      });

      return new Response(JSON.stringify({ uploadId: upload.uploadId, key: upload.key }), {
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // ROUTE: PUT /multipart/part
    if (url.pathname === "/multipart/part" && request.method === "PUT") {
      const fileName = url.searchParams.get("file");
      const uploadId = url.searchParams.get("uploadId");
      const partNumber = Number(url.searchParams.get("partNumber"));

      if (!fileName || !uploadId || !partNumber) {
        return new Response("Missing multipart parameters", { status: 400, headers: corsHeaders });
      }

      const upload = bucket.resumeMultipartUpload(fileName, uploadId);
      const uploadedPart = await upload.uploadPart(partNumber, request.body);

      return new Response(JSON.stringify({ partNumber, etag: uploadedPart.etag }), {
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // ROUTE: POST /multipart/complete
    if (url.pathname === "/multipart/complete" && request.method === "POST") {
      const fileName = url.searchParams.get("file");
      const uploadId = url.searchParams.get("uploadId");
      if (!fileName || !uploadId) {
        return new Response("Missing multipart parameters", { status: 400, headers: corsHeaders });
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return new Response("Invalid JSON body", { status: 400, headers: corsHeaders });
      }

      const parts = Array.isArray(body?.parts) ? body.parts : [];
      if (!parts.length) {
        return new Response("Missing parts", { status: 400, headers: corsHeaders });
      }

      const upload = bucket.resumeMultipartUpload(fileName, uploadId);
      const completed = await upload.complete(parts);

      return new Response(JSON.stringify({ success: true, key: completed.key }), {
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders });
  }
}
