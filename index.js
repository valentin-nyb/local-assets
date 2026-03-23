
import 'dotenv/config';
import { muxFetch } from './mux-proxy-client.js';

async function createUpload() {
  try {
    const response = await muxFetch('/video/v1/uploads', {
      method: 'POST',
      body: JSON.stringify({
        new_asset_settings: {
          playback_policy: ['public'],
          mp4_support: 'standard'
        },
        cors_origin: '*',
        webhook_url: 'https://local-assets.com/api/webhook-handler'
      })
    });

    const upload = await response.json();

    if (!response.ok) {
      throw new Error(upload.error?.message || upload.error || 'Mux proxy upload creation failed');
    }

    console.log('Upload URL:', upload.url);
  } catch (err) {
    console.error('Error creating upload:', err);
  }
}

createUpload();
