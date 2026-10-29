import { getWebSessionAuth, isAdminVenue } from './_venues.js';
import { mailError } from './_emails.js';

// Admin only (local / assets): the Resend inbox (info@local-assets.com) in the side menu's Inbox.
// The inbox's agent writes its replies as drafts; nothing goes out until one is sent from here (or Resend).
//   GET  ?view=count                         unread threads and drafts waiting, for the menu badge
//   GET  ?folder=inbox|archive|sent|spam|trash[&after=id]   the threads in a folder, newest first (inbox: with the sent ones)
//   GET  ?thread=id                          its emails and its drafts (marks it read)
//   POST { action: 'send', draft }           a draft goes out
//   POST { action: 'discard', draft }        a draft is thrown away
//   POST { action: 'editDraft', draft, text } a draft's words changed before sending
//   POST { action: 'reply', thread, email, text }   a reply written here
//   POST { action: 'move', thread, folder }  to inbox, archive, spam or trash
//   POST { action: 'read', thread, read }    marked read or unread

const INBOX = () => (process.env.LA_INBOX || 'info@local-assets.com').trim();
const FOLDERS = ['inbox', 'archive', 'sent', 'spam', 'trash'];
const admins = () => (process.env.BILLING_ADMINS || 'info@local-assets.com').split(/[\s,]+/).map(s => s.toLowerCase()).filter(Boolean);
const id = v => /^[\w-]{1,80}$/.test(String(v || '')) ? String(v) : null;

async function rs(path, { method = 'GET', body, idem } = {}) {
  const key = (process.env.LA_RESEND_API_KEY || process.env.RESEND_API_KEY || '').trim();
  if (!key) throw new Error('Email is not set up (LA_RESEND_API_KEY)');
  const headers = { Authorization: 'Bearer ' + key, 'User-Agent': 'local-assets' };
  if (body) headers['Content-Type'] = 'application/json';
  if (idem) headers['Idempotency-Key'] = idem;
  const r = await fetch('https://api.resend.com/inboxes/' + encodeURIComponent(INBOX()) + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  const d = r.status === 204 ? {} : await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.message || d.error || ('Resend answered ' + r.status)), { status: r.status });
  return d;
}

const toHtml = t => String(t).split(/\n{2,}/).map(p => '<p>' + p.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/\n/g, '<br>') + '</p>').join('');

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const session = getWebSessionAuth(req);
  if (!session?.email || !admins().includes(String(session.email).toLowerCase()) || !isAdminVenue(session.venue)) {
    return res.status(403).json({ error: 'Only local / assets can open the inbox. Switch to the local / assets account first.' });
  }
  try {
    if (req.method === 'GET') {
      const q = req.query || {};
      if (q.view === 'count') {
        const box = await rs('');
        return res.json({ unread: box.unread || 0, drafts: box.drafts || 0, address: box.email_address || INBOX() });
      }
      if (q.thread) {
        const t = id(q.thread); if (!t) return res.status(400).json({ error: 'Which conversation?' });
        const [thread, emails, drafts] = await Promise.all([rs('/threads/' + t), rs('/threads/' + t + '/emails'), rs('/drafts?limit=100')]);
        const mine = await Promise.all((drafts.data || []).filter(d => d.thread_id === t).map(d => rs('/drafts/' + d.id)));
        if (!thread.read) rs('/threads/' + t, { method: 'PATCH', body: { read: true } }).catch(() => {});
        return res.json({ thread, emails: emails.data || [], drafts: mine });
      }
      const folder = FOLDERS.includes(q.folder) ? q.folder : 'inbox';
      const after = id(q.after);
      const list = await rs('/threads?folders=' + (folder === 'inbox' ? 'inbox,sent' : folder) + '&limit=50' + (after ? '&after=' + after : ''));
      return res.json({ folder, threads: list.data || [], more: !!list.has_more });
    }

    if (req.method === 'POST') {
      const b = req.body || {};
      const draft = id(b.draft), thread = id(b.thread);
      if (b.action === 'send' && draft) return res.json({ sent: (await rs('/drafts/' + draft + '/send', { method: 'POST', idem: 'send-' + draft })).id });
      if (b.action === 'discard' && draft) { await rs('/drafts/' + draft, { method: 'DELETE' }); return res.json({ ok: true }); }
      if (b.action === 'editDraft' && draft) {
        const text = String(b.text || '').trim(); if (!text) return res.status(400).json({ error: 'The reply is empty.' });
        return res.json({ draft: await rs('/drafts/' + draft, { method: 'PATCH', body: { text, html: toHtml(text) } }) });
      }
      if (b.action === 'reply' && thread && id(b.email)) {
        const text = String(b.text || '').trim(); if (!text) return res.status(400).json({ error: 'Write the reply first.' });
        return res.json({ sent: (await rs('/threads/' + thread + '/emails/' + id(b.email) + '/reply', { method: 'POST', body: { text, html: toHtml(text) }, idem: b.key && id(b.key) ? 'reply-' + b.key : undefined })).id });
      }
      if (b.action === 'move' && thread && FOLDERS.includes(b.folder) && b.folder !== 'sent') { await rs('/threads/' + thread, { method: 'PATCH', body: { folder: b.folder } }); return res.json({ ok: true }); }
      if (b.action === 'read' && thread) { await rs('/threads/' + thread, { method: 'PATCH', body: { read: !!b.read } }); return res.json({ ok: true }); }
      return res.status(400).json({ error: 'Unknown action' });
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    const msg = e.status === 401 || e.status === 403 ? 'The Resend key saved in Vercel (LA_RESEND_API_KEY) can\'t open inboxes: it needs Full access.' : e.status === 404 ? 'Resend has no inbox called ' + INBOX() + '.' : mailError(e);
    return res.status(e.status && e.status < 500 ? 502 : 500).json({ error: msg });
  }
}
