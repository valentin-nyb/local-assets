// api/get-upload-url.js
import Mux from '@mux/mux-node';

const { Video } = new Mux(process.env.MUX_TOKEN_ID, process.env.MUX_TOKEN_SECRET);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const upload = await Video.Uploads.create({
      new_asset_settings: { 
        playback_policy: 'public',
        // THIS ENABLES DOWNLOADS:
        static_renditions: 'request' 
      },
      cors_origin: '*', // Allows your localhost to talk to Mux
    });

    // We return both the upload URL and the ID
    res.status(200).json({ 
      url: upload.url, 
      id: upload.id 
    });
  } catch (error) {
    console.error('MUX_CONNECTION_ERROR:', error);
    res.status(500).json({ error: 'Mux Handshake Failed' });
  }
}
