export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  return res.redirect('/client.html?error=google_required');
}
