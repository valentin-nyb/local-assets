// Transactional emails, in the local / assets style: near-black, Helvetica, the green wordmark.
// Table layout with inline styles, so it reads the same in Gmail, Apple Mail and Outlook.

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SITE = 'https://local-assets.com';
const FONT = "'Helvetica Neue', Helvetica, Arial, sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace";
const GREEN = '#85FA4F';

// Welcome email after a sign-up. plan: { name, line } where line says what was paid and what's next.
export function welcomeEmail({ name, email, type, plan, ready }) {
  const who = type === 'label' ? 'record label' : type === 'artist' ? 'artist' : 'venue';
  const steps = [
    ['Sign in', `Use Google with ${esc(email)}. There is no password to remember.`],
    ['Set up your Brand Kit', 'Add your logo and fonts. Your watermark goes on every clip and thumbnail.'],
    ['Connect a camera', 'In Camera Control, add a phone, OBS or an OBSBOT. Scan the QR code and press record.'],
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
    ...steps.map(([t, d], i) => `0${i + 1}  ${t}: ${d.replace(/&[a-z]+;|&#\d+;/g, ' ')}`), '',
    `Sign in: ${SITE}/login.html`, '',
    'Questions? Reply to this email or write to info@local-assets.com.',
  ].join('\n');

  return { subject: `Welcome to local / assets, ${name}`, html, text };
}
