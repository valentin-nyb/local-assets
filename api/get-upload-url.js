import Mux from '@mux/mux-node';

const mux = new Mux({
  tokenId: (process.env.PROD_MUX_TOKEN_ID || process.env.MUX_TOKEN_ID || '').trim(),
  tokenSecret: (process.env.PROD_MUX_TOKEN_SECRET || process.env.MUX_TOKEN_SECRET || '').trim()
});

// Generate a unique passthrough ID from artist name and date
function generatePassthroughId(artistName, date) {
  const safeArtist = String(artistName).toUpperCase().trim().replace(/\s+/g, '_').replace(/[^A-Z0-9_\-]/g, '');
  const safeDate = String(date).replace(/[^\d\-]/g, '');
  return `${safeArtist}_${safeDate}`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Try to find the name in query params OR the request body
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch(e) {}
  }
  const artistName = req.query.artistName || (body && body.artistName) || (body && body.passthrough) || 'SESSION_ARCHIVE';

  const isAudio = String(artistName).toUpperCase().includes('// AUDIO');
  const srResolution = isAudio ? 'audio-only' : 'highest';
  const dateStr = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase();
  const videoTitle = String(artistName).toUpperCase() + ' — ' + dateStr;

  // Use today's date in YYYY-MM-DD format
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  const dateIso = `${yyyy}-${mm}-${dd}`;
  const passthroughId = generatePassthroughId(artistName, dateIso);

  try {
    const upload = await mux.video.uploads.create({
      new_asset_settings: { 
        playback_policy: ['public'],
        passthrough: passthroughId,
        name: videoTitle,
        static_renditions: [{ resolution: srResolution }]
      },
      cors_origin: '*',
    });
    return res.status(200).json({ url: upload.url, id: upload.id });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}