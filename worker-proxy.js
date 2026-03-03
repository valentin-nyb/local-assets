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

        // 4. Route: POST /multipart/start
        if (url.pathname === "/multipart/start" && request.method === "POST") {
          const fileName = url.searchParams.get("file");
          const contentType = url.searchParams.get("type") || "application/octet-stream";

          if (!fileName) {
            return new Response(JSON.stringify({ error: "Missing file query param" }), {
              status: 400,
              headers: { "Content-Type": "application/json", ...corsHeaders },
            });
          }

          const multipart = await bucket.createMultipartUpload(fileName, {
            httpMetadata: { contentType },
          });

          return new Response(JSON.stringify({ uploadId: multipart.uploadId }), {
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }

        // 5. Route: PUT /multipart/part
        if (url.pathname === "/multipart/part" && request.method === "PUT") {
          const fileName = url.searchParams.get("file");
          const uploadId = url.searchParams.get("uploadId");
          const partNumber = Number(url.searchParams.get("partNumber"));

          if (!fileName || !uploadId || !Number.isInteger(partNumber) || partNumber < 1) {
            return new Response(JSON.stringify({ error: "Missing or invalid multipart query params" }), {
              status: 400,
              headers: { "Content-Type": "application/json", ...corsHeaders },
            });
          }

          const multipart = bucket.resumeMultipartUpload(fileName, uploadId);
          const uploadedPart = await multipart.uploadPart(partNumber, request.body);

          return new Response(JSON.stringify({ etag: uploadedPart.etag, partNumber: uploadedPart.partNumber }), {
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }

        // 6. Route: POST /multipart/complete
        if (url.pathname === "/multipart/complete" && request.method === "POST") {
          const fileName = url.searchParams.get("file");
          const uploadId = url.searchParams.get("uploadId");

          if (!fileName || !uploadId) {
            return new Response(JSON.stringify({ error: "Missing multipart completion query params" }), {
              status: 400,
              headers: { "Content-Type": "application/json", ...corsHeaders },
            });
          }

          const body = await request.json();
          const parts = Array.isArray(body?.parts) ? body.parts : [];

          if (!parts.length) {
            return new Response(JSON.stringify({ error: "Missing multipart parts list" }), {
              status: 400,
              headers: { "Content-Type": "application/json", ...corsHeaders },
            });
          }

          const normalizedParts = parts
            .map((part) => ({ etag: part.etag, partNumber: Number(part.partNumber) }))
            .filter((part) => part.etag && Number.isInteger(part.partNumber) && part.partNumber > 0)
            .sort((a, b) => a.partNumber - b.partNumber);

          const multipart = bucket.resumeMultipartUpload(fileName, uploadId);
          await multipart.complete(normalizedParts);

          return new Response(JSON.stringify({ ok: true, key: fileName }), {
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }

        // 7. Route: PUT /upload (Store file in R2 via binding)
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

