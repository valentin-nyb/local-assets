require ('dotenv').config();

import MUX from '@mux/mux-node';

const MUX tokenId = process.env.49c2dd4c-5ba5-4e93-b60b-54afee697b41;
const MUX tokenSecret = process.env.M3W9cB0gXQ2ki+nYpJc9pdWYW5q0ZlCORrd8URup4lqlUyxbiRfXssWRNdWRiQbEmIZkPSgIjTT;

await Mux.video.uploads.create({
  new_asset_settings: {
    playback_policy: ['public'],
    mp4_support: 'standard'
  },
  cors_origin: '*',
  webhook_url: 'https://local-assets.com'
}).then((upload) => {
  console.log('Upload URL:', upload.url);
}
