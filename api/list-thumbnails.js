// DEPRECATED — this endpoint is no longer used. Returns 410 Gone.\nexport default function handler(req, res) {\n  return res.status(410).json({ error: 'This endpoint has been removed' });\n}
