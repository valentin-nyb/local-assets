const Mux = require('@mux/mux-node');
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand } = require("@aws-sdk/lib-dynamodb");

// 1. Import all necessary functions from your processing file at the top.
const { 
    createVerticalShorts, 
    addWatermarkAndThumbnail, 
    createAudioMaster,
    uploadToSoundCloud 
} = require('./processing.js');

// 2. Initialize all required environment variables and clients.
const { 
    MUX_WEBHOOK_SECRET, 
    DYNAMODB_TABLE_NAME 
} = process.env;

const dbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dbClient);

// 3. Define a single, clean handler function.
exports.handler = async (event) => {
    // Security: Verify the webhook signature first.
    try {
        Mux.Webhooks.verifyHeader(event.body, event.headers['mux-signature'], MUX_WEBHOOK_SECRET);
    } catch (error) {
        console.error('Webhook signature verification failed:', error.message);
        return { statusCode: 403, body: 'Invalid signature.' };
    }

    const { type, data: asset } = JSON.parse(event.body);

    // We only care about the 'video.asset.ready' event.
    if (type === 'video.asset.ready') {
        const passthroughId = asset.passthrough;
        console.log(`Asset ready: ${asset.id}, Passthrough: `);

        // 4. Use a clear if/else if/else block to route the asset.
        if (passthroughId && passthroughId.startsWith('master_')) {
            // --- Stage 1: Master Video is Ready ---
            console.log(`Master asset ${asset.id} is ready. Triggering parallel processing.`);
            // Trigger video clipping and audio extraction at the same time.
            await Promise.all([
                createVerticalShorts(asset.id),
                createAudioMaster(asset.id)
            ]);

        } else if (passthroughId && passthroughId.startsWith('short_for_')) {
            // --- Stage 2: Short Clip is Ready ---
            console.log(`Short clip ${asset.id} is ready. Adding watermark and thumbnail.`);
            await addWatermarkAndThumbnail(asset.id, asset.duration);

        } else if (passthroughId && passthroughId.startsWith('audio_master_for_')) {
            // --- Stage 3: Audio Master is Ready ---
            console.log(`Audio master ${asset.id} is ready. Uploading to SoundCloud.`);
            await uploadToSoundCloud(asset.id);

        } else {
            // --- Default Case: This is a Segment for Stitching ---
            console.log(`Segment asset ${asset.id} is ready. Saving to DynamoDB.`);
            try {
                const command = new PutCommand({
                    TableName: DYNAMODB_TABLE_NAME,
                    Item: {
                        asset_id: asset.id,
                        passthrough_id: passthroughId, // This is the eventId
                        status: 'ready_for_stitching',
                        duration_seconds: asset.duration,
                        created_at: Math.floor(Date.now() / 1000),
                    },
                });
                await docClient.send(command);
                console.log(`Successfully saved segment info for asset ${asset.id}.`);
            } catch (dbError) {
                console.error('Error saving segment to DynamoDB:', dbError);
                return { statusCode: 500, body: 'Database operation failed.' };
            }
        }
    }

    // Acknowledge receipt of the webhook.
    return { statusCode: 200, body: 'Webhook received successfully.' };
};
