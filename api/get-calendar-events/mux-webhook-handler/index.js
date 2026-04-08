const Mux = require('@mux/mux-node');
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand } = require("@aws-sdk/lib-dynamodb");

const { 
    MUX_TOKEN_ID, 
    MUX_TOKEN_SECRET, 
    MUX_WEBHOOK_SECRET, 
    DYNAMODB_TABLE_NAME 
} = process.env;

const { Video } = new Mux(MUX_TOKEN_ID, MUX_TOKEN_SECRET);
const dbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dbClient);

exports.handler = async (event) => {
    // 1. Security: Verify the webhook signature
    try {
        Mux.Webhooks.verifyHeader(event.body, event.headers['mux-signature'], MUX_WEBHOOK_SECRET);
    } catch (error) {
        console.error('Webhook signature verification failed:', error.message);
        return { statusCode: 403, body: 'Invalid signature.' };
    }

    const { type, data: asset } = JSON.parse(event.body);

    if (type === 'video.asset.ready') {
        const passthroughId = asset.passthrough;
        console.log(`Asset ready: ${asset.id}, Passthrough: ${passthroughId}`);

        // 2. Check if this is a MASTER asset or a SEGMENT asset
        if (passthroughId && passthroughId.startsWith('master_')) {
            // --- THIS IS A MASTER VIDEO, START THE MARKETING WORKFLOW ---
            console.log(`Master asset ${asset.id} is ready. Triggering marketing asset creation.`);
            
            // This is where you will add the logic from your original request.
            // For now, we will just log it.
            
            // Example of next steps you would call from here:
            // await createVerticalShorts(asset.id);
            // await extractAndUploadAudio(asset.id);
            // await generateThumbnails(asset.id);
            // await addWatermark(asset.id);

        } else {
            // --- THIS IS A SEGMENT, SAVE IT FOR STITCHING ---
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

    return { statusCode: 200, body: 'Webhook received successfully.' };
};
