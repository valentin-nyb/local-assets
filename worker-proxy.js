const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders });
    }

    try {
        const bucket = env.ASSETS_BUCKET;

        if (!bucket) {
          return new Response(JSON.stringify({ error: "R2 bucket binding ASSETS_BUCKET is missing" }), {
            status: 500,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }

        // 2. Route: GET /list (Fetch recordings for the UI)
        if (url.pathname === "/list") {
          const result = await bucket.list({
            prefix: url.searchParams.get("prefix") || "venue_masters/",
          });

          const contents = (result.objects || []).map((obj) => ({
            Key: obj.key,
            LastModified: obj.uploaded,
            Size: obj.size,
            ETag: obj.etag,
          }));

          return new Response(JSON.stringify(contents), {
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }

        // 3. Route: GET /presign (Return Worker upload URL)
        if (url.pathname === "/presign") {
          const fileName = url.searchParams.get("file");
          const contentType = url.searchParams.get("type") || "application/octet-stream";

          if (!fileName) {
            return new Response(JSON.stringify({ error: "Missing file query param" }), {
              status: 400,
              headers: { "Content-Type": "application/json", ...corsHeaders },
            });
          }

          const uploadUrl = `${url.origin}/upload?file=${encodeURIComponent(fileName)}&type=${encodeURIComponent(contentType)}`;
          
          return new Response(JSON.stringify({ uploadUrl }), {
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }

        // 4. Route: PUT /upload (Store file in R2 via binding)
        if (url.pathname === "/upload" && request.method === "PUT") {
          const fileName = url.searchParams.get("file");
          const contentType = url.searchParams.get("type") || request.headers.get("Content-Type") || "application/octet-stream";

          if (!fileName) {
            return new Response(JSON.stringify({ error: "Missing file query param" }), {
              status: 400,
              headers: { "Content-Type": "application/json", ...corsHeaders },
            });
          }

          await bucket.put(fileName, request.body, {
            httpMetadata: { contentType },
          });

          return new Response(JSON.stringify({ ok: true, key: fileName }), {
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }

        return new Response("Not Found", { status: 404, headers: corsHeaders });
    } catch (e) {
        return new Response(JSON.stringify({error: e.message}), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders }});
    }
  },
};

