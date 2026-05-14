export default function handler(req, res) {
  const raw = process.env.VENUES_CONFIG || 'NOT SET';
  let parsed = null;
  let parseError = null;
  try { parsed = JSON.parse(raw); } catch(e) { parseError = e.message; }
  res.json({
    raw_length: raw.length,
    raw_preview: raw.slice(0, 300),
    parse_ok: parseError === null,
    parse_error: parseError,
    venue_keys: parsed ? Object.keys(parsed) : null
  });
}
