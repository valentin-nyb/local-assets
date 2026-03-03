import { S3Client, PutObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
  "Access-Control-Allow-Headers": "x-api-key, Content-Type",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders });
    }

    try {
        // Configure the R2 Client
        const s3 = new S3Client({
          region: "auto",
          endpoint: `https://${env.ACCOUNT_ID}.r2.cloudflarestorage.com`,
          credentials: {
            accessKeyId: env.R2_ACCESS_KEY_ID,
            secretAccessKey: env.R2_SECRET_ACCESS_KEY,
          },
        });

        // 2. Route: GET /list (Fetch recordings for the UI)
        if (url.pathname === "/list") {
          const command = new ListObjectsV2Command({
            Bucket: env.R2_BUCKET_NAME,
            Prefix: url.searchParams.get("prefix") || "venue_masters/",
          });
          const { Contents } = await s3.send(command);
          return new Response(JSON.stringify(Contents || []), {
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }

        // 3. Route: GET /presign (Generate secure upload link)
        if (url.pathname === "/presign") {
          const fileName = url.searchParams.get("file");
          const contentType = url.searchParams.get("type") || "application/octet-stream";

          const command = new PutObjectCommand({
            Bucket: env.R2_BUCKET_NAME,
            Key: fileName,
            ContentType: contentType, // This MUST exactly match the Content-Type sent by the browser in the PUT request
          });

          // URL is valid for 1 hour
          const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });
          
          return new Response(JSON.stringify({ uploadUrl }), {
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }

        return new Response("Not Found", { status: 404, headers: corsHeaders });
    } catch (e) {
        return new Response(JSON.stringify({error: e.message}), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders }});
    }
  },
};

