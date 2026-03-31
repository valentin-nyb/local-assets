// patch-assets.mjs — run once with: node patch-assets.mjs
import Mux from '@mux/mux-node';

const mux = new Mux({
  tokenId: process.env.PROD_MUX_TOKEN_ID,
  tokenSecret: process.env.PROD_MUX_TOKEN_SECRET
});

const patches = [
  { id: 'YOUR_ASSET_ID_1', name: 'DJ NAME // 31 Mar 2026 // MASTER' },
  { id: 'YOUR_ASSET_ID_2', name: 'DJ NAME // 31 Mar 2026 // BOOTH' },
  { id: 'YOUR_ASSET_ID_3', name: 'DJ NAME // 31 Mar 2026 // MASTER' },
];

for (const { id, name } of patches) {
  await mux.video.assets.update(id, { passthrough: name });
  console.log(`✓ Patched ${id} → ${name}`);
}