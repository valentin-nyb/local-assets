import Mux from '@mux/mux-node';

const mux = new Mux({
  tokenId: process.env.PROD_MUX_TOKEN_ID,
  tokenSecret: process.env.PROD_MUX_TOKEN_SECRET
});

export default async function handler(req, res) {
  const { asset_id } = req.query;

  try {
    const asset = await mux.video.assets.retrieve(asset_id);
    // This sends the 'ready' status and the playback IDs back to your site
    return res.status(200).json(asset);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}