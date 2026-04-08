const Mux = require('@mux/mux-node');
const { VideoIntelligenceServiceClient } = require('@google-cloud/video-intelligence');
const path = require('path');

// --- Mux and Google Cloud Client Initialization ---
const { MUX_TOKEN_ID, MUX_TOKEN_SECRET, MUX_SIGNING_KEY_ID, MUX_SIGNING_KEY_PRIVATE_KEY } = process.env;
const { Video } = new Mux(MUX_TOKEN_ID, MUX_TOKEN_SECRET);

const googleClient = new VideoIntelligenceServiceClient({
    keyFilename: path.join(__dirname, 'your-google-service-account-key.json') 
});

// --- Function Definitions ---

/**
 * Creates a temporary, signed playback URL for a Mux asset.
 */
function getSignedMuxPlaybackUrl(playbackId) {
    if (!MUX_SIGNING_KEY_ID || !MUX_SIGNING_KEY_PRIVATE_KEY) {
        throw new Error('Mux signing key credentials are not configured.');
    }
    const token = Mux.JWT.signPlaybackId(playbackId, {
        key_id: MUX_SIGNING_KEY_ID,
        key_secret: MUX_SIGNING_KEY_PRIVATE_KEY,
        expiration: '1h',
    });
    return `https://stream.mux.com/${playbackId}.m3u8?token=`;
}

/**
 * Finds distinct scenes in a video using the Google Cloud Video Intelligence API.
 */
async function findBestMoments(masterAssetId) {
    console.log(`[Google AI] Analyzing asset  for scene changes...`);
    try {
        const asset = await Video.Assets.get(masterAssetId);
        const playbackId = asset.playback_ids[0].id;
        const signedUrl = getSignedMuxPlaybackUrl(playbackId);

        const [operation] = await googleClient.annotateVideo({
            inputUri: signedUrl,
            features: ['SHOT_CHANGE_DETECTION'],
        });

        console.log('[Google AI] Analysis job started. Waiting for results...');
        const [result] = await operation.promise();
        const shotAnnotations = result.annotationResults[0].shotAnnotations;

        if (!shotAnnotations || shotAnnotations.length === 0) {
            console.log('[Google AI] No shots detected in the video.');
            return [];
        }

        console.log(`[Google AI] Detected ${shotAnnotations.length} distinct shots.`);
        const moments = shotAnnotations.map((shot, index) => ({
            startTime: parseFloat(shot.startTimeOffset.seconds || 0) + (shot.startTimeOffset.nanos || 0) / 1e9,
            endTime: parseFloat(shot.endTimeOffset.seconds || 0) + (shot.endTimeOffset.nanos || 0) / 1e9,
            description: `Scene ${index + 1}`,
        }));

        return moments.filter(m => (m.endTime - m.startTime) > 5);
    } catch (error) {
        console.error(`[Google AI] Error analyzing video :`, error);
        return [];
    }
}

/**
 * Creates short clips from a master video asset based on Google AI analysis.
 */
async function createVerticalShorts(masterAssetId) {
    if (!masterAssetId) {
        console.error('masterAssetId is required to create shorts.');
        return;
    }
    console.log(`Starting AI-driven shorts creation for master asset: `);
    try {
        const moments = await findBestMoments(masterAssetId);
        if (!moments || moments.length === 0) {
            console.log('No moments found to create clips from. Exiting.');
            return;
        }

        const momentsToClip = moments.slice(0, 5);
        console.log(`Found ${moments.length} scenes. Clipping the first ${momentsToClip.length}...`);

        const clipPromises = momentsToClip.map(moment => {
            console.log(`Creating clip from ${moment.startTime.toFixed(2)}s to ${moment.endTime.toFixed(2)}s.`);
            return Video.Assets.create({
                source: [{
                    asset_id: masterAssetId,
                    start_time: moment.startTime,
                    end_time: moment.endTime,
                }],
                playback_policy: ['public'],
                passthrough: `short_for__${moment.startTime.toFixed(2)}`,
            });
        });

        await Promise.all(clipPromises);
        console.log('Successfully created all AI-driven clips.');
    } catch (error) {
        console.error(`Failed to create vertical shorts for asset :`, error);
    }
}

/**
 * Adds a watermark and generates a custom thumbnail for a Mux asset.
 */
async function addWatermarkAndThumbnail(assetId, duration) {
    if (!assetId) {
        console.error('assetId is required to add a watermark.');
        return;
    }
    console.log(`Adding watermark and thumbnail for short clip: `);
    try {
        await Video.Assets.update(assetId, {
            watermarks: [{
                url: 'https://your-cdn.com/your-logo.png',
                position: 'bottom-right',
                width: '15%',
                height: '10%',
                opacity: 0.8
            }]
        });
        console.log(`Watermark added for asset . Mux will re-encode.`);

        const thumbnailTime = duration / 2;
        await Video.Assets.createThumbnail(assetId, {
            time: thumbnailTime,
            width: 1080,
        });
        console.log(`Custom thumbnail created for asset  at ${thumbnailTime.toFixed(2)}s.`);
    } catch (error) {
        console.error(`Error adding watermark or thumbnail for asset :`, error);
    }
}

// --- A single, clean export block at the end of the file ---
module.exports = {
    createVerticalShorts,
    addWatermarkAndThumbnail,
};
