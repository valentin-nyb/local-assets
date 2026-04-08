const Mux = require('@mux/mux-node');

const { MUX_TOKEN_ID, MUX_TOKEN_SECRET } = process.env;
const { Video } = new Mux(MUX_TOKEN_ID, MUX_TOKEN_SECRET);

exports.handler = async (event) => {
  const corsHeaders = { /* ... */ };
  
  // 1. Get the eventId from the request body sent by the client
  const { eventId } = JSON.parse(event.body);
  if (!eventId) {
    return { statusCode: 400, body: JSON.stringify({ message: 'eventId is required.' }) };
  }

  try {
    const upload = await Video.Uploads.create({
      timeout: 3600,
      test: true, 
      new_asset_settings: {
        playback_policy: ['public'],
        // 2. Use the eventId as the passthrough. This is our grouping key.
        passthrough: eventId,
      },
      cors_origin: '*'
    });

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ upload_url: upload.url }),
    };
  } catch (error) {
    console.error('Error creating Mux upload link:', error);
    return { /* ... */ };
  }
};
