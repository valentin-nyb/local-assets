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
  .lad-toast.show{opacity:1;transform:translate(-50%,0)}
  .las-bar{position:fixed;left:50%;bottom:calc(env(safe-area-inset-bottom) + 20px);z-index:2147482000;transform:translate(-50%,24px);opacity:0;pointer-events:none;
    display:flex;align-items:center;gap:10px;min-height:48px;max-width:calc(100vw - 32px);padding:6px 6px 6px 16px;border-radius:999px;
    background:color-mix(in srgb,var(--la-raised,#0c0c0d) 94%,transparent);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);
    color:var(--la-text,#fafafa);border:1px solid var(--la-line,#27272a);box-shadow:var(--la-shadow,0 24px 80px rgba(0,0,0,.55));
    font:500 13px "Helvetica Neue",Helvetica,Arial,sans-serif;transition:opacity .2s,transform .25s cubic-bezier(.2,.9,.3,1.2)}
  .las-bar.show{opacity:1;transform:translate(-50%,0);pointer-events:auto}
  .las-bar.done{padding-right:16px}
  .las-st{display:flex;align-items:center;gap:8px;white-space:nowrap;min-width:0}
  .las-st span{overflow:hidden;text-overflow:ellipsis}
  .las-ic{flex-shrink:0;display:flex;width:20px;height:20px;align-items:center;justify-content:center;color:var(--la-sub,#a1a1aa)}
  .las-bar.bad .las-ic{color:var(--la-bad,#ef4444)}
  .las-ok{border-radius:999px;background:color-mix(in srgb,var(--la-accent,#39FF14) 16%,transparent);border:1px solid color-mix(in srgb,var(--la-accent,#39FF14) 35%,transparent);color:var(--la-accent,#39FF14)}
  .las-spin{width:16px;height:16px;border-radius:999px;border:2px solid color-mix(in srgb,var(--la-text,#fafafa) 20%,transparent);border-top-color:var(--la-accent,#39FF14);animation:las-spin .7s linear infinite}
  @keyframes las-spin{to{transform:rotate(360deg)}}
  .las-go{display:flex;gap:6px;margin-left:6px;flex-shrink:0}
  .las-bar:not(.ask) .las-go{display:none}
  :root body .las-bar .lad-btn{height:36px;min-height:36px;padding:0 18px;font-size:13px}
  @media (max-width:480px){.las-bar{left:16px;right:16px;max-width:none;transform:translateY(24px)}.las-bar.show{transform:none}.las-st{flex:1}}`;
  var st = document.createElement('style'); st.textContent = css;
  (document.head || document.documentElement).appendChild(st);


  function open(opts) {
    return new Promise(function (resolve) {
      var m = document.createElement('div');
      m.className = 'lad-backdrop';
      var tone = opts.tone || 'info';
      m.innerHTML = '<div class="lad-panel" role="' + (opts.cancel ? 'alertdialog' : 'dialog') + '" aria-modal="true">' +
        '<div class="lad-head">' +
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
    t.innerHTML = '<span></span>';
    t.querySelector('span').textContent = text;
    t.classList.add('show');
    clearTimeout(t._h); t._h = setTimeout(function () { t.classList.remove('show'); }, 2600);
  };

  // The save bar: "Unsaved changes · Reset · Save" at the bottom of the screen while a page has changes that
  // are not saved yet; then "Saving" and "Changes saved". One at a time, for the whole site.
  //   laSaveBar.dirty({ onSave: () => Promise, onReset: () => void, text })   shows it (again) for these changes
  //   laSaveBar.clean()   hides it (the changes were saved some other way, or undone)
  //   laSaveBar.watch(root, { button, onReset, failed, clicks })   any edit inside root (or a click on clicks) shows it; Save presses that
  //     page's own save button (hidden) and waits for it to finish; failed() says whether it went wrong
  (function () {
    var bar, cur = null, hideT, saving = false;
    var INFO = '<svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="9" cy="9" r="7.25"/><path d="M9 12.8V8.3"/><circle cx="9" cy="5.75" r=".9" fill="currentColor" stroke="none"/></svg>';
    var CHECK = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
    function el() {
      if (bar) return bar;
      bar = document.createElement('div'); bar.className = 'las-bar'; bar.setAttribute('role', 'status'); bar.setAttribute('aria-live', 'polite');
      bar.innerHTML = '<div class="las-st"><i class="las-ic"></i><span></span></div><div class="las-go"><button type="button" class="lad-btn ghost" data-r>Reset</button><button type="button" class="lad-btn primary" data-s>Save</button></div>';
      bar.querySelector('[data-r]').onclick = reset;
      bar.querySelector('[data-s]').onclick = save;
      document.body.appendChild(bar);
      return bar;
    }
    function paint(state, text) {
      var b = el(); clearTimeout(hideT);
      b.className = 'las-bar show' + (state === 'ask' || state === 'bad' ? ' ask' : ' done') + (state === 'bad' ? ' bad' : '');
      var ic = b.querySelector('.las-ic');
      ic.className = 'las-ic' + (state === 'ok' ? ' las-ok' : '');
      ic.innerHTML = state === 'saving' ? '<i class="las-spin"></i>' : state === 'ok' ? CHECK : INFO;
      b.querySelector('.las-st span').textContent = text;
    }
    function hide() { if (bar) bar.classList.remove('show'); }
    function save() {
      var o = cur; if (!o || saving) return;
      saving = true; paint('saving', 'Saving');
      Promise.resolve().then(function () { return o.onSave(); }).then(function () {
        saving = false;
        if (cur !== o) return paint('ask', cur ? cur.text || 'Unsaved changes' : '');   // changed again while saving
        cur = null; paint('ok', 'Changes saved');
        hideT = setTimeout(hide, 2000);
      }, function (e) {
        saving = false;
        var m = String(e && e.message || '').replace(/\.$/, '');
        paint('bad', /^could not/i.test(m) ? m + '. Try again.' : 'Could not save' + (m ? ': ' + m : '') + '. Try again.');
      });
    }
    function reset() { var o = cur; if (!o || saving) return; cur = null; hide(); if (o.onReset) o.onReset(); }
    window.laSaveBar = {
      dirty: function (o) { cur = o; if (!saving) paint('ask', o.text || 'Unsaved changes'); },
      clean: function () { if (saving) return; cur = null; hide(); },
      isDirty: function () { return !!cur; },
      watch: function (root, w) {
        if (!root) return;
        if (w.button) w.button.style.display = 'none';
        var o = { onReset: w.onReset, text: w.text, onSave: function () {
          return new Promise(function (ok, bad) {
            var btn = w.button;
            var mo = new MutationObserver(function () { if (!btn.disabled) { mo.disconnect(); var f = w.failed && w.failed(); f ? bad(new Error(typeof f === 'string' ? f : '')) : ok(); } });
            mo.observe(btn, { attributes: true, attributeFilter: ['disabled'] });
            btn.click();
            if (!btn.disabled) { mo.disconnect(); var f = w.failed && w.failed(); f ? bad(new Error(typeof f === 'string' ? f : '')) : ok(); }   // nothing to save
          });
        } };
        var mark = function (e) { if (e.isTrusted) window.laSaveBar.dirty(o); };
        root.addEventListener('input', mark);
        root.addEventListener('change', mark);
        var clicks = '[data-dirty]' + (w.clicks ? ',' + w.clicks : '');
        root.addEventListener('click', function (e) { if (e.isTrusted && e.target.closest(clicks)) window.laSaveBar.dirty(o); });
        return o;
      }
    };
    // Leaving the page with changes not saved asks first; Cmd/Ctrl+S saves them
    window.addEventListener('beforeunload', function (e) { if (cur) { e.preventDefault(); e.returnValue = ''; } });
    document.addEventListener('keydown', function (e) { if (cur && (e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); save(); } });
  })();

  // Every remaining alert() on the site shows the styled dialog instead of the browser's.
  window.alert = function (m) { window.laAlert(m); };
})();
