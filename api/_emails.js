// Transactional emails, in the local / assets style: near-black, Helvetica, the green wordmark.
// Table layout with inline styles, so it reads the same in Gmail, Apple Mail and Outlook.

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SITE = 'https://local-assets.com';
const FONT = "'Helvetica Neue', Helvetica, Arial, sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace";
const GREEN = '#85FA4F';
// The sender: local-assets.com, the domain verified in Resend. (RESEND_EMAIL_DOMAIN from the Vercel integration
// isn't used: Resend took the emails sent from it, then failed every one as "domain is not verified".)
export const SEND_DOMAIN = 'local-assets.com';
export const mailFrom = (box = 'noreply', name = 'local / assets') => `${name} <${box}@${SEND_DOMAIN}>`;

// Welcome email after a sign-up. plan: { name, line } where line says what was paid and what's next.
export function welcomeEmail({ name, email, type, plan, ready }) {
  const who = type === 'label' ? 'record label' : type === 'artist' ? 'artist' : 'venue';
  const steps = [
    ['Sign in', `Use Google with ${esc(email)}. There is no password to remember.`],
    ['Set up your Brand Kit', 'Add your logo and fonts. Your watermark goes on every clip and thumbnail.'],
    ['Connect a camera', 'In Camera Control, add a phone, OBS or an OBSBOT. Scan the QR code and press record.'],
    ['Get a™ for Mac', `The app for your Mac: Camera Control, uploads, and recording from a camera plugged into it. <a href="${SITE}/download" style="color:#fafafa;text-decoration:underline">Download it here</a> (sign in first).`],
    ['Film your first set', ready
      ? 'Each set lands in Distribution History, with vertical clips ready to post.'
      : 'We’re preparing your private video storage and will email you the moment recordings can be saved.'],
  ];
  const preheader = `Your ${who} account is ${ready ? 'ready' : 'set up'}. Sign in with Google to get started.`;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"><title>Welcome to local / assets</title></head>
<body style="margin:0;padding:0;background:#070905;-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#070905">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#070905">
<tr><td align="center" style="padding:48px 16px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px">
    <tr><td style="padding:0 4px 40px"><img src="${SITE}/logos/Green@2x.png" width="150" alt="local / assets" style="display:block;width:150px;height:auto;border:0"></td></tr>
    <tr><td style="padding:0 4px">
      <p style="margin:0 0 14px;font:500 11px/1 ${MONO};letter-spacing:.3em;text-transform:uppercase;color:${GREEN}">Welcome</p>
      <h1 style="margin:0;font:700 40px/1 ${FONT};letter-spacing:-.01em;text-transform:uppercase;color:#fafafa">${esc(name)}</h1>
      <p style="margin:20px 0 0;font:400 16px/1.6 ${FONT};color:#a1a1aa">Your ${who} account on local / assets is ${ready ? 'ready' : 'set up'}. Every set you film becomes a full-length recording, branded vertical clips and thumbnails, kept in one place and ready to post.</p>
    </td></tr>
    <tr><td style="padding:32px 4px 0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #23261f;border-radius:14px">
        <tr><td style="padding:18px 22px">
          <p style="margin:0 0 6px;font:500 10px/1 ${MONO};letter-spacing:.24em;text-transform:uppercase;color:#71717a">Your plan</p>
          <p style="margin:0;font:600 17px/1.3 ${FONT};color:#fafafa">${esc(plan.name)}</p>
          ${plan.line ? `<p style="margin:6px 0 0;font:400 14px/1.5 ${FONT};color:#a1a1aa">${esc(plan.line)}</p>` : ''}
        </td></tr>
      </table>
    </td></tr>
    <tr><td style="padding:36px 4px 8px"><p style="margin:0;font:500 10px/1 ${MONO};letter-spacing:.24em;text-transform:uppercase;color:#71717a">Getting started</p></td></tr>
    ${steps.map(([t, d], i) => `<tr><td style="padding:0 4px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #1b1e18"><tr>
        <td width="44" valign="top" style="padding:18px 0;font:500 11px/1.5 ${MONO};letter-spacing:.1em;color:${GREEN}">0${i + 1}</td>
        <td valign="top" style="padding:16px 0"><p style="margin:0;font:600 15px/1.4 ${FONT};color:#fafafa">${t}</p><p style="margin:4px 0 0;font:400 14px/1.55 ${FONT};color:#a1a1aa">${d}</p></td>
      </tr></table></td></tr>`).join('')}
    <tr><td style="padding:28px 4px 0">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-radius:999px;background:${GREEN}">
        <a href="${SITE}/login.html" style="display:inline-block;padding:15px 34px;font:600 14px/1 ${FONT};color:#000;text-decoration:none;border-radius:999px">Sign in to your workspace</a>
      </td><td width="12"></td><td style="border-radius:999px;border:1px solid #3f3f46">
        <a href="${SITE}/download" style="display:inline-block;padding:14px 28px;font:600 14px/1 ${FONT};color:#fafafa;text-decoration:none;border-radius:999px">Download a™ for Mac</a>
      </td></tr></table>
    </td></tr>
    <tr><td style="padding:44px 4px 0">
      <p style="margin:0;font:400 13px/1.6 ${FONT};color:#71717a">Questions? Reply to this email or write to <a href="mailto:info@local-assets.com" style="color:#d4d4d8;text-decoration:underline">info@local-assets.com</a>. Invoices and your card are under Billing once you sign in.</p>
    </td></tr>
    <tr><td style="padding:40px 4px 0;border-bottom:0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #1b1e18"><tr>
        <td style="padding:20px 0 0;font:500 10px/1.6 ${MONO};letter-spacing:.2em;text-transform:uppercase;color:#52525b">local / assets&trade; &middot; London</td>
        <td align="right" style="padding:20px 0 0"><img src="${SITE}/logos/a-white.png" width="18" alt="" style="display:inline-block;width:18px;height:auto;border:0;opacity:.7"></td>
      </tr></table>
    </td></tr>
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
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"><title>Your local / assets invoice</title></head>
<body style="margin:0;padding:0;background:#070905;-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#070905">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#070905">
<tr><td align="center" style="padding:48px 16px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px">
    <tr><td style="padding:0 4px 40px"><img src="${SITE}/logos/Green@2x.png" width="150" alt="local / assets" style="display:block;width:150px;height:auto;border:0"></td></tr>
    ${example ? `<tr><td style="padding:0 4px 20px"><p style="margin:0;padding:10px 14px;border:1px dashed #3f3f46;border-radius:10px;font:400 13px/1.5 ${FONT};color:#a1a1aa">Example only: this is what ${esc(name)} receives on the 1st. Nothing was charged.</p></td></tr>` : ''}
    <tr><td style="padding:0 4px">
      <p style="margin:0 0 14px;font:500 11px/1 ${MONO};letter-spacing:.3em;text-transform:uppercase;color:${GREEN}">Invoice · ${esc(period)}</p>
      <h1 style="margin:0;font:700 48px/1 ${FONT};letter-spacing:-.01em;color:#fafafa">${money(total)}</h1>
      <p style="margin:16px 0 0;font:400 16px/1.6 ${FONT};color:#a1a1aa">${esc(name)}: your local / assets plan and usage for ${esc(period)}. ${status}</p>
    </td></tr>
    <tr><td style="padding:32px 4px 0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #23261f;border-radius:14px">
        ${rows.map(([t, d, a], i) => `<tr><td style="padding:16px 22px;${i ? 'border-top:1px solid #1b1e18;' : ''}"><p style="margin:0;font:600 15px/1.4 ${FONT};color:#fafafa">${esc(t)}</p><p style="margin:3px 0 0;font:400 13px/1.5 ${FONT};color:#71717a">${esc(d)}</p></td>
          <td align="right" valign="top" style="padding:16px 22px;${i ? 'border-top:1px solid #1b1e18;' : ''}font:600 15px/1.4 ${FONT};color:#fafafa;white-space:nowrap">${money(a)}</td></tr>`).join('')}
        <tr><td style="padding:16px 22px;border-top:1px solid #23261f;font:600 15px/1.4 ${FONT};color:#fafafa">Total</td><td align="right" style="padding:16px 22px;border-top:1px solid #23261f;font:700 17px/1.4 ${FONT};color:${GREEN};white-space:nowrap">${money(total)}</td></tr>
      </table>
    </td></tr>
    <tr><td style="padding:28px 4px 0">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-radius:999px;background:${GREEN}">
        <a href="${esc(url || SITE + '/billing')}" style="display:inline-block;padding:15px 34px;font:600 14px/1 ${FONT};color:#000;text-decoration:none;border-radius:999px">${charged ? 'View the invoice' : 'View and pay the invoice'}</a>
      </td><td width="12"></td><td style="border-radius:999px;border:1px solid #3f3f46">
        <a href="${SITE}/billing" style="display:inline-block;padding:14px 28px;font:600 14px/1 ${FONT};color:#fafafa;text-decoration:none;border-radius:999px">Your billing</a>
      </td></tr></table>
    </td></tr>
    <tr><td style="padding:44px 4px 0">
      <p style="margin:0;font:400 13px/1.6 ${FONT};color:#71717a">Every invoice is also in your account under Billing, with its PDF. Questions? Reply to this email or write to <a href="mailto:info@local-assets.com" style="color:#d4d4d8;text-decoration:underline">info@local-assets.com</a>.</p>
    </td></tr>
    <tr><td style="padding:40px 4px 0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #1b1e18"><tr>
        <td style="padding:20px 0 0;font:500 10px/1.6 ${MONO};letter-spacing:.2em;text-transform:uppercase;color:#52525b">local / assets&trade; &middot; London</td>
        <td align="right" style="padding:20px 0 0"><img src="${SITE}/logos/a-white.png" width="18" alt="" style="display:inline-block;width:18px;height:auto;border:0;opacity:.7"></td>
      </tr></table>
    </td></tr>
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
  const app = (eyebrow, ttl, line, cta) => `<td valign="top" width="50%" style="padding:18px 20px;border:1px solid #23261f;border-radius:14px">
          <p style="margin:0 0 8px;font:500 10px/1 ${MONO};letter-spacing:.24em;text-transform:uppercase;color:#71717a">${eyebrow}</p>
          <p style="margin:0;font:700 15px/1.3 ${FONT};letter-spacing:.02em;text-transform:uppercase;color:#fafafa">${ttl}</p>
          <p style="margin:6px 0 14px;font:400 13px/1.5 ${FONT};color:#a1a1aa">${line}</p>${cta}</td>`;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"><title>You have access to local / assets</title></head>
<body style="margin:0;padding:0;background:#070905;-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#070905">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#070905">
<tr><td align="center" style="padding:48px 16px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px">
    <tr><td style="padding:0 4px 40px"><img src="${SITE}/logos/Green@2x.png" width="150" alt="local / assets" style="display:block;width:150px;height:auto;border:0"></td></tr>
    <tr><td style="padding:0 4px">
      <p style="margin:0 0 14px;font:500 11px/1 ${MONO};letter-spacing:.3em;text-transform:uppercase;color:${GREEN}">${K.eyebrow}</p>
      <h1 style="margin:0;font:700 40px/1 ${FONT};letter-spacing:-.01em;text-transform:uppercase;color:#fafafa">${esc(title)}</h1>
      <p style="margin:20px 0 0;font:400 16px/1.6 ${FONT};color:#a1a1aa">${K.lead(account)}</p>
    </td></tr>
    <tr><td style="padding:32px 4px 0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #23261f;border-radius:14px">
        <tr><td style="padding:18px 22px" width="50%">
          <p style="margin:0 0 6px;font:500 10px/1 ${MONO};letter-spacing:.24em;text-transform:uppercase;color:#71717a">${kind === 'team' ? 'Access' : 'Account'}</p>
          <p style="margin:0;font:600 16px/1.3 ${FONT};color:#fafafa">${kind === 'team' ? 'The whole account' : esc(account)}</p>
        </td><td style="padding:18px 22px;border-left:1px solid #23261f">
          <p style="margin:0 0 6px;font:500 10px/1 ${MONO};letter-spacing:.24em;text-transform:uppercase;color:#71717a">Sign in with</p>
          <p style="margin:0;font:600 16px/1.3 ${FONT};color:#fafafa;word-break:break-all">${esc(email)}</p>
        </td></tr>
      </table>
    </td></tr>
    <tr><td style="padding:28px 4px 0">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-radius:999px;background:${GREEN}">
        <a href="${SITE}/login.html" style="display:inline-block;padding:15px 34px;font:600 14px/1 ${FONT};color:#000;text-decoration:none;border-radius:999px">Sign in to your workspace</a>
      </td></tr></table>
    </td></tr>
    <tr><td style="padding:40px 4px 8px"><p style="margin:0;font:500 10px/1 ${MONO};letter-spacing:.24em;text-transform:uppercase;color:#71717a">What you can do</p></td></tr>
    ${steps.map(([t, d], i) => `<tr><td style="padding:0 4px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #1b1e18"><tr>
        <td width="44" valign="top" style="padding:18px 0;font:500 11px/1.5 ${MONO};letter-spacing:.1em;color:${GREEN}">0${i + 1}</td>
        <td valign="top" style="padding:16px 0"><p style="margin:0;font:600 15px/1.4 ${FONT};color:#fafafa">${t}</p><p style="margin:4px 0 0;font:400 14px/1.55 ${FONT};color:#a1a1aa">${d}</p></td>
      </tr></table></td></tr>`).join('')}
    <tr><td style="padding:28px 4px 0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px dashed #2a2d26;border-radius:14px"><tr><td style="padding:18px 22px">
        <p style="margin:0 0 10px;font:500 10px/1 ${MONO};letter-spacing:.24em;text-transform:uppercase;color:#71717a">${K.cantTitle(account)}</p>
        ${cant.map(c => `<p style="margin:6px 0 0;font:400 14px/1.5 ${FONT};color:#a1a1aa"><span style="color:#52525b">&#8212;&nbsp;</span>${c}</p>`).join('')}
      </td></tr></table>
    </td></tr>
    <tr><td style="padding:36px 4px 12px"><p style="margin:0;font:500 10px/1 ${MONO};letter-spacing:.24em;text-transform:uppercase;color:#71717a">Get the app</p></td></tr>
    <tr><td style="padding:0 4px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;border-spacing:0"><tr>
        ${app('macOS', 'a™ for Mac', kind === 'team' ? 'Camera Control, uploads and recording from a camera plugged into the Mac.' : 'Your sets, clips and Brand Kit on your Mac.', `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-radius:999px;border:1px solid #3f3f46"><a href="${SITE}/download" style="display:inline-block;padding:11px 20px;font:600 13px/1 ${FONT};color:#fafafa;text-decoration:none;border-radius:999px">Download for Mac</a></td></tr></table>`)}
        <td width="12" style="width:12px;min-width:12px;font-size:0;line-height:0;border:0">&nbsp;</td>
        ${app('iPhone &amp; iPad', 'Mobile app', 'Your sets and clips on the go.', `<p style="margin:0;display:inline-block;padding:9px 14px;border:1px dashed #3f3f46;border-radius:999px;font:500 10px/1 ${MONO};letter-spacing:.18em;text-transform:uppercase;color:#71717a">Coming soon</p>`)}
      </tr></table>
    </td></tr>
    <tr><td style="padding:14px 4px 0"><p style="margin:0;font:400 13px/1.6 ${FONT};color:#71717a">Until then, local-assets.com works in your phone's browser: sign in and add it to your home screen.</p></td></tr>
    <tr><td style="padding:36px 4px 0">
      <p style="margin:0;font:400 13px/1.6 ${FONT};color:#71717a">Questions? Reply to this email or write to <a href="mailto:info@local-assets.com" style="color:#d4d4d8;text-decoration:underline">info@local-assets.com</a>.</p>
    </td></tr>
    <tr><td style="padding:40px 4px 0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #1b1e18"><tr>
        <td style="padding:20px 0 0;font:500 10px/1.6 ${MONO};letter-spacing:.2em;text-transform:uppercase;color:#52525b">local / assets&trade; &middot; London</td>
        <td align="right" style="padding:20px 0 0"><img src="${SITE}/logos/a-white.png" width="18" alt="" style="display:inline-block;width:18px;height:auto;border:0;opacity:.7"></td>
      </tr></table>
    </td></tr>
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
