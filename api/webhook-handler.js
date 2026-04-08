const Mux = require('@mux/mux-node');
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand } = require("@aws-sdk/lib-dynamodb");

// --- 1. IMPORT THE NEW FUNCTION ---
// The './' is important as it tells Node.js to look for the file in the same directory.
const { createVerticalShorts } = require('./processing.js');

const { 
    MUX_TOKEN_ID, 
    MUX_TOKEN_SECRET, 
    MUX_WEBHOOK_SECRET, 
    DYNAMODB_TABLE_NAME 
} = process.env;

// Note: Mux client is now initialized in processing.js, so we don't need it here.
const dbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dbClient);

exports.handler = async (event) => {
    // Security: Verify the webhook signature
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

        if (passthroughId && passthroughId.startsWith('master_')) {
            // --- 2. CALL THE FUNCTION ---
            // This is a master video, so we trigger the marketing workflow.
            console.log(`Master asset ${asset.id} is ready. Triggering marketing asset creation.`);
            
            // We use 'await' to ensure this process starts before the Lambda function finishes.
            await createVerticalShorts(asset.id);

        } else {
            // This is a segment, so we save it for stitching.
            console.log(`Segment asset ${asset.id} is ready. Saving to DynamoDB.`);
            try {
                const command = new PutCommand({
                    TableName: DYNAMODB_TABLE_NAME,
                    Item: {
                        asset_id: asset.id,
                        passthrough_id: passthroughId,
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