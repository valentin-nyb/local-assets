// Vercel Serverless Function: /api/webhook-handler.js

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Log webhook payload for debugging
  console.log('MUX WEBHOOK:', req.body);

  // Optionally validate webhook signature here
  // const signature = req.headers['mux-signature'];
  // ...validate signature with process.env.MUX_WEBHOOK_SECRET...

  // Respond to Mux
  res.status(200).json({ received: true });
}
