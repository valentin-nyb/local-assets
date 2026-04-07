const Mux = require('@mux/mux-node');

// In AWS Lambda, configure these as environment variables for security.
const { MUX_TOKEN_ID, MUX_TOKEN_SECRET } = process.env;

// Initialize Mux outside the handler for better performance (re-used across invocations)
const { Video } = new Mux(MUX_TOKEN_ID, MUX_TOKEN_SECRET);

exports.handler = async (event) => {
  // For security, you should restrict this to your domain in a real application.
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  try {
    const upload = await Video.Uploads.create({
      // A 1-hour timeout is reasonable for the client to start the upload.
      timeout: 3600,
      // We will stitch these later, so we can mark them as 'test' to hide them
      // from your main Mux dashboard until they are part of a master video.
      test: true, 
      new_asset_settings: {
        playback_policy: ['public'],
        // This passthrough is essential for tracking which event this segment belongs to.
        // You can add more data from the request body if needed.
        passthrough: `venue-cam-segment-${Date.now()}`,
      },
      cors_origin: '*' // Allow uploads from any browser origin.
    });

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ upload_url: upload.url }),
    };
  } catch (error) {
    console.error('Error creating Mux upload link:', error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ message: 'Could not create upload URL.' }),
    };
  }
};
