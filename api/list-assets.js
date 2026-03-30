import Mux from '@mux/mux-node';

const mux = new Mux({
  tokenId: process.env.PROD_MUX_TOKEN_ID,
  tokenSecret: process.env.PROD_MUX_TOKEN_SECRET
});

export default async function handler(req, res) {
  try {
    const assets = await mux.video.assets.list({ limit: 25 });
    // Important: Mux returns a list object, we send it directly
    return res.status(200).json(assets);
  } catch (e) {
    console.error("LIST_ASSETS_ERROR:", e.message);
    return res.status(500).json({ error: e.message });
  }
}