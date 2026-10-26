// Shared dialogs for local / assets: styled replacements for the browser's
// alert() / confirm(), plus a small toast. Colours come from the --la-* theme tokens.
(function () {
  if (window.laConfirm) return;

  var css = `
  .lad-backdrop{position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;justify-content:center;padding:16px;
    background:var(--la-overlay,rgba(0,0,0,.6));-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);opacity:0;transition:opacity .15s}
  .lad-backdrop.in{opacity:1}
  .lad-panel{width:440px;max-width:100%;background:var(--la-raised,#0c0c0d);color:var(--la-text,#fafafa);border:1px solid var(--la-line,#27272a);
    border-radius:28px;padding:30px 32px 32px;box-shadow:var(--la-shadow,0 24px 80px rgba(0,0,0,.55));font-family:Inter,ui-sans-serif,system-ui,sans-serif;
    transform:translateY(6px) scale(.98);transition:transform .15s}
  .lad-backdrop.in .lad-panel{transform:none}
  .lad-head{display:flex;flex-direction:column;align-items:flex-start}
  .lad-icon{width:44px;height:44px;border-radius:999px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:20px;margin-bottom:16px;
    background:var(--la-chip,#18181b);color:var(--la-sub,#a1a1aa)}
  .lad-icon.danger,.lad-icon.error{background:color-mix(in srgb,var(--la-bad,#ef4444) 14%,transparent);color:var(--la-bad,#ef4444)}
  .lad-icon.ok{background:color-mix(in srgb,var(--la-ok,#39FF14) 14%,transparent);color:var(--la-ok,#39FF14)}
  .lad-title{font-size:19px;font-weight:600;line-height:1.3;letter-spacing:-.01em;margin:0}
  .lad-msg{font-size:15px;line-height:1.55;color:var(--la-sub,#a1a1aa);margin-top:10px;white-space:pre-line;word-break:break-word}
  .lad-actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:24px}
  .lad-btn{display:inline-flex;align-items:center;justify-content:center;gap:10px;height:40px;padding:0 16px;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer;border:1px solid transparent;font-family:inherit}
  .lad-actions .lad-btn{height:48px;padding:0 18px;border-radius:14px;font-size:15px}
  .lad-actions .lad-btn:has(kbd){padding-right:8px}
  .lad-btn kbd{display:inline-flex;align-items:center;justify-content:center;min-width:30px;height:30px;padding:0 7px;border-radius:8px;font:500 13px Inter,ui-sans-serif,system-ui,sans-serif;background:color-mix(in srgb,currentColor 14%,transparent);color:inherit;opacity:.75}
  .lad-btn kbd + kbd{margin-left:-4px}
  /* Shortcut keys show only where there is a keyboard: the website on a computer and the Mac app */
  @media (hover:none),(pointer:coarse){.lad-btn kbd,.ladd-btn kbd{display:none}.lad-actions .lad-btn:has(kbd),.ladd-btn{padding-right:18px}}
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
  .ladd-panel{width:520px;max-width:100%;background:var(--la-raised,#0c0c0d);color:var(--la-text,#fafafa);border:1px solid var(--la-line,#27272a);
    border-radius:28px;padding:30px 32px 32px;box-shadow:var(--la-shadow,0 24px 80px rgba(0,0,0,.55));font-family:Inter,ui-sans-serif,system-ui,sans-serif;
    transform:translateY(6px) scale(.98);transition:transform .15s}
  .lad-backdrop.in .ladd-panel{transform:none}
  .ladd-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
  .ladd-title{font-size:19px;font-weight:600;line-height:1.3;margin:0;letter-spacing:-.01em}
  .ladd-x{flex-shrink:0;width:32px;height:32px;margin:-4px -6px 0 0;display:flex;align-items:center;justify-content:center;border:0;border-radius:8px;background:none;color:var(--la-sub,#a1a1aa);cursor:pointer}
  .ladd-msg{margin-top:22px;font-size:15px;line-height:1.55;color:var(--la-sub,#a1a1aa);white-space:pre-line;word-break:break-word}
  .ladd-warn{margin-top:4px;font-size:15px;font-weight:700;color:#f87171}
  html:not(.dark) .ladd-warn{color:#dc2626}
  .ladd-type{margin-top:22px;display:flex;align-items:center;flex-wrap:wrap;gap:6px 8px;font-size:15px;color:var(--la-sub,#a1a1aa)}
  .ladd-name{display:inline-flex;align-items:center;gap:8px;max-width:100%;padding:5px 8px 5px 12px;border-radius:8px;border:0;background:var(--la-chip,#18181b);
    color:var(--la-text,#fafafa);font:500 15px Inter,ui-sans-serif,system-ui,sans-serif;cursor:pointer}
  .ladd-name span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ladd-name svg{flex-shrink:0;color:var(--la-sub,#a1a1aa)}
  .ladd-panel,.ladd-panel *{box-sizing:border-box}
  .ladd-input{display:block;width:100%;margin-top:18px;height:46px;padding:0 16px;border-radius:12px;border:1px solid var(--la-line,#27272a);
    background:var(--la-chip,#18181b);color:var(--la-text,#fafafa);font:400 15px Inter,ui-sans-serif,system-ui,sans-serif;outline:none}
  .ladd-input:focus{border-color:var(--la-sub,#a1a1aa)}
  .ladd-input::placeholder{color:var(--la-dim,#71717a)}
  .ladd-err{margin-top:10px;font-size:13px;color:#f87171;min-height:0}
  .ladd-err:empty{display:none}
  .ladd-bar{display:flex;flex-wrap:wrap;gap:12px;margin-top:22px}
  .ladd-btn{display:inline-flex;align-items:center;gap:10px;height:48px;padding:0 8px 0 18px;border-radius:14px;font:600 15px Inter,ui-sans-serif,system-ui,sans-serif;cursor:pointer;border:1px solid transparent}
  .ladd-btn kbd{display:inline-flex;align-items:center;justify-content:center;min-width:30px;height:30px;padding:0 7px;border-radius:8px;font:500 13px Inter,ui-sans-serif,system-ui,sans-serif}
  .ladd-btn kbd + kbd{margin-left:-4px}
  .ladd-del{background:color-mix(in srgb,#ef4444 24%,transparent);color:#fca5a5;border-color:color-mix(in srgb,#ef4444 18%,transparent)}
  .ladd-del kbd{background:color-mix(in srgb,#ef4444 22%,transparent);color:#fca5a5}
  .ladd-del:disabled{cursor:not-allowed;background:color-mix(in srgb,#ef4444 12%,transparent);color:color-mix(in srgb,#fca5a5 55%,transparent)}
  .ladd-del:disabled kbd{color:color-mix(in srgb,#fca5a5 55%,transparent)}
  html:not(.dark) .ladd-del{background:color-mix(in srgb,#ef4444 14%,transparent);color:#b91c1c}
  html:not(.dark) .ladd-del kbd{color:#b91c1c}
  html:not(.dark) .ladd-del:disabled,html:not(.dark) .ladd-del:disabled kbd{color:color-mix(in srgb,#b91c1c 50%,transparent)}
  .ladd-cancel{background:var(--la-chip,#18181b);color:var(--la-text,#fafafa);border-color:var(--la-line,#27272a)}
  .ladd-cancel kbd{background:color-mix(in srgb,var(--la-text,#fafafa) 10%,transparent);color:var(--la-sub,#a1a1aa)}
  @media (hover:hover){.ladd-del:not(:disabled):hover{background:color-mix(in srgb,#ef4444 32%,transparent)}.ladd-cancel:hover{filter:brightness(1.15)}.ladd-x:hover{color:var(--la-text,#fafafa)}}
  @media (max-width:480px){.ladd-panel{padding:24px 20px;border-radius:22px}.ladd-btn{flex:1;justify-content:center}}
  /* The pages' own boxes: rounded like the shared ones; their buttons get the same shortcut keys */
  .ac-panel,.cam-dialog-panel,.se-panel,.pm-panel,.ord-panel,.cal-panel{border-radius:28px !important}
  .la-kbd{display:inline-flex;align-items:center;justify-content:center;min-width:26px;height:26px;padding:0 6px;margin-left:8px;border-radius:7px;vertical-align:middle;
    font:500 12px Inter,ui-sans-serif,system-ui,sans-serif;background:color-mix(in srgb,currentColor 14%,transparent);color:inherit;opacity:.75;flex-shrink:0}
  .la-kbd + .la-kbd{margin-left:4px}
  .la-kbd svg{width:14px;height:14px}
  @media (hover:none),(pointer:coarse){.la-kbd{display:none}}
  @media (max-width:480px){.las-bar{left:16px;right:16px;max-width:none;transform:translateY(24px)}.las-bar.show{transform:none}.las-st{flex:1}}`;
  var st = document.createElement('style'); st.textContent = css;
  (document.head || document.documentElement).appendChild(st);


  // ⌘ ↩ (Ctrl ↩ off the Mac) on the button that goes ahead, Esc on Cancel
  var IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  var ENTER_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 5v7a3 3 0 0 1-3 3H6"/><path d="M10 11l-4 4 4 4"/></svg>';
  var KEYS_GO = '<kbd>' + (IS_MAC ? '⌘' : 'Ctrl') + '</kbd><kbd>' + ENTER_SVG + '</kbd>';
  window.laKeysGo = KEYS_GO;

  function open(opts) {
    return new Promise(function (resolve) {
      var m = document.createElement('div');
      m.className = 'lad-backdrop';
      var tone = opts.tone || 'info';
      m.innerHTML = '<div class="lad-panel" role="' + (opts.cancel ? 'alertdialog' : 'dialog') + '" aria-modal="true">' +
        '<div class="lad-head">' +
        '<div style="min-width:0;width:100%"><p class="lad-title"></p>' + (opts.message ? '<p class="lad-msg"></p>' : '') + '</div></div>' +
        '<div class="lad-actions"><button type="button" class="lad-btn ' + (tone === 'danger' ? 'danger' : 'primary') + '" data-v="1"><span></span>' + KEYS_GO + '</button>' +
        (opts.cancel ? '<button type="button" class="lad-btn ghost" data-v="0"><span></span><kbd>Esc</kbd></button>' : '') + '</div></div>';
      m.querySelector('.lad-title').textContent = opts.title;
      if (opts.message) m.querySelector('.lad-msg').textContent = opts.message;
      if (opts.cancel) m.querySelector('[data-v="0"] span').textContent = opts.cancel;
      m.querySelector('[data-v="1"] span').textContent = opts.ok || 'OK';
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

  // laConfirmDelete({ title, message, name, placeholder, confirmText, run }) → Promise<boolean>
  // For deleting something important: the person types its name to unlock the red button (⌘/Ctrl + Enter, or click).
  // run(ctl), when given, does the deleting while the box stays open: ctl.label(text) shows progress on the button;
  // a thrown error is shown in the box and the button works again.
  window.laConfirmDelete = function (o) {
    o = o || {};
    var name = String(o.name || 'delete');
    var COPY = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8.5" y="8.5" width="11" height="11" rx="2.5"/><path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5"/></svg>';
    var X = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    return new Promise(function (resolve) {
      var m = document.createElement('div');
      m.className = 'lad-backdrop';
      m.innerHTML = '<form class="ladd-panel" role="alertdialog" aria-modal="true" autocomplete="off">' +
        '<div class="ladd-head"><p class="ladd-title"></p><button type="button" class="ladd-x" data-cancel aria-label="Cancel">' + X + '</button></div>' +
        '<p class="ladd-msg"></p><p class="ladd-warn">This can not be undone.</p>' +
        '<p class="ladd-type">Type <button type="button" class="ladd-name" title="Copy"><span></span>' + COPY + '</button> to confirm.</p>' +
        '<input class="ladd-input" spellcheck="false" autocapitalize="off">' +
        '<p class="ladd-err" role="alert"></p>' +
        '<div class="ladd-bar"><button type="submit" class="ladd-btn ladd-del" disabled><span></span>' + KEYS_GO + '</button>' +
        '<button type="button" class="ladd-btn ladd-cancel" data-cancel>Cancel<kbd>Esc</kbd></button></div></form>';
      var f = m.querySelector('form'), inp = f.querySelector('input'), go = f.querySelector('.ladd-del'), label = go.querySelector('span'), err = f.querySelector('.ladd-err'), busy = false;
      f.querySelector('.ladd-title').textContent = o.title || 'Delete ' + name + '?';
      f.querySelector('.ladd-msg').textContent = o.message || 'Are you sure you want to delete ' + name + '?';
      if (!o.message && o.message !== undefined) f.querySelector('.ladd-msg').remove();
      f.querySelector('.ladd-name span').textContent = name;
      inp.placeholder = o.placeholder || 'Enter the name';
      inp.setAttribute('aria-label', 'Type ' + name + ' to confirm');
      label.textContent = o.confirmText || 'Delete';
      document.body.appendChild(m);
      requestAnimationFrame(function () { m.classList.add('in'); });
      var ok = function () { return inp.value.trim() === name; };
      var done = function (v) { if (busy) return; document.removeEventListener('keydown', key); m.classList.remove('in'); setTimeout(function () { m.remove(); }, 150); resolve(v); };
      var submit = async function () {
        if (!ok() || busy) return;
        if (!o.run) return done(true);
        busy = true; go.disabled = true; inp.disabled = true; err.textContent = '';
        f.querySelectorAll('[data-cancel]').forEach(function (b) { b.disabled = true; });
        try { await o.run({ label: function (t) { label.textContent = t; } }); busy = false; done(true); }
        catch (e) {
          busy = false; inp.disabled = false; go.disabled = !ok(); label.textContent = o.confirmText || 'Delete';
          f.querySelectorAll('[data-cancel]').forEach(function (b) { b.disabled = false; });
          err.textContent = (e && e.message) || String(e);
        }
      };
      var key = function (e) {
        if (e.key === 'Escape') { e.preventDefault(); done(false); }
        else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
      };
      document.addEventListener('keydown', key);
      inp.addEventListener('input', function () { go.disabled = busy || !ok(); });
      f.addEventListener('submit', function (e) { e.preventDefault(); submit(); });
      f.querySelectorAll('[data-cancel]').forEach(function (b) { b.addEventListener('click', function () { done(false); }); });
      m.addEventListener('click', function (e) { if (e.target === m) done(false); });
      f.querySelector('.ladd-name').addEventListener('click', function () {
        var b = this;
        try { navigator.clipboard.writeText(name).then(function () { b.title = 'Copied'; }); } catch (_) {}
      });
      setTimeout(function () { inp.focus(); }, 30);
    });
  };

  // Shortcut keys in the pages' own boxes: ⌘ ↩ presses the button that goes ahead (the form's submit button, else
  // its primary button), Esc presses Cancel / Close / Done. The keys are shown on those buttons (not on touch screens).
  (function () {
    var PANELS = '.ac-panel,.cam-dialog-panel,.se-panel,.pm-panel,.ord-panel,.cal-panel';
    var KEY_GO = '<kbd class="la-kbd">' + (IS_MAC ? '⌘' : 'Ctrl') + '</kbd><kbd class="la-kbd">' + ENTER_SVG + '</kbd>';
    var shown = function (el) { return !!(el && el.isConnected && el.offsetParent !== null); };
    function goBtn(p) {
      var list = Array.prototype.slice.call(p.querySelectorAll('button[type=submit], button.primary, button.cam-btn.primary, button.primary-acc, button.danger:not([data-rm])'));
      return list.filter(shown)[0] || null;
    }
    function stopBtn(p) {
      var list = Array.prototype.slice.call(p.querySelectorAll('button[data-cancel], button')).filter(function (b) {
        return shown(b) && (b.hasAttribute('data-cancel') || /^(cancel|close|done|not now)$/i.test((b.textContent || '').replace(/esc$/i, '').trim()));
      });
      return list[0] || null;
    }
    function top() {
      var all = Array.prototype.slice.call(document.querySelectorAll(PANELS)).filter(shown);
      return all[all.length - 1] || null;
    }
    function mark() {
      document.querySelectorAll(PANELS).forEach(function (p) {
        var g = goBtn(p), c = stopBtn(p);
        if (g && !g.querySelector('.la-kbd') && (g.textContent || '').trim()) g.insertAdjacentHTML('beforeend', KEY_GO);
        if (c && c !== g && !c.querySelector('.la-kbd')) c.insertAdjacentHTML('beforeend', '<kbd class="la-kbd">Esc</kbd>');
      });
    }
    var queued = false;
    new MutationObserver(function () { if (queued) return; queued = true; requestAnimationFrame(function () { queued = false; mark(); }); })
      .observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener('keydown', function (e) {
      if (document.querySelector('.lad-backdrop')) return;   // the shared boxes handle their own keys
      var p = top(); if (!p) return;
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        var g = goBtn(p); if (g && !g.disabled) { e.preventDefault(); g.click(); }
      } else if (e.key === 'Escape') {
        // The page may close the box itself on Esc; if it's still open a moment later, press Cancel
        setTimeout(function () { if (shown(p)) { var c = stopBtn(p); if (c && !c.disabled) c.click(); } }, 0);
      }
    });
  })();

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
    // Saved somewhere else (a window's own Save): the bar says so, then goes
    window.laSaveBar.done = function (text) { if (saving) return; cur = null; paint('ok', text || 'Changes saved'); hideT = setTimeout(hide, 2000); };
    // Every Save in a window across the site: once the window closes without an error, "Changes saved"
    document.addEventListener('submit', function (e) {
      var f = e.target, b = e.submitter || (f.querySelector && f.querySelector('[type=submit]'));
      if (!b || !/^\s*save\b/i.test(b.textContent || '') || !f.closest('.se-backdrop, .cam-dialog, .ac-backdrop, .lad-backdrop, [role=dialog]')) return;
      var t0 = Date.now(), iv = setInterval(function () {
        var err = f.querySelector('.se-error, .cam-form-error, .ac-err, [id$="-error"]');
        if (err && err.textContent.trim() && !b.disabled) { clearInterval(iv); return; }   // it went wrong: the window says why
        var gone = !f.isConnected || !f.offsetParent;
        if (gone) { clearInterval(iv); window.laSaveBar.done(); }
        else if (Date.now() - t0 > 20000) clearInterval(iv);
      }, 200);
    }, true);
    // Leaving the page with changes not saved asks first; Cmd/Ctrl+S saves them
    window.addEventListener('beforeunload', function (e) { if (cur) { e.preventDefault(); e.returnValue = ''; } });
    document.addEventListener('keydown', function (e) { if (cur && (e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); save(); } });
  })();

  // Every remaining alert() on the site shows the styled dialog instead of the browser's.
  window.alert = function (m) { window.laAlert(m); };
})();
