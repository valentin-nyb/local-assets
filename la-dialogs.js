// Shared dialogs for local / assets: styled replacements for the browser's
// alert() / confirm(), plus a small toast. Colours come from the --la-* theme tokens.
(function () {
  if (window.laConfirm) return;

  var css = `
  .lad-backdrop{position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;justify-content:center;padding:16px;
    background:var(--la-overlay,rgba(0,0,0,.6));-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);opacity:0;transition:opacity .15s}
  .lad-backdrop.in{opacity:1}
  .lad-panel{width:400px;max-width:100%;background:var(--la-raised,#0c0c0d);color:var(--la-text,#fafafa);border:1px solid var(--la-line,#27272a);
    border-radius:16px;padding:24px;box-shadow:var(--la-shadow,0 24px 80px rgba(0,0,0,.55));font-family:Inter,ui-sans-serif,system-ui,sans-serif;
    transform:translateY(6px) scale(.98);transition:transform .15s}
  .lad-backdrop.in .lad-panel{transform:none}
  .lad-head{display:flex;flex-direction:column;align-items:flex-start}
  .lad-icon{width:44px;height:44px;border-radius:999px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:20px;margin-bottom:16px;
    background:var(--la-chip,#18181b);color:var(--la-sub,#a1a1aa)}
  .lad-icon.danger,.lad-icon.error{background:color-mix(in srgb,var(--la-bad,#ef4444) 14%,transparent);color:var(--la-bad,#ef4444)}
  .lad-icon.ok{background:color-mix(in srgb,var(--la-ok,#39FF14) 14%,transparent);color:var(--la-ok,#39FF14)}
  .lad-title{font-size:18px;font-weight:600;line-height:1.3;letter-spacing:-.01em;margin:0}
  .lad-msg{font-size:13px;line-height:1.6;color:var(--la-sub,#a1a1aa);margin-top:10px;white-space:pre-line;word-break:break-word}
  .lad-actions{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:10px;margin-top:22px}
  .lad-btn{height:40px;padding:0 16px;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer;border:1px solid transparent;font-family:inherit}
  .lad-btn.ghost{background:none;color:var(--la-text,#fafafa);border-color:var(--la-line,#27272a)}
  .lad-btn.primary{background:var(--la-accent,#39FF14);color:var(--la-accent-ink,#000)}
  .lad-btn.danger{background:var(--la-bad,#ef4444);color:#fff}
  .lad-btn:focus-visible{outline:2px solid var(--la-accent,#39FF14);outline-offset:2px}
  @media (hover:hover){.lad-btn.ghost:hover{background:var(--la-chip,#18181b)}.lad-btn.primary:hover,.lad-btn.danger:hover{filter:brightness(1.08)}}
  .lad-toast{position:fixed;left:50%;bottom:calc(env(safe-area-inset-bottom) + 24px);transform:translate(-50%,20px);opacity:0;pointer-events:none;
    z-index:2147483601;display:flex;align-items:center;gap:8px;padding:10px 16px;border-radius:999px;background:var(--la-raised,#0c0c0d);
    color:var(--la-text,#fafafa);border:1px solid var(--la-line,#27272a);box-shadow:var(--la-shadow,0 24px 80px rgba(0,0,0,.55));
    font:500 13px Inter,ui-sans-serif,system-ui,sans-serif;transition:opacity .2s,transform .2s}
  .lad-toast iconify-icon{color:var(--la-ok,#39FF14);font-size:16px}
  .lad-toast.show{opacity:1;transform:translate(-50%,0)}`;
  var st = document.createElement('style'); st.textContent = css;
  (document.head || document.documentElement).appendChild(st);

  var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var ICONS = { danger: 'solar:trash-bin-minimalistic-linear', error: 'solar:danger-triangle-linear', ok: 'solar:check-circle-linear', info: 'solar:info-circle-linear', question: 'solar:question-circle-linear' };

  function open(opts) {
    return new Promise(function (resolve) {
      var m = document.createElement('div');
      m.className = 'lad-backdrop';
      var tone = opts.tone || 'info';
      m.innerHTML = '<div class="lad-panel" role="' + (opts.cancel ? 'alertdialog' : 'dialog') + '" aria-modal="true">' +
        '<div class="lad-head"><div class="lad-icon ' + tone + '"><iconify-icon icon="' + (ICONS[tone] || ICONS.info) + '"></iconify-icon></div>' +
        '<div style="min-width:0;width:100%"><p class="lad-title"></p>' + (opts.message ? '<p class="lad-msg"></p>' : '') + '</div></div>' +
        '<div class="lad-actions">' + (opts.cancel ? '<button type="button" class="lad-btn ghost" data-v="0"></button>' : '') +
        '<button type="button" class="lad-btn ' + (tone === 'danger' ? 'danger' : 'primary') + '" data-v="1"></button></div></div>';
      m.querySelector('.lad-title').textContent = opts.title;
      if (opts.message) m.querySelector('.lad-msg').textContent = opts.message;
      if (opts.cancel) m.querySelector('[data-v="0"]').textContent = opts.cancel;
      m.querySelector('[data-v="1"]').textContent = opts.ok || 'OK';
      document.body.appendChild(m);
      requestAnimationFrame(function () { m.classList.add('in'); });
      var done = function (v) { document.removeEventListener('keydown', key); m.classList.remove('in'); setTimeout(function () { m.remove(); }, 150); resolve(v); };
      var key = function (e) { if (e.key === 'Escape') done(false); if (e.key === 'Enter') done(true); };
      document.addEventListener('keydown', key);
      m.addEventListener('click', function (e) { if (e.target === m) done(false); });
      m.querySelectorAll('[data-v]').forEach(function (b) { b.addEventListener('click', function () { done(b.dataset.v === '1'); }); });
      m.querySelector('[data-v="1"]').focus();
    });
  }

  // laConfirm({ title, message, confirmText, cancelText, danger }) → Promise<boolean>
  window.laConfirm = function (o) {
    o = typeof o === 'string' ? { title: o } : (o || {});
    return open({ title: o.title || 'Are you sure?', message: o.message, ok: o.confirmText || 'Confirm', cancel: o.cancelText || 'Cancel', tone: o.danger ? 'danger' : 'question' });
  };

  // laAlert(message, { title, tone }) → Promise. First line becomes the title when none is given.
  window.laAlert = function (message, o) {
    o = o || {};
    var text = String(message == null ? '' : message);
    var tone = o.tone || (/fail|error|could not|couldn't|not ready|did not|unable/i.test(text) ? 'error' : 'info');
    var title = o.title, body = text;
    if (!title) {
      var parts = text.split('\n'); title = parts.shift(); body = parts.join('\n').trim();
      // "YouTube upload failed: quota exceeded" → title + explanation
      var c = title.indexOf(': ');
      if (c > 0 && c < 60 && !body) { body = title.slice(c + 2); body = body.charAt(0).toUpperCase() + body.slice(1); title = title.slice(0, c); }
    }
    return open({ title: title, message: body, ok: 'OK', tone: tone });
  };

  window.laToast = function (text) {
    var t = document.getElementById('lad-toast');
    if (!t) { t = document.createElement('div'); t.id = 'lad-toast'; t.className = 'lad-toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.innerHTML = '<iconify-icon icon="solar:check-circle-bold"></iconify-icon><span></span>';
    t.querySelector('span').textContent = text;
    t.classList.add('show');
    clearTimeout(t._h); t._h = setTimeout(function () { t.classList.remove('show'); }, 2600);
  };

  // Every remaining alert() on the site shows the styled dialog instead of the browser's.
  window.alert = function (m) { window.laAlert(m); };
})();
