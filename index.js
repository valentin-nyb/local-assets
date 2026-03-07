require ('dotenv').config();

import MUX from '@mux/mux-node';

const MUX tokenId = process.env.MUX_TOKEN_ID;
const MUX tokenSecret = process.env.MUX_TOKEN_SECRET;

await Mux.video.uploads.create({
  new_asset_settings: {
    playback_policy: ['public'],
    mp4_support: 'standard'
  },
  cors_origin: '*',
  webhook_url: 'https://local-assets.com/assets'
}).then((upload) => {
  console.log('Upload URL:', upload.url);
}
