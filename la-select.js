// local / assets dropdown menus: every <select> on the page opens a menu in the site's style instead of
// the browser's grey one. The <select> stays the source of truth (value, change events, forms); this only
// draws the list. Phones and tablets keep their native picker, which suits touch better.
(function () {
  if (window.__laSelect) return;
  window.__laSelect = true;
  if (!window.matchMedia || !matchMedia('(hover: hover) and (pointer: fine)').matches) return;

  var css = document.createElement('style');
  css.textContent =
    '.las-menu{position:fixed;z-index:2147483600;min-width:180px;max-height:min(420px,calc(100vh - 24px));overflow:auto;padding:4px 0;' +
      'background:var(--la-raised,#141416);color:var(--la-text,#fafafa);border:1px solid color-mix(in srgb,var(--la-text,#fafafa) 22%,transparent);border-radius:8px;' +
      'box-shadow:0 14px 36px -14px rgba(0,0,0,.35);font:400 15px/1.3 "Helvetica Neue",Helvetica,Arial,sans-serif;' +
      'opacity:0;transform:translateY(-3px);transition:opacity .14s ease,transform .16s cubic-bezier(.22,1,.36,1);outline:none}' +
    '.las-menu.up{transform:translateY(3px)}' +
    '.las-menu.on{opacity:1;transform:none}' +
    '.las-sep{height:1px;margin:4px 0;background:color-mix(in srgb,var(--la-text,#fafafa) 16%,transparent)}' +
    '.las-opt{padding:12px 20px;cursor:pointer;white-space:nowrap;transition:background .12s ease}' +
    '.las-opt.act{background:var(--la-chip,rgba(255,255,255,.06))}' +
    '.las-opt.sel{font-weight:600}' +
    '.las-opt.dis{opacity:.4;cursor:default}' +
    '.las-opt.new{color:color-mix(in srgb,var(--la-accent,#39FF14) 82%,var(--la-text,#fafafa))}' +
    // The closed box: a divider and up/down chevrons on the right
    ':root body select:not([multiple]):not([size]):not(.bl-status):not([data-native]){-webkit-appearance:none;appearance:none;padding-right:46px !important;' +
      'background-image:url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2738%27 height=%2724%27 viewBox=%270 0 38 24%27%3E%3Cpath d=%27M1 3v18%27 stroke=%27%238a8a93%27 stroke-width=%271.2%27/%3E%3Cpath d=%27M20 10l4.5-4.5L29 10M20 14l4.5 4.5L29 14%27 fill=%27none%27 stroke=%27%238a8a93%27 stroke-width=%271.6%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27/%3E%3C/svg%3E") !important;' +
      'background-repeat:no-repeat !important;background-position:right 6px center !important;background-size:38px 24px !important}' +
    '@media (prefers-reduced-motion:reduce){.las-menu{transition:none}}';
  document.head.appendChild(css);

  var menu = null, sel = null, items = [], active = -1;

  function close(focusBack) {
    if (!menu) return;
    var m = menu, s = sel;
    menu = null; sel = null; items = []; active = -1;
    m.classList.remove('on');
    setTimeout(function () { m.remove(); }, 160);
    document.removeEventListener('mousedown', outside, true);
    window.removeEventListener('resize', onWin, true);
    window.removeEventListener('scroll', onWin, true);
    if (focusBack && s) s.focus({ preventScroll: true });
  }
  function outside(e) { if (menu && !menu.contains(e.target) && e.target !== sel) close(false); }
  function onWin(e) { if (menu && !(e && e.target && menu.contains(e.target))) close(false); }

  function setActive(i, scroll) {
    if (!items.length) return;
    if (active >= 0 && items[active]) items[active].el.classList.remove('act');
    active = Math.max(0, Math.min(items.length - 1, i));
    var it = items[active];
    it.el.classList.add('act');
    if (scroll) it.el.scrollIntoView({ block: 'nearest' });
  }
  function choose(i) {
    var it = items[i], s = sel;
    if (!it || it.disabled) return;
    close(true);
    if (s.selectedIndex !== it.index) {
      s.selectedIndex = it.index;
      s.dispatchEvent(new Event('input', { bubbles: true }));
      s.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function open(s) {
    close(false);
    sel = s;
    menu = document.createElement('div');
    menu.className = 'las-menu';
    menu.setAttribute('role', 'listbox');
    menu.tabIndex = -1;
    var lastGroup = null;
    Array.prototype.forEach.call(s.options, function (o, idx) {
      if (o.hidden) return;
      var g = o.parentNode && o.parentNode.tagName === 'OPTGROUP' ? o.parentNode : null;
      if (g !== lastGroup) {
        lastGroup = g;
        if (menu.childNodes.length) { var h = document.createElement('div'); h.className = 'las-sep'; h.setAttribute('role', 'separator'); menu.appendChild(h); }
      }
      var el = document.createElement('div');
      var isSel = idx === s.selectedIndex, dis = o.disabled || (g && g.disabled);
      el.className = 'las-opt' + (isSel ? ' sel' : '') + (dis ? ' dis' : '') + (/^\+/.test(o.text.trim()) ? ' new' : '');
      el.setAttribute('role', 'option');
      el.setAttribute('aria-selected', isSel ? 'true' : 'false');
      el.textContent = o.text;
      var n = items.length;
      items.push({ el: el, index: idx, disabled: dis, text: o.text.trim().toLowerCase() });
      el.addEventListener('mousemove', function () { if (active !== n) setActive(n, false); });
      el.addEventListener('mousedown', function (e) { e.preventDefault(); });
      el.addEventListener('click', function () { choose(n); });
      menu.appendChild(el);
    });
    document.body.appendChild(menu);

    // Place it under the select (or above when there's no room), at least as wide as the select
    var r = s.getBoundingClientRect(), vw = window.innerWidth, vh = window.innerHeight;
    menu.style.minWidth = Math.max(180, r.width) + 'px';
    var mh = menu.offsetHeight, mw = menu.offsetWidth;
    var below = vh - r.bottom - 12, above = r.top - 12, up = mh > below && above > below;
    menu.style.left = Math.max(12, Math.min(r.left, vw - mw - 12)) + 'px';
    menu.style.top = (up ? Math.max(12, r.top - mh - 2) : Math.min(r.bottom + 2, vh - mh - 12)) + 'px';
    if (up) menu.classList.add('up');
    requestAnimationFrame(function () { if (menu) menu.classList.add('on'); });

    var start = items.findIndex(function (it) { return it.index === s.selectedIndex; });
    setActive(start < 0 ? 0 : start, true);
    menu.addEventListener('keydown', keys);
    menu.focus({ preventScroll: true });
    document.addEventListener('mousedown', outside, true);
    window.addEventListener('resize', onWin, true);
    window.addEventListener('scroll', onWin, true);
  }

  var typed = '', typedAt = 0;
  function keys(e) {
    if (!menu) return;
    var k = e.key;
    if (k === 'Escape' || k === 'Tab') { e.preventDefault(); close(true); return; }
    if (k === 'ArrowDown') { e.preventDefault(); var i = active; do { i++; } while (items[i] && items[i].disabled); if (items[i]) setActive(i, true); return; }
    if (k === 'ArrowUp') { e.preventDefault(); var j = active; do { j--; } while (items[j] && items[j].disabled); if (items[j]) setActive(j, true); return; }
    if (k === 'Home') { e.preventDefault(); setActive(0, true); return; }
    if (k === 'End') { e.preventDefault(); setActive(items.length - 1, true); return; }
    if (k === 'Enter' || k === ' ') { e.preventDefault(); choose(active); return; }
    if (k.length === 1) {
      var now = Date.now(); typed = (now - typedAt > 700 ? '' : typed) + k.toLowerCase(); typedAt = now;
      var hit = items.findIndex(function (it) { return !it.disabled && it.text.indexOf(typed) === 0; });
      if (hit >= 0) setActive(hit, true);
    }
  }

  function usable(t) { return t && t.tagName === 'SELECT' && !t.multiple && !(t.size > 1) && !t.disabled && !t.hasAttribute('data-native'); }

  // Mouse: open our menu instead of the browser's
  document.addEventListener('mousedown', function (e) {
    var s = e.target;
    if (!usable(s) || e.button !== 0) return;
    e.preventDefault();
    if (sel === s) { close(true); return; }
    s.focus({ preventScroll: true });
    open(s);
  }, true);
  // Keyboard on a focused select: Space, Enter, Alt+Down open the same menu
  document.addEventListener('keydown', function (e) {
    var s = e.target;
    if (!usable(s) || menu) return;
    if (e.key === ' ' || e.key === 'Enter' || (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp'))) { e.preventDefault(); open(s); }
  }, true);
})();
