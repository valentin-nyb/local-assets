import 'dotenv/config';
import Mux from '@mux/mux-node';

const mux = new Mux({
  tokenId: process.env.MUX_TOKEN_ID || 'your_token',
  tokenSecret: process.env.MUX_TOKEN_SECRET || 'your_secret'
});

async function run() {
  try {
    const upload = await mux.video.uploads.create({
      new_asset_settings: {
        playback_policy: ['public'],
        video_quality: 'plus',
        generated_subtitles: [{ language_code: 'en', name: 'Internal_AI' }],
        // static_renditions: 'request'
      },
      cors_origin: '*',
    });
    console.log('Success:', upload.id);
  } catch (err) {
    if (err.messages) console.log('Mux error messages:', err.messages);
    else console.error('Error:', err);
  }
}
run();
