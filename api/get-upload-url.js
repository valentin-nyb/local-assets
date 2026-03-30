import Mux from '@mux/mux-node';

export default async function handler(req, res) {
  console.log("--- MUX DEBUG START ---");
  console.log("ID exists:", !!process.env.PROD_MUX_TOKEN_ID);
  console.log("Secret exists:", !!process.env.PROD_MUX_TOKEN_SECRET);
  console.log("ID Prefix:", process.env.PROD_MUX_TOKEN_ID?.substring(0, 4)); 
  console.log("--- MUX DEBUG END ---");

  const mux = new Mux({
    tokenId: (process.env.PROD_MUX_TOKEN_ID || '').trim(),
    tokenSecret: (process.env.PROD_MUX_TOKEN_SECRET || '').trim()
  });

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const upload = await mux.video.uploads.create({
      new_asset_settings: { playback_policy: ['public'], video_quality: 'plus' },
      cors_origin: '*'
    });
    return res.status(200).json({ url: upload.url, id: upload.id });
  } catch (e) {
    console.error("FULL ERROR:", e);
    return res.status(500).json({ error: e.message });
  }
}