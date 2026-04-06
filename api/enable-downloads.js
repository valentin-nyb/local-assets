import Mux from '@mux/mux-node';

const mux = new Mux({
  tokenId: (process.env.PROD_MUX_TOKEN_ID || process.env.MUX_TOKEN_ID || '').trim(),
  tokenSecret: (process.env.PROD_MUX_TOKEN_SECRET || process.env.MUX_TOKEN_SECRET || '').trim()
});

export default async function handler(req, res) {
  try {
    const assets = await mux.video.assets.list({ limit: 100 });
    const list = Array.isArray(assets) ? assets : (assets.data || []);

    let updated = 0;
    let skipped = 0;
    const errors = [];

    for (const asset of list) {
      if (asset.mp4_support === 'standard') {
        skipped++;
        continue;
      }
      try {
        await mux.video.assets.update(asset.id, { mp4_support: 'standard' });
        updated++;
      } catch (e) {
        errors.push({ id: asset.id, error: e.message });
      }
    }

    return res.status(200).json({ updated, skipped, errors, total: list.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
