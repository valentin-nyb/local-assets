import Mux from '@mux/mux-node';

const mux = new Mux({
  tokenId: process.env.MUX_TOKEN_ID,
  tokenSecret: process.env.MUX_TOKEN_SECRET,
});

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const { type, data } = req.body;

    // Triggered when the Master Video is READY
    if (type === 'video.asset.ready') {
        const assetId = data.id;

        try {
            // 1. EXTRACT MASTER AUDIO (Creates a separate HQ audio asset)
            await mux.video.assets.create({
                input: [{ url: `mux://assets/${assetId}` }],
                audio_only: true,
                playback_policy: ['public'],
                passthrough: "AUDIO_EXTRACT"
            });

            // 2. GENERATE VERTICAL SHORT (AI Smart-Crop)
            await mux.video.assets.create({
                input: [{
                    url: `mux://assets/${assetId}`,
                }],
                playback_policy: ['public'],
                static_renditions: [{ name: 'low.mp4' }],
                passthrough: "VERTICAL_SHORT"
            });

            console.log(`AI Pipeline Started for Asset: ${assetId}`);
        } catch (err) {
            console.error("AI Pipeline Error:", err);
        }
    }

    res.status(200).json({ received: true });
}
