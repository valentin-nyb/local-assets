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
            prefix: "venue_masters/",
          });

          const directory = {};

          (result.objects || []).forEach((file) => {
            const parts = (file.key || "").split("/");
            if (parts.length < 4) return;

            const artistSlug = parts[1];
            const type = (parts[2] || "misc").toUpperCase();
            const artist = artistSlug.toUpperCase().replace(/_/g, " ");
            const format = ((file.key || "").split(".").pop() || "").toUpperCase();

            if (!directory[artist]) {
              directory[artist] = { name: artist, slug: artistSlug, assets: [] };
            }

            directory[artist].assets.push({
              key: file.key,
              type,
              size: file.size,
              lastModified: file.uploaded,
              format,
              url: env.R2_PUBLIC_DOMAIN
                ? `${env.R2_PUBLIC_DOMAIN}/${file.key}`
                : `${url.origin}/asset?key=${encodeURIComponent(file.key)}`,
            });
          });

          return new Response(JSON.stringify(Object.values(directory)), {
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }

        // 2.5 Route: GET /asset (Stream object for preview/download)
        if (url.pathname === "/asset" && request.method === "GET") {
          const key = url.searchParams.get("key");

          if (!key) {
            return new Response(JSON.stringify({ error: "Missing key query param" }), {
              status: 400,
              headers: { "Content-Type": "application/json", ...corsHeaders },
            });
          }

          const object = await bucket.get(key);

          if (!object) {
            return new Response(JSON.stringify({ error: "Object not found" }), {
              status: 404,
              headers: { "Content-Type": "application/json", ...corsHeaders },
            });
          }

          const headers = new Headers(corsHeaders);
          headers.set("Content-Type", object.httpMetadata?.contentType || "application/octet-stream");
          headers.set("Cache-Control", "public, max-age=3600");
          headers.set("ETag", object.httpEtag || object.etag);

          return new Response(object.body, { headers });
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

