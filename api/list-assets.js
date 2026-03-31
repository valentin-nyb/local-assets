const { default: Mux } = require('@mux/mux-node');

const mux = new Mux({
  tokenId: process.env.PROD_MUX_TOKEN_ID,
  tokenSecret: process.env.PROD_MUX_TOKEN_SECRET
});

module.exports = async function handler(req, res) {
  try {
    const response = await mux.video.assets.list({ limit: 25 });
    const assets = response.data ?? response;
    return res.status(200).json(assets);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}