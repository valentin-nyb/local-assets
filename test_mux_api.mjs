import Mux from '@mux/mux-node';
import 'dotenv/config';

const mux = new Mux({
  tokenId: process.env.MUX_TOKEN_ID,
  tokenSecret: process.env.MUX_TOKEN_SECRET
});

async function main() {
  try {
    const r = await fetch('https://api.mux.com/video/v1/uploads', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${process.env.MUX_TOKEN_ID}:${process.env.MUX_TOKEN_SECRET}`).toString('base64'),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        new_asset_settings: {
          playback_policy: ['public'],
          video_quality: 'plus',
          generated_subtitles: [{ name: 'Internal_AI', language_code: 'en' }]
        },
        cors_origin: '*'
      })
    });
    
    console.log(r.status);
    const text = await r.text();
    console.log(text);
  } catch (e) {
    console.error(e);
  }
}
main();
