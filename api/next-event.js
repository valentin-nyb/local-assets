import ical from 'node-ical';

function toDate(d) {
  if (d instanceof Date) return d;
  if (typeof d === 'string') return new Date(d);
  if (d && d.toISOString) return new Date(d.toISOString());
  return new Date(d);
}

export default async function handler(req, res) {
  const calUrl = process.env.ICAL_URL;
  if (!calUrl) {
    return res.status(500).json({ error: 'ICAL_URL env variable not set' });
  }

  try {
    const data = await ical.async.fromURL(calUrl);
    const now = new Date();

    const events = Object.values(data).filter(ev => ev.type === 'VEVENT');

    const upcoming = events
      .map(ev => ({
        title: ev.summary || 'Untitled',
        location: ev.location || null,
        start: toDate(ev.start),
        end: ev.end ? toDate(ev.end) : null,
      }))
      .filter(ev => ev.start >= now)
      .sort((a, b) => a.start - b.start)
      .slice(0, 3)
      .map(ev => ({
        ...ev,
        start: ev.start.toISOString(),
        end: ev.end ? ev.end.toISOString() : null,
      }));

    return res.status(200).json({ events: upcoming });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
