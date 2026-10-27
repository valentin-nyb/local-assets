// Transactional emails, in the local / assets style: Helvetica headlines in capitals, mono labels with the accent
// dot, rounded cards and pill buttons, as on the site. Two looks: white with orange (light), near-black with green
// (dark). Table layout with inline styles, so it reads the same in Gmail, Apple Mail and Outlook.

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SITE = 'https://local-assets.com';
const FONT = "'Helvetica Neue', Helvetica, Arial, sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace";
const GREEN = '#85FA4F';
const ORANGE = '#EA580C';
// The light look, inline; the e-* classes switch to the dark look when the mail app is in dark mode
const L = { bg: '#ffffff', card: '#fafafa', text: '#0a0a0a', sub: '#52525b', dim: '#71717a', foot: '#a1a1aa', line: '#e4e4e7', line2: '#efeff1', outline: '#d4d4d8', link: '#18181b' };
const THEME = `<style>
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  @media (max-width:520px) {
    .e-wrap { padding:32px 18px !important; }
    .e-h1 { font-size:38px !important; }
    .e-col { display:block !important; width:auto !important; margin-bottom:12px; }
    .e-gap { display:none !important; }
    .e-btns td { display:block !important; }
    .e-btns .e-sp { height:10px !important; width:auto !important; }
  }
  @media (prefers-color-scheme: dark) {
    .e-lt { display:none !important; }
    .e-dk { display:block !important; max-height:none !important; }
    .e-bg { background:#070905 !important; }
    .e-card { background:#0d100b !important; }
    .e-t { color:#fafafa !important; } .e-s { color:#a1a1aa !important; } .e-d { color:#71717a !important; } .e-f { color:#52525b !important; }
    .e-acc { color:${GREEN} !important; } .e-dot { background:${GREEN} !important; }
    .e-btn { background:${GREEN} !important; } .e-btn-t { color:#000000 !important; }
    .e-line { border-color:#23261f !important; } .e-line2 { border-color:#1b1e18 !important; } .e-ol { border-color:#3f3f46 !important; }
    .e-link { color:#d4d4d8 !important; }
  }
</style>`;

// Gmail hides ("•••") any part of an email it has seen before in the same conversation: an invisible marker
// unique to each email, at the bottom. The preview line is the preheader, padded so no body text follows it.
const PREVIEW_PAD = '&#847;&zwnj;&nbsp;'.repeat(90);
const page = ({ title, preheader, body }) => {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${esc(title)}</title>${THEME}</head>
<body class="e-bg" style="margin:0;padding:0;background:${L.bg};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${esc(preheader)}${PREVIEW_PAD}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="e-bg" style="background:${L.bg}">
<tr><td align="center" class="e-wrap" style="padding:48px 24px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px">
${body}
${footer}
  </table>
</td></tr>
</table>
<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:transparent;mso-hide:all">${id}</div>
</body></html>`;
};

// ── Pieces ───────────────────────────────────────────────────────────────
const row = (inner, pad = '0') => `    <tr><td style="padding:${pad}">${inner}</td></tr>`;
// The wordmark as text, not an image: every mail app recolours text with its theme (Gmail's dark mode too).
// Black on light, white on dark. Next to it, what the email is about, in mono.
const header = (tag) => row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td valign="middle"><span class="e-t" style="font:700 24px/1 ${FONT};letter-spacing:-.04em;color:${L.text};white-space:nowrap">local&nbsp;/&nbsp;assets<span style="font-size:9px;letter-spacing:0;vertical-align:top;position:relative;top:1px;margin-left:1px">&trade;</span></span></td>
      ${tag ? `<td valign="middle" align="right" class="e-d" style="font:500 10px/1 ${MONO};letter-spacing:.24em;text-transform:uppercase;color:${L.dim};white-space:nowrap">${tag}</td>` : ''}
    </tr></table>`, '0 0 56px');
// Eyebrow with the accent dot, the big title in capitals, and the lead line
const hero = (eyebrow, title, lead, size = 46) => row(`
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td valign="middle" style="padding-right:10px"><div class="e-dot" style="width:6px;height:6px;border-radius:50%;background:${ORANGE};font-size:0;line-height:0">&nbsp;</div></td>
        <td valign="middle" class="e-acc" style="font:500 11px/1 ${MONO};letter-spacing:.28em;text-transform:uppercase;color:${ORANGE}">${eyebrow}</td>
      </tr></table>
      <h1 class="e-t e-h1" style="margin:18px 0 0;font:800 ${size}px/.95 ${FONT};letter-spacing:-.025em;text-transform:uppercase;color:${L.text}">${title}</h1>
      ${lead ? `<p class="e-s" style="margin:20px 0 0;font:400 17px/1.6 ${FONT};color:${L.sub}">${lead}</p>` : ''}`);
const label = (t) => `<p class="e-d" style="margin:0 0 8px;font:500 10px/1 ${MONO};letter-spacing:.24em;text-transform:uppercase;color:${L.dim}">${t}</p>`;
// A rounded card of rows: [label, value, small note]
const infoCard = (items) => row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="e-card e-line" style="background:${L.card};border:1px solid ${L.line};border-radius:20px">
      ${items.map(([l, v, n], i) => `<tr><td class="e-line" style="padding:20px 24px;${i ? `border-top:1px solid ${L.line};` : ''}">${label(l)}<p class="e-t" style="margin:0;font:600 17px/1.35 ${FONT};color:${L.text};word-break:break-word">${v}</p>${n ? `<p class="e-s" style="margin:6px 0 0;font:400 14px/1.5 ${FONT};color:${L.sub}">${n}</p>` : ''}</td></tr>`).join('')}
    </table>`, '36px 0 0');
// Pill buttons, as on the site: the first in the accent colour, then outlined ones
const pill = (href, text, main) => main
  ? `<td class="e-btn" style="border-radius:999px;background:${ORANGE}"><a class="e-btn-t" href="${href}" style="display:block;padding:18px 30px;font:700 13px/1 ${FONT};letter-spacing:.08em;text-transform:uppercase;color:#ffffff;text-decoration:none;border-radius:999px;text-align:center;white-space:nowrap">${text}</a></td>`
  : `<td class="e-ol" style="border-radius:999px;border:1px solid ${L.outline}"><a class="e-t" href="${href}" style="display:block;padding:17px 28px;font:700 13px/1 ${FONT};letter-spacing:.08em;text-transform:uppercase;color:${L.text};text-decoration:none;border-radius:999px;text-align:center;white-space:nowrap">${text}</a></td>`;
const buttons = (list, pad = '32px 0 0') => row(`<table role="presentation" cellpadding="0" cellspacing="0" border="0" class="e-btns"><tr>${list.map(([h, t], i) => (i ? '<td class="e-sp" width="10" style="width:10px;font-size:0">&nbsp;</td>' : '') + pill(h, t, i === 0)).join('')}</tr></table>`, pad);
// A section title in mono over a hairline
const section = (t, pad = '52px 0 0') => row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="e-acc e-line" style="padding:0 0 14px;border-bottom:1px solid ${L.line};font:500 10px/1 ${MONO};letter-spacing:.24em;text-transform:uppercase;color:${ORANGE}">${t}</td></tr></table>`, pad);
// Numbered steps, as in Camera Control: the number in the accent colour, the title in capitals
const steps = (list) => list.map(([t, d], i) => row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td width="48" valign="top" class="e-acc" style="padding:20px 0 0;font:500 12px/1.5 ${MONO};letter-spacing:.08em;color:${ORANGE}">${String(i + 1).padStart(2, '0')}</td>
        <td valign="top" class="e-line2" style="padding:20px 0;${i < list.length - 1 ? `border-bottom:1px solid ${L.line2};` : ''}">
          <p class="e-t" style="margin:0;font:700 14px/1.4 ${FONT};letter-spacing:.03em;text-transform:uppercase;color:${L.text}">${t}</p>
          <p class="e-s" style="margin:6px 0 0;font:400 15px/1.6 ${FONT};color:${L.sub}">${d}</p>
        </td></tr></table>`)).join('\n');
const note = (html, pad = '40px 0 0') => row(`<p class="e-d" style="margin:0;font:400 14px/1.6 ${FONT};color:${L.dim}">${html}</p>`, pad);
const mailLink = `<a href="mailto:info@local-assets.com" class="e-link" style="color:${L.link};text-decoration:underline">info@local-assets.com</a>`;
// The app cards: a™ for Mac (download) and the mobile app (coming soon)
const appCard = (eyebrow, ttl, line, cta) => `<td class="e-col e-card e-line" valign="top" width="50%" style="padding:22px 22px 24px;background:${L.card};border:1px solid ${L.line};border-radius:20px">
          ${label(eyebrow)}
          <p class="e-t" style="margin:0;font:800 16px/1.25 ${FONT};letter-spacing:.01em;text-transform:uppercase;color:${L.text}">${ttl}</p>
          <p class="e-s" style="margin:8px 0 18px;font:400 14px/1.55 ${FONT};color:${L.sub}">${line}</p>${cta}</td>`;
const apps = (macLine) => row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;border-spacing:0"><tr>
        ${appCard('macOS', 'a&trade; for Mac', macLine, `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td class="e-btn" style="border-radius:999px;background:${ORANGE}"><a class="e-btn-t" href="${SITE}/download" style="display:inline-block;padding:13px 20px;font:700 12px/1 ${FONT};letter-spacing:.08em;text-transform:uppercase;color:#ffffff;text-decoration:none;border-radius:999px">Download for Mac</a></td></tr></table>`)}
        <td class="e-gap" width="12" style="width:12px;min-width:12px;font-size:0;line-height:0">&nbsp;</td>
        ${appCard('iPhone &amp; iPad', 'Mobile app', 'Your sets and clips on the go.', `<p class="e-d e-ol" style="margin:0;display:inline-block;padding:11px 16px;border:1px dashed ${L.outline};border-radius:999px;font:500 10px/1 ${MONO};letter-spacing:.2em;text-transform:uppercase;color:${L.dim}">Coming soon</p>`)}
      </tr></table>`, '20px 0 0');
// The footer: the wordmark small, the places to go, and where the email comes from
const footer = row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="e-line" style="padding:28px 0 0;border-top:1px solid ${L.line}">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td valign="middle"><span class="e-t" style="font:700 15px/1 ${FONT};letter-spacing:-.03em;color:${L.text}">local&nbsp;/&nbsp;assets&trade;</span><span class="e-f" style="font:500 10px/1 ${MONO};letter-spacing:.2em;text-transform:uppercase;color:${L.foot}">&nbsp;&nbsp;&middot;&nbsp;&nbsp;London</span></td>
        <!-- The a: black on the light email, white on the dark one -->
        <td valign="middle" align="right" width="24"><img class="e-lt" src="${SITE}/logos/a-black.png" width="22" alt="a&trade;" style="display:block;width:22px;height:auto;border:0"><!--[if !mso]><!--><img class="e-dk" src="${SITE}/logos/a-white.png" width="22" alt="a&trade;" style="display:none;width:22px;height:auto;border:0;max-height:0;overflow:hidden"><!--<![endif]--></td>
      </tr></table>
      <p class="e-d" style="margin:16px 0 0;font:400 13px/1.7 ${FONT};color:${L.dim}"><a href="${SITE}" class="e-link" style="color:${L.link};text-decoration:none">local-assets.com</a> &nbsp;&middot;&nbsp; <a href="${SITE}/download" class="e-link" style="color:${L.link};text-decoration:none">Download a&trade;</a> &nbsp;&middot;&nbsp; <a href="${SITE}/privacy" class="e-link" style="color:${L.link};text-decoration:none">Privacy</a></p>
      <p class="e-d" style="margin:6px 0 0;font:400 12px/1.6 ${FONT};color:${L.dim}">&copy; ${new Date().getUTCFullYear()} local / assets LTD</p>
    </td></tr></table>`, '56px 0 0');

// The sender: local-assets.com, the domain verified in Resend. (RESEND_EMAIL_DOMAIN from the Vercel integration
// isn't used: Resend took the emails sent from it, then failed every one as "domain is not verified".)
export const SEND_DOMAIN = 'local-assets.com';
// Why Resend refused an email, safe to show: a broken key makes the HTTP library quote the key itself
// ("Bearer …" is an invalid header value), so that case never repeats the error text
export function mailError(e) {
  const m = String(e?.message || e?.name || e || 'refused');
  return /header|bearer|api key|unauthori[sz]ed|forbidden/i.test(m) ? 'the email key saved in Vercel (LA_RESEND_API_KEY) is not a valid Resend key' : m.slice(0, 200);
}
// Every email comes from info@ (the Google Workspace account), so Gmail shows its profile photo, the a
export const mailFrom = (box, name = 'local / assets') => `${name} <info@${SEND_DOMAIN}>`;
const plainText = v => String(v).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&trade;/g, '™').replace(/&[a-z]+;|&#\d+;/g, ' ');

// Welcome email after a sign-up. plan: { name, line } where line says what was paid and what's next.
export function welcomeEmail({ name, email, type, plan, ready }) {
  const who = type === 'label' ? 'record label' : type === 'artist' ? 'artist' : 'venue';
  const list = [
    ['Sign in', `Use Google with ${esc(email)}. There is no password to remember.`],
    ['Set up your Brand Kit', 'Add your logo and fonts. Your watermark goes on every clip and thumbnail.'],
    ['Connect a camera', 'In Camera Control, add a phone, OBS or an OBSBOT. Scan the QR code and press record.'],
    ['Get a™ for Mac', 'The app for your Mac: Camera Control, uploads, and recording from a camera plugged into it.'],
    ['Film your first set', ready
      ? 'Each set lands in Distribution History, with vertical clips ready to post.'
      : 'We’re preparing your private video storage and will email you the moment recordings can be saved.'],
  ];
  const preheader = `Your ${who} account is ${ready ? 'ready' : 'set up'}. Sign in with Google to get started.`;
  const html = page({ title: 'Welcome to local / assets', preheader, body: [
    header('Welcome'),
    hero('Welcome', esc(name), `Your ${who} account on local / assets is ${ready ? 'ready' : 'set up'}. Every set you film becomes a full-length recording, branded vertical clips and thumbnails, kept in one place and ready to post.`),
    infoCard([['Your plan', esc(plan.name), plan.line ? esc(plan.line) : '']]),
    buttons([[`${SITE}/login.html`, 'Sign in to your workspace'], [`${SITE}/download`, 'Download a&trade; for Mac']]),
    section('Getting started'),
    steps(list),
    note(`Questions? Reply to this email or write to ${mailLink}. Invoices and your card are under Billing once you sign in.`),
  ].join('\n') });
  const text = [
    `Welcome to local / assets, ${name}.`, '',
    `Your ${who} account is ${ready ? 'ready' : 'set up'}.`,
    `Plan: ${plan.name}${plan.line ? ' (' + plan.line + ')' : ''}`, '',
    ...list.map(([t, d], i) => `0${i + 1}  ${t}: ${plainText(d)}`), '',
    `Sign in: ${SITE}/login.html`,
    `Download a™ for Mac: ${SITE}/download`, '',
    'Questions? Reply to this email or write to info@local-assets.com.',
    '', `© ${new Date().getUTCFullYear()} local / assets LTD`,
  ].join('\n');
  return { subject: `Welcome to local / assets, ${name}`, html, text };
}

// Sent when a new account gets its private video storage after signing up (Billing → Finish setup or Ready
// video storage): everything is open now, and the first things to do.
export function storageReadyEmail({ name, email, type }) {
  const who = type === 'label' ? 'record label' : type === 'artist' ? 'artist' : type === 'management' ? 'management' : 'venue';
  const list = [
    ['Sign in', `With Google, using ${esc(email)}. There is no password to remember.`],
    ['Connect a camera', 'In Camera Control, add an OBSBOT, a DJI camera, a Sony Alpha or a phone. Each one gets its own stream address.'],
    ['Connect your calendar', 'Paste your Google or Apple Calendar link. Each event is a set: the cameras start and stop with it.'],
    ['Finish your Brand Kit', 'Logos (animated ones too), fonts and photos. Anything you added while you waited is kept.'],
    ['Film your first set', 'It lands in Distribution History with vertical clips and thumbnails, watermarked and ready to post.'],
  ];
  const preheader = `Your private video storage is set up. Recording, uploads and clips are open now.`;
  const html = page({ title: 'Your local / assets account is ready', preheader, body: [
    header('Account ready'),
    hero('You\'re ready', esc(name), `Your private video storage is set up, so your ${who} account is fully open: record sets, upload, and get branded vertical clips and thumbnails ready to post.`),
    buttons([[`${SITE}/login.html`, 'Open your workspace'], [`${SITE}/download`, 'Download a&trade; for Mac']], '36px 0 0'),
    section('Start here'),
    steps(list),
    note(`Need a hand setting up the cameras? Reply to this email or write to ${mailLink}.`),
  ].join('\n') });
  const text = [
    `${name}: your local / assets account is ready.`, '',
    `Your private video storage is set up, so your ${who} account is fully open: record sets, upload, and get branded vertical clips and thumbnails ready to post.`, '',
    'Start here:', ...list.map(([t, d], i) => `0${i + 1}  ${t}: ${plainText(d)}`), '',
    `Open your workspace: ${SITE}/login.html`, `Download a™ for Mac: ${SITE}/download`, '',
    'Need a hand setting up the cameras? Reply to this email or write to info@local-assets.com.',
    '', `© ${new Date().getUTCFullYear()} local / assets LTD`,
  ].join('\n');
  return { subject: `Your local / assets account is ready, ${name}`, html, text };
}

// The monthly invoice, sent on the 1st with Stripe's invoice: what the month cost, line by line, and the link
// to view or pay it. charged: the saved card was charged (a receipt); otherwise it's due in 14 days.
export function invoiceEmail({ name, period, plan, lines, total, url, charged, example }) {
  const money = n => '£' + Number(n || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const items = [
    ...(plan && plan.amount > 0 ? [[plan.name, 'Monthly plan', plan.amount]] : []),
    ...lines.filter(l => l.amount >= 0.01).map(l => [l.label, `${Number(l.quantity).toLocaleString('en-GB')} ${l.unit}${l.included ? ` · ${Number(l.billable).toLocaleString('en-GB')} over the ${Number(l.included).toLocaleString('en-GB')} included` : ''}`, l.amount]),
  ];
  const status = charged ? `Paid with your card on file. Thank you.` : `Due within 14 days. Pay by card or bank transfer from the invoice.`;
  const preheader = `${period}: ${money(total)}. ${charged ? 'Paid with your card.' : 'Due within 14 days.'}`;
  const table = row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="e-card e-line" style="background:${L.card};border:1px solid ${L.line};border-radius:20px">
      ${items.map(([t, d, a], i) => `<tr><td class="e-line" style="padding:18px 24px;${i ? `border-top:1px solid ${L.line};` : ''}"><p class="e-t" style="margin:0;font:600 15px/1.4 ${FONT};color:${L.text}">${esc(t)}</p><p class="e-d" style="margin:4px 0 0;font:400 13px/1.5 ${FONT};color:${L.dim}">${esc(d)}</p></td>
        <td align="right" valign="top" class="e-t e-line" style="padding:18px 24px;${i ? `border-top:1px solid ${L.line};` : ''}font:600 15px/1.4 ${FONT};color:${L.text};white-space:nowrap">${money(a)}</td></tr>`).join('')}
      <tr><td class="e-t e-line" style="padding:20px 24px;border-top:1px solid ${L.line};font:700 13px/1.4 ${FONT};letter-spacing:.08em;text-transform:uppercase;color:${L.text}">Total</td><td align="right" class="e-acc e-line" style="padding:20px 24px;border-top:1px solid ${L.line};font:800 20px/1.2 ${FONT};color:${ORANGE};white-space:nowrap">${money(total)}</td></tr>
    </table>`, '36px 0 0');
  const html = page({ title: 'Your local / assets invoice', preheader, body: [
    header(esc(period)),
    example ? row(`<p class="e-s e-ol" style="margin:0;padding:12px 16px;border:1px dashed ${L.outline};border-radius:14px;font:400 14px/1.5 ${FONT};color:${L.sub}">Example only: this is what ${esc(name)} receives on the 1st. Nothing was charged.</p>`, '0 0 28px') : '',
    hero(`Invoice &middot; ${esc(period)}`, money(total), `${esc(name)}: your local / assets plan and usage for ${esc(period)}. ${status}`, 52),
    table,
    buttons([[esc(url || SITE + '/billing'), charged ? 'View the invoice' : 'View and pay the invoice'], [`${SITE}/billing`, 'Your billing']]),
    note(`Every invoice is also in your account under Billing, with its PDF. Questions? Reply to this email or write to ${mailLink}.`),
  ].join('\n') });
  const text = [
    `${example ? '[Example] ' : ''}local / assets invoice · ${period}`, '', `${name}: ${money(total)}. ${status}`, '',
    ...items.map(([t, d, a]) => `${t} (${d}): ${money(a)}`), `Total: ${money(total)}`, '',
    `${charged ? 'View' : 'View and pay'} the invoice: ${url || SITE + '/billing'}`, 'Questions? Reply to this email or write to info@local-assets.com.',
    '', `© ${new Date().getUTCFullYear()} local / assets LTD`,
  ].join('\n');
  return { subject: `${example ? '[Example] ' : ''}Your local / assets invoice for ${period}: ${money(total)}`, html, text };
}

// The email someone gets when they're given access to an account: an artist given access to their own sets
// (Brand Kit → Give access), or a person added as a login of the whole account (Accounts → Logins). It says
// what they can do in the app. example: a sample sent by local / assets.
const ACCESS = {
  artist: {
    lead: (account) => `${esc(account)} added you to local / assets. Every set you play there is recorded and turned into clips and thumbnails with your name on them, ready to post.`,
    can: (account) => [
      ['See your sets', `Every set you play at ${esc(account)}, kept in Distribution History.`],
      ['Watch and download', 'The full recording, the HQ audio, your vertical clips and thumbnails, in full quality.'],
      ['Your calendar', `Your upcoming sets at ${esc(account)}.`],
      ['Your Brand Kit', 'Keep your logo, photos and links up to date. They go on your clips and thumbnails.'],
    ],
    mac: 'Your sets, clips and Brand Kit on your Mac.',
  },
  team: {
    lead: (account) => `You've been added to ${esc(account)} on local / assets. Every set filmed there becomes a full recording, branded vertical clips and thumbnails, kept in one place and ready to post.`,
    can: () => [
      ['Distribution History', 'Every set: watch, download, watermark, and send to YouTube and SoundCloud.'],
      ['Camera Control', 'Connect cameras and the mixer, see them live, and record with the calendar.'],
      ['Calendar', 'Connect the calendar once: the cameras start and stop with each set.'],
      ['Brand Kit and watermark', 'Logos, fonts and photos for the account and each artist, and the watermark on every clip.'],
      ['Artists, contacts and uploads', 'Give artists access to their own sets, keep the contacts up to date, and upload sets.'],
    ],
    mac: 'Camera Control, uploads and recording from a camera plugged into the Mac.',
  },
};
export function accessInviteEmail({ artist, account, email, example, kind = 'artist' }) {
  const K = ACCESS[kind] || ACCESS.artist;
  const title = kind === 'team' ? account : artist;
  const list = [['Sign in', `With Google, using ${esc(email)}. There is no password to remember.`]].concat(K.can(account));
  const preheader = kind === 'team' ? `You've been added to ${account} on local / assets. Sign in with Google to start.` : `${account} gave you access to your sets on local / assets. Sign in with Google to see them.`;
  const html = page({ title: 'You have access to local / assets', preheader, body: [
    header('Access'),
    hero('You have access', esc(title), K.lead(account)),
    infoCard([[kind === 'team' ? 'Access' : 'Account', kind === 'team' ? 'The whole account' : esc(account)], ['Sign in with', esc(email)]]),
    buttons([[`${SITE}/login.html`, 'Sign in to your workspace']]),
    section('What you can do'),
    steps(list),
    section('Get the app'),
    apps(K.mac),
    note('Until then, local-assets.com works in your phone\'s browser: sign in and add it to your home screen.', '16px 0 0'),
    note(`Questions? Reply to this email or write to ${mailLink}.`, '32px 0 0'),
  ].join('\n') });
  const text = [
    kind === 'team' ? `You've been added to ${account} on local / assets.` : `You have access to local / assets, ${artist}.`, '',
    plainText(K.lead(account)), '',
    `Sign in with: ${email}`, '',
    'What you can do:',
    ...list.map(([t, d], i) => `0${i + 1}  ${t}: ${plainText(d)}`), '',
    `Sign in: ${SITE}/login.html`,
    `Download a™ for Mac: ${SITE}/download`,
    'iPhone and iPad app: coming soon (local-assets.com works in your phone\'s browser).', '',
    'Questions? Reply to this email or write to info@local-assets.com.',
    '', `© ${new Date().getUTCFullYear()} local / assets LTD`,
  ].join('\n');
  return { subject: `${example ? '[Example] ' : ''}You have access to local / assets: ${account}`, html, text };
}
