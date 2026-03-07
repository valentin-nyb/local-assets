export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, x-api-key",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      if (url.pathname === "/get-mux-upload-url" && request.method === "POST") {
        const response = await fetch("https://api.mux.com/video/v1/uploads", {
          method: "POST",
          headers: {
            "Authorization": "Basic " + btoa(env.MUX_TOKEN_ID + ":" + env.MUX_TOKEN_SECRET),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            new_asset_settings: { playback_policy: ["public"], mp4_support: "standard" },
            cors_origin: "*"
          }),
        });
        const result = await response.json();
        return new Response(JSON.stringify(result.data), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      if (url.pathname === "/create-live-stream" && request.method === "POST") {
        const response = await fetch("https://api.mux.com/video/v1/live-streams", {
          method: "POST",
          headers: {
            "Authorization": "Basic " + btoa(env.MUX_TOKEN_ID + ":" + env.MUX_TOKEN_SECRET),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ playback_policy: ["public"], new_asset_settings: { playback_policy: ["public"] } }),
        });
        const result = await response.json();
        return new Response(JSON.stringify(result.data), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      return new Response("Infrastructure Tier Live", { headers: corsHeaders });
    } catch (err) {
      return new Response(err.message, { status: 500, headers: corsHeaders });
    }
  }
};
