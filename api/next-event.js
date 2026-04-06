import ical from 'node-ical';

export default async function handler(req, res) {
  const calUrl = process.env.ICAL_URL;
  if (!calUrl) {
    return res.status(500).json({ error: 'ICAL_URL env variable not set' });
  }

  try {
    const data = await ical.async.fromURL(calUrl);
    const now = new Date();

    const upcoming = Object.values(data)
      .filter(ev => ev.type === 'VEVENT' && new Date(ev.start) >= now)
      .sort((a, b) => new Date(a.start) - new Date(b.start))
      .slice(0, 3)
      .map(ev => ({
        title: ev.summary || 'Untitled',
        location: ev.location || null,
        start: new Date(ev.start).toISOString(),
        end: ev.end ? new Date(ev.end).toISOString() : null,
      }));

    return res.status(200).json({ events: upcoming });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
