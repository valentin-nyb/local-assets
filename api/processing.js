const Mux = require('@mux/mux-node');
const { VideoIntelligenceServiceClient } = require('@google-cloud/video-intelligence');
const path = require('path');

// --- Mux and Google Cloud Client Initialization ---
const { MUX_TOKEN_ID, MUX_TOKEN_SECRET, MUX_SIGNING_KEY_ID, MUX_SIGNING_KEY_PRIVATE_KEY } = process.env;
const { Video } = new Mux(MUX_TOKEN_ID, MUX_TOKEN_SECRET);

// Initialize Google client, assuming the key file is bundled with the Lambda
const googleClient = new VideoIntelligenceServiceClient({
    keyFilename: path.join(__dirname, 'your-google-service-account-key.json') 
});

/**
 * Creates a temporary, signed playback URL for a Mux asset.
 * Google's servers will use this URL to access and analyze the video.
 * @param {string} playbackId The playback ID of the Mux asset.
 * @returns {string} A signed URL that is valid for a limited time.
 */
function getSignedMuxPlaybackUrl(playbackId) {
    if (!MUX_SIGNING_KEY_ID || !MUX_SIGNING_KEY_PRIVATE_KEY) {
        throw new Error('Mux signing key credentials are not configured.');
    }
    // Create a signed URL that is valid for 1 hour (3600 seconds)
    const token = Mux.JWT.signPlaybackId(playbackId, {
        key_id: MUX_SIGNING_KEY_ID,
        key_secret: MUX_SIGNING_KEY_PRIVATE_KEY,
        expiration: '1h',
    });
    return `https://stream.mux.com/${playbackId}.m3u8?token=${token}`;
}

/**
 * Finds distinct scenes in a video using the Google Cloud Video Intelligence API.
 * @param {string} masterAssetId The ID of the Mux asset to analyze.
 * @returns {Promise<Array<{startTime: number, endTime: number, description: string}>>}
 */
async function findBestMoments(masterAssetId) {
    console.log(`[Google AI] Analyzing asset ${masterAssetId} for scene changes...`);

    try {
        // 1. Get the Mux asset to find its playback ID.
        const asset = await Video.Assets.get(masterAssetId);
        const playbackId = asset.playback_ids[0].id;

        // 2. Create a signed URL for Google to access.
        const signedUrl = getSignedMuxPlaybackUrl(playbackId);

        // 3. Call the Google Video Intelligence API
        const [operation] = await googleClient.annotateVideo({
            inputUri: signedUrl,
            features: ['SHOT_CHANGE_DETECTION'],
        });

        console.log('[Google AI] Analysis job started. Waiting for results...');
        const [result] = await operation.promise();

        // 4. Parse the results to get scene timestamps.
        const shotAnnotations = result.annotationResults[0].shotAnnotations;
        if (!shotAnnotations || shotAnnotations.length === 0) {
            console.log('[Google AI] No shots detected in the video.');
            return [];
        }

        console.log(`[Google AI] Detected ${shotAnnotations.length} distinct shots.`);

        // 5. Convert the Google results into our "moments" format.
        const moments = shotAnnotations.map((shot, index) => ({
            startTime: parseFloat(shot.startTimeOffset.seconds || 0) + (shot.startTimeOffset.nanos || 0) / 1e9,
            endTime: parseFloat(shot.endTimeOffset.seconds || 0) + (shot.endTimeOffset.nanos || 0) / 1e9,
            description: `Scene ${index + 1}`,
        }));

        // Optional: Filter for longer scenes if too many are found
        const filteredMoments = moments.filter(m => (m.endTime - m.startTime) > 5); // Only keep scenes longer than 5 seconds
        
        return filteredMoments;

    } catch (error) {
        console.error(`[Google AI] Error analyzing video ${masterAssetId}:`, error);
        return [];
    }
}

/**
 * Creates short clips from a master video asset based on Google AI analysis.
 * @param {string} masterAssetId The ID of the long-form Mux asset to clip.
 */
async function createVerticalShorts(masterAssetId) {
    if (!masterAssetId) {
        console.error('masterAssetId is required to create shorts.');
        return;
    }

    console.log(`Starting AI-driven shorts creation for master asset: ${masterAssetId}`);

    try {
        // This now calls our new Google AI-powered function.
        const moments = await findBestMoments(masterAssetId);

        if (!moments || moments.length === 0) {
            console.log('No moments found to create clips from. Exiting.');
            return;
        }

        // For this example, let's just clip the first 5 interesting scenes found.
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
                passthrough: `short_for_${masterAssetId}_${moment.startTime.toFixed(2)}`,
            });
        });

        const createdClips = await Promise.all(clipPromises);
        console.log('Successfully created all AI-driven clips.');

    } catch (error) {
        console.error(`Failed to create vertical shorts for asset ${masterAssetId}:`, error);
    }
}

module.exports = {
    createVerticalShorts,
};