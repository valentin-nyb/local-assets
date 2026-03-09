
import 'dotenv/config';
import Mux from '@mux/mux-node';

const muxTokenId = process.env.MUX_TOKEN_ID;
const muxTokenSecret = process.env.MUX_TOKEN_SECRET;

const mux = new Mux(muxTokenId, muxTokenSecret);

async function createUpload() {
  try {
    const upload = await mux.video.uploads.create({
      new_asset_settings: {
        playback_policy: ['public'],
        mp4_support: 'standard'
      },
      cors_origin: '*',
      webhook_url: 'https://local-assets.com/api/webhook-handler'
    });
    console.log('Upload URL:', upload.url);
  } catch (err) {
    console.error('Error creating upload:', err);
  }
}

createUpload();
