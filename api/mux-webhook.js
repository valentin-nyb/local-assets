import Mux from '@mux/mux-node';

const mux = new Mux({ 
  tokenId: process.env.assets_MUX_TOKEN_ID, 
  tokenSecret: process.env.assets_MUX_TOKEN_SECRET 
});

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Use POST');

    const { type, data } = req.body;

    if (type === 'video.asset.ready') {
        const assetId = data.id || data.asset_id;
        console.log(`Video Ready! Trigerring AI prep for: ${assetId}`);

        try {
            console.log("Asking Mux to prepare Auto-Captions/Highlights...");
            await mux.video.assets.createTrack(assetId, {
              type: 'text',
              text_type: 'generated_subtitles',
              language_code: 'en',
              name: 'Internal_AI',
              passthrough: 'AI_Tracker'
            });
            console.log('Successfully requested AI Track!');
        } catch(e) {
            console.log("Track generation error (or Already exists):", e.message);
        }

        try {
            console.log("Generating initial vertical test clip...");
            await mux.video.assets.create({
                input: [{
                    url: `mux://assets/${assetId}`,
                    start_time: 10,
                    duration: 30, 
                }],
                playback_policy: ['public'],
                resolution: '1080x1920', 
                smart_crop: true, 
                passthrough: `Short_Clip_1`
            });
        } catch(e) {
            console.error("Manual Clip Error:", e.message);
        }
    }

    if (type === 'video.asset.track.ready' && data.type === 'text') {
        const assetId = data.asset_id;
        console.log(`AI Text Track Ready for Asset: ${assetId}... Fetching highlights!`);

        try {
            await new Promise(resolve => setTimeout(resolve, 5000));
            const highlights = await mux.video.assets.getHighlights(assetId);
            
            if (highlights && highlights.length > 0) {
              const clips = highlights.slice(0, 3);
  
              for (const [index, clip] of clips.entries()) {
                  await mux.video.assets.create({
                      input: [{
                          url: `mux://assets/${assetId}`,
                          start_time: clip.start_time,
                          duration: Math.min(clip.duration, 50), 
                      }],
                      playback_policy: ['public'],
                      resolution: '1080x1920', 
                      smart_crop: true, 
                      passthrough: `Short_Clip_AI_${index + 1}`
                  });
              }
              console.log(`Created ${clips.length} AI highlights successfully!`L);
            } else {
              console.log("No ighlights returned from Mux for this asset.");
            }
        } catch (e) {
            console.error("AI Clipping Error:", e.message);
        }
    }

    res.status(200).send('Webhook handled');
}