// Transactional emails, in the local / assets style: Helvetica, white and orange, or near-black and green in dark mode.
// Table layout with inline styles, so it reads the same in Gmail, Apple Mail and Outlook.

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SITE = 'https://local-assets.com';
const FONT = "'Helvetica Neue', Helvetica, Arial, sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace";
const GREEN = '#85FA4F';
// Two looks, like the app: light (white with orange) by default, dark (near-black with green) when the
// reader's mail app is in dark mode. Inline styles carry the light look; the classes below switch to dark.
const ORANGE = '#EA580C';
const L = { bg: '#ffffff', text: '#0a0a0a', sub: '#52525b', dim: '#71717a', foot: '#a1a1aa', line: '#e4e4e7', line2: '#f0f0f1', outline: '#d4d4d8', link: '#18181b' };
const THEME = `<style>
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  .e-dk { display:none; max-height:0; overflow:hidden; mso-hide:all; }
  /* Phones: the two app cards one above the other */
  @media (max-width:480px) { .e-col { display:block !important; width:auto !important; margin-bottom:12px; } .e-gap { display:none !important; } }
  @media (prefers-color-scheme: dark) {
    .e-bg { background:#070905 !important; }
    .e-t { color:#fafafa !important; } .e-s { color:#a1a1aa !important; } .e-d { color:#71717a !important; } .e-f { color:#52525b !important; }
    .e-acc { color:${GREEN} !important; } .e-btn { background:${GREEN} !important; } .e-btn-t { color:#000000 !important; }
    .e-line { border-color:#23261f !important; } .e-line2 { border-color:#1b1e18 !important; } .e-ol { border-color:#3f3f46 !important; }
    .e-link { color:#d4d4d8 !important; }
    .e-lt { display:none !important; max-height:0 !important; overflow:hidden !important; }
    .e-dk { display:block !important; max-height:none !important; overflow:visible !important; }
  }
</style>`;
const head = (title) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${title}</title>${THEME}</head>`;
const wordmark = `<img class="e-lt" src="${SITE}/logos/email-wordmark-orange.png" width="150" height="19" alt="local / assets" style="display:block;width:150px;height:19px;border:0"><!--[if !mso]><!--><img class="e-dk" src="${SITE}/logos/email-wordmark.png" width="150" height="19" alt="local / assets" style="width:150px;height:19px;border:0"><!--<![endif]-->`;
const footer = `<tr><td style="padding:40px 4px 0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="e-line2" style="border-top:1px solid ${L.line2}"><tr>
        <td class="e-f" style="padding:20px 0 0;font:500 10px/1.6 ${MONO};letter-spacing:.2em;text-transform:uppercase;color:${L.foot}">local / assets&trade; &middot; London</td>
        <td align="right" style="padding:20px 0 0"><img class="e-lt" src="${SITE}/logos/a-black.png" width="18" alt="" style="display:inline-block;width:18px;height:auto;border:0;opacity:.7"><!--[if !mso]><!--><img class="e-dk" src="${SITE}/logos/a-white.png" width="18" alt="" style="width:18px;height:auto;border:0;opacity:.7;margin-left:auto"><!--<![endif]--></td>
      </tr></table>
    </td></tr>`;
const button = (href, label) => `<td class="e-btn" style="border-radius:999px;background:${ORANGE}">
        <a class="e-btn-t" href="${href}" style="display:inline-block;padding:15px 34px;font:600 14px/1 ${FONT};color:#ffffff;text-decoration:none;border-radius:999px">${label}</a>
      </td>`;
const button2 = (href, label) => `<td class="e-ol" style="border-radius:999px;border:1px solid ${L.outline}">
        <a class="e-t" href="${href}" style="display:inline-block;padding:14px 28px;font:600 14px/1 ${FONT};color:${L.text};text-decoration:none;border-radius:999px">${label}</a>
      </td>`;
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

// Welcome email after a sign-up. plan: { name, line } where line says what was paid and what's next.
export function welcomeEmail({ name, email, type, plan, ready }) {
  const who = type === 'label' ? 'record label' : type === 'artist' ? 'artist' : 'venue';
  const steps = [
    ['Sign in', `Use Google with ${esc(email)}. There is no password to remember.`],
    ['Set up your Brand Kit', 'Add your logo and fonts. Your watermark goes on every clip and thumbnail.'],
    ['Connect a camera', 'In Camera Control, add a phone, OBS or an OBSBOT. Scan the QR code and press record.'],
    ['Get a™ for Mac', `The app for your Mac: Camera Control, uploads, and recording from a camera plugged into it. <a href="${SITE}/download" style="color:${L.link};text-decoration:underline" class="e-link">Download it here</a> (sign in first).`],
    ['Film your first set', ready
      ? 'Each set lands in Distribution History, with vertical clips ready to post.'
      : 'We’re preparing your private video storage and will email you the moment recordings can be saved.'],
  ];
  const preheader = `Your ${who} account is ${ready ? 'ready' : 'set up'}. Sign in with Google to get started.`;

  const html = `${head('Welcome to local / assets')}
<body class="e-bg" style="margin:0;padding:0;background:${L.bg};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${L.bg}">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="e-bg" style="background:${L.bg}">
<tr><td align="center" style="padding:48px 16px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px">
    <tr><td style="padding:0 4px 40px">${wordmark}</td></tr>
    <tr><td style="padding:0 4px">
      <p style="margin:0 0 14px;font:500 11px/1 ${MONO};letter-spacing:.3em;text-transform:uppercase;color:${ORANGE}" class="e-acc">Welcome</p>
      <h1 style="margin:0;font:700 40px/1 ${FONT};letter-spacing:-.01em;text-transform:uppercase;color:${L.text}" class="e-t">${esc(name)}</h1>
      <p style="margin:20px 0 0;font:400 16px/1.6 ${FONT};color:${L.sub}" class="e-s">Your ${who} account on local / assets is ${ready ? 'ready' : 'set up'}. Every set you film becomes a full-length recording, branded vertical clips and thumbnails, kept in one place and ready to post.</p>
    </td></tr>
    <tr><td style="padding:32px 4px 0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="e-line" style="border:1px solid ${L.line};border-radius:14px">
        <tr><td style="padding:18px 22px">
          <p style="margin:0 0 6px;font:500 10px/1 ${MONO};letter-spacing:.24em;text-transform:uppercase;color:${L.dim}" class="e-d">Your plan</p>
          <p style="margin:0;font:600 17px/1.3 ${FONT};color:${L.text}" class="e-t">${esc(plan.name)}</p>
          ${plan.line ? `<p style="margin:6px 0 0;font:400 14px/1.5 ${FONT};color:${L.sub}" class="e-s">${esc(plan.line)}</p>` : ''}
        </td></tr>
      </table>
    </td></tr>
    <tr><td style="padding:36px 4px 8px"><p style="margin:0;font:500 10px/1 ${MONO};letter-spacing:.24em;text-transform:uppercase;color:${L.dim}" class="e-d">Getting started</p></td></tr>
    ${steps.map(([t, d], i) => `<tr><td style="padding:0 4px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="e-line2" style="border-top:1px solid ${L.line2}"><tr>
        <td width="44" valign="top" style="padding:18px 0;font:500 11px/1.5 ${MONO};letter-spacing:.1em;color:${ORANGE}" class="e-acc">0${i + 1}</td>
        <td valign="top" style="padding:16px 0"><p style="margin:0;font:600 15px/1.4 ${FONT};color:${L.text}" class="e-t">${t}</p><p style="margin:4px 0 0;font:400 14px/1.55 ${FONT};color:${L.sub}" class="e-s">${d}</p></td>
      </tr></table></td></tr>`).join('')}
    <tr><td style="padding:28px 4px 0">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${button(`${SITE}/login.html`, `Sign in to your workspace`)}<td width="12"></td>${button2(`${SITE}/download`, `Download a™ for Mac`)}</tr></table>
    </td></tr>
    <tr><td style="padding:44px 4px 0">
      <p style="margin:0;font:400 13px/1.6 ${FONT};color:${L.dim}" class="e-d">Questions? Reply to this email or write to <a href="mailto:info@local-assets.com" style="color:${L.link};text-decoration:underline" class="e-link">info@local-assets.com</a>. Invoices and your card are under Billing once you sign in.</p>
    </td></tr>
    ${footer}
  </table>
</td></tr>
</table>
</body></html>`;

  const text = [
    `Welcome to local / assets, ${name}.`, '',
    `Your ${who} account is ${ready ? 'ready' : 'set up'}.`,
    `Plan: ${plan.name}${plan.line ? ' (' + plan.line + ')' : ''}`, '',
    ...steps.map(([t, d], i) => `0${i + 1}  ${t}: ${d.replace(/<[^>]+>/g, '').replace(/&[a-z]+;|&#\d+;/g, ' ')}`), '',
    `Sign in: ${SITE}/login.html`,
    `Download a™ for Mac: ${SITE}/download`, '',
    'Questions? Reply to this email or write to info@local-assets.com.',
  ].join('\n');

  return { subject: `Welcome to local / assets, ${name}`, html, text };
}

// The monthly invoice, sent on the 1st with Stripe's invoice: what the month cost, line by line, and the link
// to view or pay it. charged: the saved card was charged (a receipt); otherwise it's due in 14 days.
export function invoiceEmail({ name, period, plan, lines, total, url, charged, example }) {
  const money = n => '£' + Number(n || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const rows = [
    ...(plan && plan.amount > 0 ? [[plan.name, 'Monthly plan', plan.amount]] : []),
    ...lines.filter(l => l.amount >= 0.01).map(l => [l.label, `${Number(l.quantity).toLocaleString('en-GB')} ${l.unit}${l.included ? ` · ${Number(l.billable).toLocaleString('en-GB')} over the ${Number(l.included).toLocaleString('en-GB')} included` : ''}`, l.amount]),
  ];
  const status = charged ? `Paid with your card on file. Thank you.` : `Due within 14 days. Pay by card or bank transfer from the invoice.`;
  const preheader = `${period}: ${money(total)}. ${charged ? 'Paid with your card.' : 'Due within 14 days.'}`;
  const html = `${head('Your local / assets invoice')}
<body class="e-bg" style="margin:0;padding:0;background:${L.bg};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${L.bg}">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="e-bg" style="background:${L.bg}">
<tr><td align="center" style="padding:48px 16px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px">
    <tr><td style="padding:0 4px 40px">${wordmark}</td></tr>
    ${example ? `<tr><td style="padding:0 4px 20px"><p style="margin:0;padding:10px 14px;border:1px dashed ${L.outline};border-radius:10px;font:400 13px/1.5 ${FONT};color:${L.sub}" class="e-s">Example only: this is what ${esc(name)} receives on the 1st. Nothing was charged.</p></td></tr>` : ''}
    <tr><td style="padding:0 4px">
      <p style="margin:0 0 14px;font:500 11px/1 ${MONO};letter-spacing:.3em;text-transform:uppercase;color:${ORANGE}" class="e-acc">Invoice · ${esc(period)}</p>
      <h1 style="margin:0;font:700 48px/1 ${FONT};letter-spacing:-.01em;color:${L.text}" class="e-t">${money(total)}</h1>
      <p style="margin:16px 0 0;font:400 16px/1.6 ${FONT};color:${L.sub}" class="e-s">${esc(name)}: your local / assets plan and usage for ${esc(period)}. ${status}</p>
    </td></tr>
    <tr><td style="padding:32px 4px 0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="e-line" style="border:1px solid ${L.line};border-radius:14px">
        ${rows.map(([t, d, a], i) => `<tr><td style="padding:16px 22px;${i ? 'border-top:1px solid ' + L.line2 + ';' : ''}"><p style="margin:0;font:600 15px/1.4 ${FONT};color:${L.text}" class="e-t">${esc(t)}</p><p style="margin:3px 0 0;font:400 13px/1.5 ${FONT};color:${L.dim}" class="e-d">${esc(d)}</p></td>
          <td align="right" valign="top" style="padding:16px 22px;${i ? 'border-top:1px solid ' + L.line2 + ';' : ''}font:600 15px/1.4 ${FONT};color:${L.text};white-space:nowrap" class="e-t">${money(a)}</td></tr>`).join('')}
        <tr><td style="padding:16px 22px;border-top:1px solid ${L.line};font:600 15px/1.4 ${FONT};color:${L.text}" class="e-t">Total</td><td align="right" style="padding:16px 22px;border-top:1px solid ${L.line};font:700 17px/1.4 ${FONT};color:${ORANGE};white-space:nowrap" class="e-acc">${money(total)}</td></tr>
      </table>
    </td></tr>
    <tr><td style="padding:28px 4px 0">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${button(`${esc(url || SITE + '/billing')}`, `${charged ? 'View the invoice' : 'View and pay the invoice'}`)}<td width="12"></td>${button2(`${SITE}/billing`, `Your billing`)}</tr></table>
    </td></tr>
    <tr><td style="padding:44px 4px 0">
      <p style="margin:0;font:400 13px/1.6 ${FONT};color:${L.dim}" class="e-d">Every invoice is also in your account under Billing, with its PDF. Questions? Reply to this email or write to <a href="mailto:info@local-assets.com" style="color:${L.link};text-decoration:underline" class="e-link">info@local-assets.com</a>.</p>
    </td></tr>
    ${footer}
  </table>
</td></tr>
</table>
</body></html>`;
  const text = [
    `${example ? '[Example] ' : ''}local / assets invoice · ${period}`, '', `${name}: ${money(total)}. ${status}`, '',
    ...rows.map(([t, d, a]) => `${t} (${d}): ${money(a)}`), `Total: ${money(total)}`, '',
    `${charged ? 'View' : 'View and pay'} the invoice: ${url || SITE + '/billing'}`, 'Questions? Reply to this email or write to info@local-assets.com.',
  ].join('\n');
  return { subject: `${example ? '[Example] ' : ''}Your local / assets invoice for ${period}: ${money(total)}`, html, text };
}

// The email someone gets when they're given access to an account: an artist given access to their own sets
// (Brand Kit → Give access), or a person added as a login of the whole account (Accounts → Logins). It says
// what they can do in the app and what they can't. example: a sample sent by local / assets.
const ACCESS = {
  artist: {
    eyebrow: 'You have access',
    lead: (account) => `${esc(account)} added you to local / assets. Every set you play there is recorded and turned into clips and thumbnails with your name on them, ready to post.`,
    can: (account) => [
      ['See your sets', `Every set you play at ${esc(account)}, kept in Distribution History.`],
      ['Watch and download', 'The full recording, the HQ audio, your vertical clips and thumbnails, in full quality.'],
      ['Your calendar', `Your upcoming sets at ${esc(account)}.`],
      ['Your Brand Kit', 'Keep your logo, photos and links up to date. They go on your clips and thumbnails.'],
    ],
    cant: (account) => [
      `Recording, cameras and Camera Control`,
      `Watermarking, cutting or deleting clips`,
      `Uploading, and sending sets to YouTube or SoundCloud`,
      `Other artists' sets, the account's billing and settings`,
    ],
    cantTitle: (account) => `Done by ${esc(account)}`,
  },
  team: {
    eyebrow: 'You have access',
    lead: (account) => `You've been added to ${esc(account)} on local / assets. Every set filmed there becomes a full recording, branded vertical clips and thumbnails, kept in one place and ready to post.`,
    can: () => [
      ['Distribution History', 'Every set: watch, download, watermark, and send to YouTube and SoundCloud.'],
      ['Camera Control', 'Connect cameras and the mixer, see them live, and record with the calendar.'],
      ['Calendar', 'Connect the calendar once: the cameras start and stop with each set.'],
      ['Brand Kit and watermark', 'Logos, fonts and photos for the account and each artist, and the watermark on every clip.'],
      ['Artists, contacts and uploads', 'Give artists access to their own sets, keep the contacts up to date, and upload sets.'],
    ],
    cant: () => [
      'Adding or removing people from the account: write to info@local-assets.com',
      'Closing or deleting the account, which only local / assets can do',
    ],
    cantTitle: () => 'Done by local / assets',
  },
};
export function accessInviteEmail({ artist, account, email, example, kind = 'artist' }) {
  const K = ACCESS[kind] || ACCESS.artist;
  const title = kind === 'team' ? account : artist;
  const steps = [['Sign in', `With Google, using ${esc(email)}. There is no password to remember.`]].concat(K.can(account));
  const cant = K.cant(account);
  const preheader = kind === 'team' ? `You've been added to ${account} on local / assets. Sign in with Google to start.` : `${account} gave you access to your sets on local / assets. Sign in with Google to see them.`;
  const app = (eyebrow, ttl, line, cta) => `<td class="e-col" valign="top" width="50%" style="padding:18px 20px;border:1px solid ${L.line};border-radius:14px" class="e-line">
          <p style="margin:0 0 8px;font:500 10px/1 ${MONO};letter-spacing:.24em;text-transform:uppercase;color:${L.dim}" class="e-d">${eyebrow}</p>
          <p style="margin:0;font:700 15px/1.3 ${FONT};letter-spacing:.02em;text-transform:uppercase;color:${L.text}" class="e-t">${ttl}</p>
          <p style="margin:6px 0 14px;font:400 13px/1.5 ${FONT};color:${L.sub}" class="e-s">${line}</p>${cta}</td>`;

  const html = `${head('You have access to local / assets')}
<body class="e-bg" style="margin:0;padding:0;background:${L.bg};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${L.bg}">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="e-bg" style="background:${L.bg}">
<tr><td align="center" style="padding:48px 16px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px">
    <tr><td style="padding:0 4px 40px">${wordmark}</td></tr>
    <tr><td style="padding:0 4px">
      <p style="margin:0 0 14px;font:500 11px/1 ${MONO};letter-spacing:.3em;text-transform:uppercase;color:${ORANGE}" class="e-acc">${K.eyebrow}</p>
      <h1 style="margin:0;font:700 40px/1 ${FONT};letter-spacing:-.01em;text-transform:uppercase;color:${L.text}" class="e-t">${esc(title)}</h1>
      <p style="margin:20px 0 0;font:400 16px/1.6 ${FONT};color:${L.sub}" class="e-s">${K.lead(account)}</p>
    </td></tr>
    <tr><td style="padding:32px 4px 0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="e-line" style="border:1px solid ${L.line};border-radius:14px">
        <tr><td style="padding:18px 22px">
          <p style="margin:0 0 6px;font:500 10px/1 ${MONO};letter-spacing:.24em;text-transform:uppercase;color:${L.dim}" class="e-d">${kind === 'team' ? 'Access' : 'Account'}</p>
          <p style="margin:0;font:600 16px/1.3 ${FONT};color:${L.text}" class="e-t">${kind === 'team' ? 'The whole account' : esc(account)}</p>
        </td></tr>
        <tr><td class="e-line" style="padding:18px 22px;border-top:1px solid ${L.line}">
          <p style="margin:0 0 6px;font:500 10px/1 ${MONO};letter-spacing:.24em;text-transform:uppercase;color:${L.dim}" class="e-d">Sign in with</p>
          <p style="margin:0;font:600 16px/1.3 ${FONT};color:${L.text};word-break:break-word" class="e-t">${esc(email)}</p>
        </td></tr>
      </table>
    </td></tr>
    <tr><td style="padding:28px 4px 0">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${button(`${SITE}/login.html`, `Sign in to your workspace`)}</tr></table>
    </td></tr>
    <tr><td style="padding:40px 4px 8px"><p style="margin:0;font:500 10px/1 ${MONO};letter-spacing:.24em;text-transform:uppercase;color:${L.dim}" class="e-d">What you can do</p></td></tr>
    ${steps.map(([t, d], i) => `<tr><td style="padding:0 4px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="e-line2" style="border-top:1px solid ${L.line2}"><tr>
        <td width="44" valign="top" style="padding:18px 0;font:500 11px/1.5 ${MONO};letter-spacing:.1em;color:${ORANGE}" class="e-acc">0${i + 1}</td>
        <td valign="top" style="padding:16px 0"><p style="margin:0;font:600 15px/1.4 ${FONT};color:${L.text}" class="e-t">${t}</p><p style="margin:4px 0 0;font:400 14px/1.55 ${FONT};color:${L.sub}" class="e-s">${d}</p></td>
      </tr></table></td></tr>`).join('')}
    <tr><td style="padding:28px 4px 0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="e-line" style="border:1px dashed ${L.line};border-radius:14px"><tr><td style="padding:18px 22px">
        <p style="margin:0 0 10px;font:500 10px/1 ${MONO};letter-spacing:.24em;text-transform:uppercase;color:${L.dim}" class="e-d">${K.cantTitle(account)}</p>
        ${cant.map(c => `<p style="margin:6px 0 0;font:400 14px/1.5 ${FONT};color:${L.sub}" class="e-s"><span class="e-f" style="color:${L.foot}">&#8212;&nbsp;</span>${c}</p>`).join('')}
      </td></tr></table>
    </td></tr>
    <tr><td style="padding:36px 4px 12px"><p style="margin:0;font:500 10px/1 ${MONO};letter-spacing:.24em;text-transform:uppercase;color:${L.dim}" class="e-d">Get the app</p></td></tr>
    <tr><td style="padding:0 4px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;border-spacing:0"><tr>
        ${app('macOS', 'a™ for Mac', kind === 'team' ? 'Camera Control, uploads and recording from a camera plugged into the Mac.' : 'Your sets, clips and Brand Kit on your Mac.', `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td class="e-ol" style="border-radius:999px;border:1px solid ${L.outline}"><a class="e-t" href="${SITE}/download" style="display:inline-block;padding:11px 20px;font:600 13px/1 ${FONT};color:${L.text};text-decoration:none;border-radius:999px">Download for Mac</a></td></tr></table>`)}
        <td class="e-gap" width="12" style="width:12px;min-width:12px;font-size:0;line-height:0;border:0">&nbsp;</td>
        ${app('iPhone &amp; iPad', 'Mobile app', 'Your sets and clips on the go.', `<p style="margin:0;display:inline-block;padding:9px 14px;border:1px dashed ${L.outline};border-radius:999px;font:500 10px/1 ${MONO};letter-spacing:.18em;text-transform:uppercase;color:${L.dim}" class="e-d">Coming soon</p>`)}
      </tr></table>
    </td></tr>
    <tr><td style="padding:14px 4px 0"><p style="margin:0;font:400 13px/1.6 ${FONT};color:${L.dim}" class="e-d">Until then, local-assets.com works in your phone's browser: sign in and add it to your home screen.</p></td></tr>
    <tr><td style="padding:36px 4px 0">
      <p style="margin:0;font:400 13px/1.6 ${FONT};color:${L.dim}" class="e-d">Questions? Reply to this email or write to <a href="mailto:info@local-assets.com" style="color:${L.link};text-decoration:underline" class="e-link">info@local-assets.com</a>.</p>
    </td></tr>
    ${footer}
  </table>
</td></tr>
</table>
</body></html>`;

  const plain = v => String(v).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&[a-z]+;|&#\d+;/g, ' ');
  const text = [
    kind === 'team' ? `You've been added to ${account} on local / assets.` : `You have access to local / assets, ${artist}.`, '',
    plain(K.lead(account)), '',
    `Sign in with: ${email}`, '',
    'What you can do:',
    ...steps.map(([t, d], i) => `0${i + 1}  ${t}: ${plain(d)}`), '',
    plain(K.cantTitle(account)) + ':',
    ...cant.map(c => '- ' + plain(c)), '',
    `Sign in: ${SITE}/login.html`,
    `Download a™ for Mac: ${SITE}/download`,
    'iPhone and iPad app: coming soon (local-assets.com works in your phone\'s browser).', '',
    'Questions? Reply to this email or write to info@local-assets.com.',
  ].join('\n');
  return { subject: `${example ? '[Example] ' : ''}You have access to local / assets: ${account}`, html, text };
}
