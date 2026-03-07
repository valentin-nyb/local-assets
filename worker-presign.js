export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, x-api-key",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    try {
      const url = new URL(request.url);

      // MUX: Direct Upload for .MP4 / .MP3 / .MOV
      if (url.pathname === "/get-mux-upload-url") {
        const res = await fetch("https://api.mux.com/video/v1/uploads", {
          method: "POST",
          headers: {
            "Authorization": "Basic " + btoa(env.MUX_TOKEN_ID + ":" + env.MUX_TOKEN_SECRET),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            new_asset_settings: { 
              playback_policy: ["public"], 
              mp4_support: "standard" 
            },
            cors_origin: "*"
          }),
        });
        const data = await res.json();
        return new Response(JSON.stringify(data.data), { 
          headers: { ...corsHeaders, "Content-Type": "application/json" } 
        });
      }

      // MUX: PTZ Camera Live Stream Generation
      if (url.pathname === "/create-live-stream") {
        const res = await fetch("https://api.mux.com/video/v1/live-streams", {
          method: "POST",
          headers: {
            "Authorization": "Basic " + btoa(env.MUX_TOKEN_ID + ":" + env.MUX_TOKEN_SECRET),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ 
            playback_policy: ["public"], 
            new_asset_settings: { playback_policy: ["public"] } 
          }),
        });
        const data = await res.json();
        return new Response(JSON.stringify(data.data), { 
          headers: { ...corsHeaders, "Content-Type": "application/json" } 
        });
      }

      return new Response("Mux Infrastructure: Online", { headers: corsHeaders });
    } catch (e) {
      return new Response(e.message, { status: 500, headers: corsHeaders });
    }
  }
}
