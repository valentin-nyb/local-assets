// Test endpoint — disabled in production.
export default function handler(req, res) {
  return res.status(410).json({ error: 'Test endpoint disabled' });
}
