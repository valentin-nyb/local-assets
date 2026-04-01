import Mux from '@mux/mux-node';

const mux = new Mux({
  tokenId: process.env.PROD_MUX_TOKEN_ID || process.env.MUX_TOKEN_ID,
  tokenSecret: process.env.PROD_MUX_TOKEN_SECRET || process.env.MUX_TOKEN_SECRET
});

export default async function handler(req, res) {
  try {
    // Fetches the 25 most recent videos from your Mux account
    const assets = await mux.video.assets.list({ limit: 25 });
    return res.status(200).json(assets);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}