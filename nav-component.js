// Dropdown menus in the site's style (la-select.js), on every page that has the nav
// Faster page changes: hovering a sidebar link starts loading that page (and its data) in the background,
// so it's usually ready when clicked (Chrome, Edge, Brave and the a™ app; other browsers just load normally)
(function () {
    if (!(window.HTMLScriptElement && HTMLScriptElement.supports && HTMLScriptElement.supports('speculationrules'))) return;
    if (document.querySelector('script[type=speculationrules]')) return;
    var sr = document.createElement('script');
    sr.type = 'speculationrules';
    sr.textContent = JSON.stringify({ prerender: [{ where: { href_matches: ['/dashboard', '/camera', '/brand', '/assets', '/billing', '/contacts', '/accounts', '/inbox'] }, eagerness: 'moderate' }] });
    document.head.appendChild(sr);
})();
// Inside the iPhone app (ios-app): sign-in through Safari and push notifications (la-native.js)
(function () { if (!window.Capacitor || document.querySelector('script[data-la-native]')) return; var sc = document.createElement('script'); sc.src = '/la-native.js?v=1'; sc.setAttribute('data-la-native', ''); document.head.appendChild(sc); })();
(function () { if (document.querySelector('script[data-la-select]')) return; var sc = document.createElement('script'); sc.src = '/la-select.js?v=7'; sc.defer = true; sc.setAttribute('data-la-select', ''); document.head.appendChild(sc); })();
// Installed on an iPhone or iPad (home screen): the height Safari gives the page leaves out the status bar, so
// the app stopped that much short of the bottom of the screen. Sized to the whole screen instead
// (only when the app has the full width, so not in Split View on an iPad).
(function () {
  var standalone = window.navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
  if (!standalone || !window.screen) return;
  var root = document.documentElement;
  root.classList.add('la-standalone');
  var fit = function () {
    var land = window.innerWidth > window.innerHeight;
    var w = land ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height);
    var h = land ? Math.min(screen.width, screen.height) : Math.max(screen.width, screen.height);
    if (Math.abs(window.innerWidth - w) <= 2 && h > window.innerHeight) root.style.setProperty('--la-app-h', h + 'px');
    else root.style.removeProperty('--la-app-h');
  };
  fit();
  window.addEventListener('resize', fit);
  window.addEventListener('orientationchange', function () { setTimeout(fit, 300); });
})();
// Loading, as a terminal shows it: a braille spinner and a line about what the page is doing, typed out with a
// blinking cursor, then the next one. <la-spin topic="history"></la-spin> where content is on its way; the page's
// own content replaces it. Defined before the page loads, so it shows from the first paint.
(function() {
    if (!window.customElements || customElements.get('la-spin')) return;
    var LINES = {
        history: ['Gathering your sets…', 'Matching clips to their sessions…', 'Lining up the long forms…', 'Counting the vertical clips…', 'Checking the watermarks…', 'Reading the session dates…'],
        brand: ['Opening the Brand Kit…', 'Finding the logos…', 'Sorting fonts and artwork…', 'Loading the GIF animations…', 'Checking the watermark…'],
        contacts: ['Finding your contacts…', 'Matching artists and venues…', 'Sorting by name…'],
        accounts: ['Listing the client accounts…', 'Checking plans and payments…', 'Counting the logins…'],
        inbox: ['Opening the inbox…', 'Fetching the emails from Resend…', 'Looking for replies to approve…'],
        billing: ['Adding up this month…', 'Fetching the invoices from Stripe…', 'Checking what’s been paid…'],
        usage: ['Adding up every account…', 'Counting minutes streamed…', 'Measuring video stored…', 'Drawing the chart…'],
        stage: ['Loading the artist’s brand…', 'Finding the logos and fonts…'],
        stream: ['Preparing the stream address…', 'Fetching the stream key…'],
        page: ['Loading…', 'Almost there…']
    };
    // Braille dots, as npm and other command-line tools spin (never drawn as an emoji, unlike ✳ on iPhones)
    var FRAMES = ['\u280b', '\u2819', '\u2839', '\u2838', '\u283c', '\u2834', '\u2826', '\u2827', '\u2807', '\u280f'];
    // Pink in dark mode, orange in light mode
    var css = document.createElement('style');
    css.textContent = 'la-spin{--ls-c:var(--la-accent,#F472B6);display:flex;align-items:center;padding:18px 0;font:400 12px/1.4 "JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--ls-c)}' +
        'la-spin .ls-g{flex:none;width:14px;margin-right:10px;text-align:center;font-size:14px;line-height:1}' +
        'la-spin .ls-t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
        'la-spin .ls-k{display:inline-block;width:.6em;height:1.1em;margin-left:2px;vertical-align:-.2em;background:var(--ls-c);animation:ls-blink 1s steps(1) infinite}' +
        '@keyframes ls-blink{50%{opacity:0}}' +
        '@media (prefers-reduced-motion:reduce){la-spin .ls-k{animation:none}}' +
        'la-spin[center]{justify-content:center}la-spin[inset]{padding:18px 20px}';
    (document.head || document.documentElement).appendChild(css);
    var still = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    customElements.define('la-spin', class extends HTMLElement {
        connectedCallback() {
            var lines = LINES[this.getAttribute('topic')] || LINES.page, i = 0, f = 0, n = 0, wait = 0;
            this.setAttribute('role', 'status');
            this.innerHTML = '<span class="ls-g" aria-hidden="true">' + FRAMES[0] + '</span><span class="ls-t"></span><span class="ls-k" aria-hidden="true"></span>';
            var g = this.firstChild, t = g.nextSibling;
            if (still) { t.textContent = lines[0]; return; }
            this._g = setInterval(function() { f = (f + 1) % FRAMES.length; g.textContent = FRAMES[f]; }, 80);
            // Types the line a letter at a time, holds it, then types the next
            this._t = setInterval(function() {
                if (wait) { wait--; return; }
                if (n < lines[i].length) { t.textContent = lines[i].slice(0, ++n); if (n === lines[i].length) wait = 50; return; }
                if (lines.length > 1) { i = (i + 1) % lines.length; n = 0; t.textContent = ''; }
            }, 35);
        }
        disconnectedCallback() { clearInterval(this._g); clearInterval(this._t); }
    });
})();
// A page of the site that opens in a new tab (the video player): in the a™ Mac app it opens in the same
// window instead (its Back returns). A second window over a full-screen a™ left the app black when it closed.
window.laOpenPage = function(url) {
    if (window.laApp) location.href = url;
    else window.open(url, '_blank');
};
// No right-click menu anywhere in the app (text fields keep theirs, to paste)
document.addEventListener('contextmenu', function(e) { var t = e.target; if (t && t.closest && t.closest('input, textarea, [contenteditable=""], [contenteditable="true"]')) return; e.preventDefault(); }, true);
// The accent colours (the Brand Kit's colours), in the order the dots show them
var LA_ACCENTS = [['', 'Neon green'], ['yellow', 'Yellow'], ['orange', 'Orange'], ['red', 'Red'], ['pink', 'Pink'], ['indigo', 'Indigo'], ['blue', 'Blue'], ['teal', 'Teal']];
// The breadcrumb's account name: the local / assets account shows its company name as written.
// Defined before the page loads: pages call it from their own scripts while still loading.
window.laSetBreadcrumb = function(el, name) {
    if (!el) return;
    var isLa = /^local\s*[\/-]?\s*assets\b/i.test(String(name || ''));
    el.textContent = isLa ? 'local / assets LTD' : name;
    el.classList.toggle('is-la', isLa);
};
document.addEventListener("DOMContentLoaded", () => {
    // Inject theme switcher CSS if not already present
    if (!document.getElementById('la-theme-switcher-css')) {
        var style = document.createElement('style');
        style.id = 'la-theme-switcher-css';
        style.textContent = `
            .la-theme-switcher{display:inline-grid;grid-template-columns:repeat(3,1fr);background:#111;border:1px solid #27272a;border-radius:9999px;padding:3px;gap:2px}
            .la-theme-switcher button{all:unset;display:inline-flex;align-items:center;justify-content:center;gap:0;font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:500;line-height:14px;letter-spacing:.05em;text-transform:uppercase;padding:5px 10px;border-radius:9999px;cursor:pointer;color:rgba(255,255,255,.2);transition:color .3s ease-in-out,background-color .3s ease-in-out;white-space:nowrap;-webkit-user-select:none;user-select:none}
            .la-theme-switcher button:hover{color:rgba(255,255,255,.45)}
            .la-theme-switcher button[aria-checked="true"]{background:rgba(255,255,255,.08);color:#fff}
            .la-theme-switcher button .la-theme-icon{font-size:12px;display:inline-flex;max-width:0;opacity:0;overflow:hidden;transition:max-width .3s ease-in-out,opacity .3s ease-in-out,margin .3s ease-in-out;margin-right:0}
            .la-theme-switcher button[aria-checked="true"] .la-theme-icon{max-width:18px;opacity:1;margin-right:5px}
            .la-theme-switcher button span{margin-right:-.05em}
            html:not(.dark) .la-theme-switcher{background:#e4e4e7;border-color:#d4d4d8}
            html:not(.dark) .la-theme-switcher button{color:rgba(0,0,0,.3)}
            html:not(.dark) .la-theme-switcher button:hover{color:rgba(0,0,0,.55)}
            html:not(.dark) .la-theme-switcher button[aria-checked="true"]{background:rgba(0,0,0,.07);color:#18181b}
            .la-sign-in-btn{position:relative;isolation:isolate;overflow:hidden;height:36px;padding:0 18px;border-radius:999px;background:transparent;border:1px solid color-mix(in srgb,var(--la-text,#fafafa) 30%,transparent);color:var(--la-text,#fafafa);font:500 13px/1 'Helvetica Neue',Helvetica,Arial,sans-serif;white-space:nowrap;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;transition:color .3s cubic-bezier(.65,0,.35,1),border-color .3s cubic-bezier(.65,0,.35,1),transform .15s ease}
            .la-sign-in-btn::before{content:"";position:absolute;inset:-1px;z-index:-1;border-radius:inherit;background:var(--la-text,#fafafa);transform:scaleX(0);transform-origin:right center;transition:transform .42s cubic-bezier(.65,0,.35,1);pointer-events:none}
            .la-sign-in-btn:active{transform:scale(.97)}
            @media (hover:hover){.la-sign-in-btn:hover{color:var(--la-bg,#000);border-color:var(--la-text,#fafafa)}.la-sign-in-btn:hover::before{transform:scaleX(1);transform-origin:left center}}
        `;
        document.head.appendChild(style);
    }

    const sidebar = document.getElementById("sidebar");
    if (!sidebar) return;

    const currentPath = window.location.pathname;
    const isActive = (path) => {
        return currentPath === path || currentPath.startsWith(path + '/') ? "active" : "text-zinc-400";
    };

    const saved = localStorage.getItem('la_theme') || 'dark';

    const _navRole = (() => {
        try { return JSON.parse(localStorage.getItem('la_admin') || 'null')?.role || 'admin'; }
        catch(_) { return 'admin'; }
    })();
    const _isClient = _navRole === 'client';

    // An artist given access to a venue's or label's account: only Overview, Calendar and Brand Kit
    var _isMember = (function() { try { return !!(JSON.parse(localStorage.getItem('la_admin') || '{}').member); } catch (_) { return false; } })();
    if (_isMember && /^\/(camera|assets|billing)(\.html)?\/?$/.test(location.pathname) && !/^\/calendar/.test(location.pathname)) {
        if (!(location.pathname === '/camera' && new URLSearchParams(location.search).get('view') === 'calendar')) location.replace('/dashboard');
    }
    var _memberHide = _isMember ? 'display:none !important' : '';
    // An artist with access: their own name at the top and in the account menu (also for a sign-in from before)
    (function() { try { var a = JSON.parse(localStorage.getItem('la_admin') || '{}'); if (a.member && a.member.name) { var n = String(a.member.name).toUpperCase(); if (a.venue !== n) { a.venue = n; localStorage.setItem('la_admin', JSON.stringify(a)); } localStorage.setItem('la_venue_name', n); } } catch (_) {} })();
    // The local / assets admin account has no Brand Kit (that's for clients)
    var _isAdminAcct = (function() { try { var a = JSON.parse(localStorage.getItem('la_admin') || '{}'); return (a.venueSlug === 'local-assets-admin' || (function(c){ return /^local\s*[\/-]?\s*assets\b/i.test(String(c ? c.name : (a.venue || '')).trim()); })((a.venues || []).filter(function(v){ return v && v.slug === a.venueSlug; })[0])); } catch (_) { return false; } })();
    sidebar.innerHTML = `
        <div id="la-side-head" class="h-20 flex items-center justify-center px-8 border-b border-[#27272a] shrink-0" style="position:relative">
            <a href="/dashboard" class="la-logo-link h-5 w-24 flex" aria-label="local / assets">
                <span class="la-logo" role="img" aria-label="local / assets"></span>
            </a>
            <button onclick="toggleSidebar()" aria-label="Close menu" class="md:hidden text-zinc-400 hover:text-white transition-colors" style="position:absolute;right:20px;top:50%;transform:translateY(-50%);width:36px;height:36px;line-height:0;">
                <iconify-icon icon="solar:close-circle-linear" class="text-2xl"></iconify-icon>
            </button>
        </div>
        <nav class="flex-1 p-4 space-y-1 overflow-y-auto">
            <a href="/dashboard" class="nav-link flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${isActive('/dashboard')}">
                <svg class="nav-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/></svg><span>Overview</span>
            </a>
            <a href="/calendar" class="nav-link flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${isActive('/calendar')}">
                <svg class="nav-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg><span>Calendar</span>
            </a>
            <a href="/camera" style="${_memberHide}" class="nav-link flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${isActive('/camera')}">
                <svg class="nav-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="6" width="13.5" height="12" rx="2.5"/><path d="M16 10.5l5.5-3.2v9.4L16 13.5"/></svg><span>Camera Control</span>
            </a>
            <a href="/assets" style="${_memberHide}" class="nav-link flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${isActive('/assets')}">
                <svg class="nav-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15.5V4M7.5 8.5L12 4l4.5 4.5"/><path d="M4 15v3.5A2 2 0 0 0 6 20.5h12a2 2 0 0 0 2-2V15"/></svg><span>Upload Asset</span>
            </a>
            <a href="/brand" style="${_isAdminAcct ? 'display:none !important' : ''}" class="nav-link flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${isActive('/brand')}">
                <svg class="nav-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.8-.8 1.8-1.8 0-.5-.2-.9-.5-1.3-.3-.3-.5-.8-.5-1.3 0-1 .8-1.8 1.8-1.8h2.1a3.8 3.8 0 0 0 3.8-3.8C20.5 6.9 16.7 3.5 12 3.5z"/><circle cx="7.6" cy="11.2" r="1"/><circle cx="10.4" cy="7.4" r="1"/><circle cx="15" cy="7.6" r="1"/></svg><span>Brand Kit</span>
            </a>
            <a href="/accounts" style="${_isAdminAcct ? '' : 'display:none !important'}" class="nav-link flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${isActive('/accounts')}">
                <svg class="nav-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.6-3 2.9-5 5.5-5s4.9 2 5.5 5"/><path d="M15.5 5.2a3 3 0 0 1 0 5.6M17.5 14.4c1.6.7 2.7 2.4 3 4.6"/></svg><span>Accounts</span>
            </a>
            <a href="/inbox" style="${_isAdminAcct ? '' : 'display:none !important'}" class="nav-link flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${isActive('/inbox')}">
                <svg class="nav-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 13.5l2.6-7.4A2 2 0 0 1 8 4.8h8a2 2 0 0 1 1.9 1.3l2.6 7.4V18a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M3.5 13.5h4.8l1.4 2.5h4.6l1.4-2.5h4.8"/></svg><span>Inbox</span><b id="la-inbox-n" style="margin-left:auto;display:none;min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:var(--la-accent);color:var(--la-accent-ink);font:700 10px/18px 'JetBrains Mono',monospace;text-align:center"></b>
            </a>
            <a href="/contacts" style="${_isAdminAcct ? 'display:none !important' : ''}" class="nav-link flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${isActive('/contacts')}">
                <svg class="nav-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4h3.2l1.6 4-2 1.3a11 11 0 0 0 4.9 4.9l1.3-2 4 1.6V17a2 2 0 0 1-2 2A15 15 0 0 1 3 6a2 2 0 0 1 2-2z"/></svg><span>Contacts</span>
            </a>
            <a href="/docs" class="nav-link flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${isActive('/docs')}">
                <svg class="nav-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4.5h9.5L19 9v10.5H5z"/><path d="M14.5 4.5V9H19M8.5 13h7M8.5 16.5h5"/></svg><span>Docs</span>
            </a>
            <a href="/billing" style="${_memberHide}" class="nav-link flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${isActive('/billing')}">
                <svg class="nav-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19M6.5 15h4"/></svg><span>Billing</span>
            </a>
        </nav>
        <div class="px-4 pt-6 mt-4 flex flex-col items-center" style="padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 1.5rem)">
            <div class="la-theme-switcher" role="radiogroup" aria-label="Theme">
                <button type="button" role="radio" aria-checked="${saved === 'light' ? 'true' : 'false'}" data-theme="light">
                    
                    <span>Light</span>
                </button>
                <button type="button" role="radio" aria-checked="${saved === 'dark' || !['light','dark','auto'].includes(saved) ? 'true' : 'false'}" data-theme="dark">
                    
                    <span>Dark</span>
                </button>
                <button type="button" role="radio" aria-checked="${saved === 'auto' ? 'true' : 'false'}" data-theme="auto">
                    
                    <span>Auto</span>
                </button>
            </div>
            <div class="la-accent-dots" role="radiogroup" aria-label="Accent colour">
                ${LA_ACCENTS.map(function(a) { return '<button type="button" role="radio" data-accent="' + a[0] + '" aria-label="' + a[1] + '" title="' + a[1] + '" aria-checked="' + ((localStorage.getItem('la_accent') || '') === a[0]) + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></button>'; }).join('')}
                <button type="button" role="radio" data-accent-own aria-label="Your own colour (HEX)" title="Your own colour (HEX)" aria-checked="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></button>
            </div>
            <div class="la-accent-hex" hidden><input type="color" id="la-accent-pick" aria-label="Pick a colour"><input type="text" id="la-accent-hex" maxlength="7" placeholder="#RRGGBB" spellcheck="false" autocomplete="off" aria-label="HEX colour"></div>
            <div class="la-accent-save" hidden><button type="button" id="la-accent-save">Save colour</button><span id="la-accent-msg" role="status"></span></div>
        </div>
    `;

    // The admin's Inbox: how many unread emails, beside the menu link (checked every minute while on screen)
    window.laInboxBadge = function(n) { var b = document.getElementById('la-inbox-n'); if (b) { b.textContent = n > 99 ? '99+' : String(n || ''); b.style.display = n ? 'inline-block' : 'none'; } };
    if (_isAdminAcct && !window._laInboxPoll) {
        window._laInboxPoll = true;
        var _inboxCheck = function() {
            if (document.hidden || location.pathname.indexOf('/inbox') === 0) return;   // the Inbox page counts for itself
            var t = ''; try { t = JSON.parse(localStorage.getItem('la_admin') || '{}').webToken || ''; } catch (_) {}
            if (!t) return;
            fetch('/api/inbox?view=count', { headers: { Authorization: 'Bearer ' + t } }).then(function(r) { return r.ok ? r.json() : null; }).then(function(d) { if (d) window.laInboxBadge(d.unread); }).catch(function() {});
        };
        _inboxCheck(); setInterval(_inboxCheck, 60000);
        document.addEventListener('visibilitychange', _inboxCheck);
    }

    // Initialize theme engine (event delegation — works for sidebar + any other switcher)
    if (!window._laThemeInit) {
        window._laThemeInit = true;

        function resolve(mode) {
            return mode === 'auto'
                ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
                : mode;
        }

        function apply(mode) {
            var resolved = resolve(mode);
            if (resolved === 'dark') document.documentElement.classList.add('dark');
            else document.documentElement.classList.remove('dark');
            localStorage.setItem('la_theme', mode);
            document.querySelectorAll('.la-theme-switcher button[data-theme]').forEach(function(b) {
                b.setAttribute('aria-checked', b.getAttribute('data-theme') === mode ? 'true' : 'false');
            });
            document.dispatchEvent(new CustomEvent('themechange'));
        }

        document.addEventListener('click', function(e) {
            var btn = e.target.closest('.la-theme-switcher button[data-theme]');
            if (btn) apply(btn.getAttribute('data-theme'));
        });

        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function() {
            if (localStorage.getItem('la_theme') === 'auto') apply('auto');
        });

        window._laApplyTheme = apply;

        // Accent colour: one of the Brand Kit's colours for every detail (buttons, links, the logo, active menu item…).
        // A dot shows the colour; Save keeps it with the login, so every device shows it ('' = the original neon green).
        // This device remembers the saved one (la_accent) so pages open in it straight away.
        var _accSaved = ''; try { _accSaved = localStorage.getItem('la_accent') || ''; } catch (_) {}
        var _accToken = function() { try { return JSON.parse(localStorage.getItem('la_admin') || '{}').webToken || ''; } catch (_) { return ''; } };
        // Your own colour: a HEX code (#RRGGBB), with black or white text on it, whichever reads better
        var isHex = function(a) { return /^#[0-9a-f]{6}$/i.test(a || ''); };
        var inkOf = function(h) { var n = parseInt(h.slice(1), 16); return 0.299 * (n >> 16) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255) > 150 ? '#000000' : '#ffffff'; };
        function applyAccent(a) {
            var root = document.documentElement;
            if (a) root.setAttribute('data-accent', a); else root.removeAttribute('data-accent');
            if (isHex(a)) { root.style.setProperty('--la-accent', a); root.style.setProperty('--la-accent-ink', inkOf(a)); }
            else { root.style.removeProperty('--la-accent'); root.style.removeProperty('--la-accent-ink'); }
            document.querySelectorAll('.la-accent-dots button[data-accent]').forEach(function(b) { b.setAttribute('aria-checked', b.getAttribute('data-accent') === a ? 'true' : 'false'); });
            document.querySelectorAll('.la-accent-dots button[data-accent-own]').forEach(function(b) { b.setAttribute('aria-checked', isHex(a) ? 'true' : 'false'); if (isHex(a)) b.style.setProperty('--dot', a); });
            document.querySelectorAll('#la-accent-pick').forEach(function(i) { if (isHex(a)) i.value = a.toLowerCase(); });
            document.querySelectorAll('#la-accent-hex').forEach(function(i) { if (isHex(a) && document.activeElement !== i) i.value = a.toUpperCase(); });
            // Save shows while the colour on screen isn't the saved one
            document.querySelectorAll('.la-accent-save').forEach(function(r) { if (a !== _accSaved) { r.hidden = false; var m = r.querySelector('#la-accent-msg'); if (m) m.textContent = ''; } else if (!r.dataset.justSaved) r.hidden = true; });
            // Video players take a colour value, not the CSS variable
            var hex = getComputedStyle(document.documentElement).getPropertyValue('--la-accent').trim();
            if (hex) document.querySelectorAll('mux-player').forEach(function(m) { m.setAttribute('accent-color', hex); });
            document.dispatchEvent(new CustomEvent('accentchange'));
        }
        function hexRows(show) { document.querySelectorAll('.la-accent-hex').forEach(function(r) { r.hidden = !show; }); }
        // Typing a HEX code (# optional, 3 or 6 digits) or picking a colour shows it straight away; Save keeps it
        document.addEventListener('input', function(e) {
            if (e.target.id === 'la-accent-pick') { applyAccent(e.target.value.toLowerCase()); return; }
            if (e.target.id !== 'la-accent-hex') return;
            var v = e.target.value.trim().replace(/^#?/, '#');
            if (/^#[0-9a-f]{3}$/i.test(v)) v = '#' + v.slice(1).split('').map(function(c) { return c + c; }).join('');
            if (isHex(v)) applyAccent(v.toLowerCase());
        });
        function keepAccent(a) { _accSaved = a; try { if (a) localStorage.setItem('la_accent', a); else localStorage.removeItem('la_accent'); } catch (_) {} }
        document.addEventListener('click', function(e) {
            // Closed, the dots show only the chosen colour; clicking it opens them all, picking one closes them
            var btn = e.target.closest('.la-accent-dots button[data-accent]');
            var dots = btn && btn.parentNode;
            if (btn && !dots.classList.contains('open')) { dots.classList.add('open'); return; }
            if (btn) { applyAccent(btn.getAttribute('data-accent')); dots.classList.remove('open'); hexRows(false); return; }
            // Your own colour: opens the colour picker and the HEX box under the dots
            var own = e.target.closest('.la-accent-dots button[data-accent-own]');
            if (own && !own.parentNode.classList.contains('open')) { own.parentNode.classList.add('open'); return; }
            if (own) { hexRows(true); var hx = document.getElementById('la-accent-hex'); if (hx) hx.focus(); return; }
            if (!e.target.closest('.la-accent-dots, .la-accent-hex')) { document.querySelectorAll('.la-accent-dots.open').forEach(function(d) { d.classList.remove('open'); }); hexRows(false); }
            var save = e.target.closest('#la-accent-save');
            if (!save) return;
            var a = document.documentElement.getAttribute('data-accent') || '', row = save.parentNode, msg = row.querySelector('#la-accent-msg');
            save.disabled = true; if (msg) msg.textContent = 'Saving…';
            fetch('/api/prefs', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + _accToken() }, body: JSON.stringify({ accent: a }) })
                .then(function(r) { if (!r.ok) throw new Error(r.status); keepAccent(a); save.hidden = true; if (msg) msg.textContent = 'Saved on every device'; row.dataset.justSaved = '1';
                    setTimeout(function() { delete row.dataset.justSaved; save.hidden = false; if ((document.documentElement.getAttribute('data-accent') || '') === _accSaved) row.hidden = true; }, 2500); })
                .catch(function() { if (msg) msg.textContent = 'Could not save. Try again.'; })
                .then(function() { save.disabled = false; });
        });
        document.addEventListener('themechange', function() { applyAccent(document.documentElement.getAttribute('data-accent') || ''); });
        if (_accSaved) applyAccent(document.documentElement.getAttribute('data-accent') || _accSaved);
        // The colour saved with the login (from another device): shown here too, unless a new one is being tried
        if (_accToken()) fetch('/api/prefs', { headers: { Authorization: 'Bearer ' + _accToken() } }).then(function(r) { return r.ok ? r.json() : null; }).then(function(d) {
            if (!d || d.accent === _accSaved) return;
            var showing = document.documentElement.getAttribute('data-accent') || '', trying = showing !== _accSaved;
            keepAccent(d.accent);
            if (!trying) applyAccent(d.accent);
        }).catch(function() {});
        window._laApplyAccent = applyAccent;
    }

    // --- Venue Name System (shared across all pages) ---
    var DEFAULT_VENUE = 'LOCAL / ASSETS';

    window.getVenueName = function() {
        return localStorage.getItem('la_venue_name') || DEFAULT_VENUE;
    };

    // Fetch client profile for cookie-session users only.
    // Admin users authenticate via webToken (localStorage) — skip this call for them.
    var _adminToken = (function() {
        try { var a = JSON.parse(localStorage.getItem('la_admin') || '{}'); return a.webToken || ''; } catch(e) { return ''; }
    })();
    if (!_adminToken) {
        fetch('/api/client-profile', { credentials: 'include' })
            .then(function(r) { return r.ok ? r.json() : null; })
            .then(function(profile) {
                if (profile && profile.name) {
                    localStorage.setItem('la_venue_name', profile.name.toUpperCase());
                    window.applyVenueName();
                }
            })
            .catch(function() {});
    }

    window.applyVenueName = function() {
        var name = window.getVenueName().toUpperCase();
        var breadcrumb = document.getElementById('venue-breadcrumb');
        var tier = document.getElementById('venue-tier');
        window.laSetBreadcrumb(breadcrumb, name);
        if (tier) tier.textContent = String(name).toUpperCase();
        document.querySelectorAll('[data-venue-label]').forEach(function(el) {
            el.textContent = name;
        });
        window._updateAuthAvatar();
    };

    window.openVenueEditor = function() {
        var popover = document.getElementById('venue-popover');
        var input = document.getElementById('venue-input');
        if (!popover || !input) return;
        popover.classList.toggle('hidden');
        if (!popover.classList.contains('hidden')) {
            input.value = window.getVenueName();
            input.focus();
            input.style.borderColor = 'var(--la-accent)';
            input.setSelectionRange(input.value.length, input.value.length);
        }
    };

    window.closeVenueEditor = function() {
        var input = document.getElementById('venue-input');
        var isDark = document.documentElement.classList.contains('dark');
        if (input) input.style.borderColor = isDark ? '#27272a' : '#e4e4e7';
        var popover = document.getElementById('venue-popover');
        if (popover) popover.classList.add('hidden');
    };

    window.saveVenueName = function() {
        var input = document.getElementById('venue-input');
        if (!input) return;
        var name = input.value.trim();
        if (!name) return;
        localStorage.setItem('la_venue_name', name.toUpperCase());
        window.closeVenueEditor();
        window.applyVenueName();
        if (typeof fetchRecentUploads === 'function') fetchRecentUploads();
    };

    // Inject venue editor modal if not already present
    if (!document.getElementById('venue-popover')) {
        var popover = document.createElement('div');
        popover.id = 'venue-popover';
        popover.className = 'hidden fixed inset-0 z-50 flex items-center justify-center px-4';
        popover.innerHTML = '<div class="fixed inset-0 bg-black/90 backdrop-blur-sm" onclick="closeVenueEditor()"></div>'
            + '<div class="relative w-full max-w-sm bg-[#050505] border border-[#27272a] p-6">'
            + '<div class="flex items-center justify-between mb-6">'
            + '<span class="text-[10px] font-mono text-zinc-500 uppercase tracking-[0.3em]">Venue Configuration</span>'
            + '<button onclick="closeVenueEditor()" class="w-6 h-6 flex items-center justify-center text-zinc-600 hover:text-white transition-colors">'
            + '<iconify-icon icon="solar:close-circle-linear" class="text-base"></iconify-icon>'
            + '</button></div>'
            + '<label class="text-[9px] font-mono text-zinc-600 uppercase tracking-widest block mb-2">Venue Name</label>'
            + '<input id="venue-input" type="text" maxlength="40" style="outline:none;box-shadow:none" class="w-full bg-[#0a0a0a] border border-[#27272a] text-white text-sm font-mono px-4 py-3 focus:outline-none focus:ring-0 focus:border-[#39FF14] transition-colors placeholder:text-zinc-700 uppercase tracking-wider mb-6" placeholder="e.g. FABRIC LONDON" spellcheck="false" autocomplete="off" autocapitalize="characters">'
            + '<button onclick="saveVenueName()" class="w-full py-3 text-[10px] font-mono font-bold uppercase tracking-[0.3em] bg-[#39FF14] text-black hover:bg-white transition-colors">Save Changes</button>'
            + '</div>';
        document.body.appendChild(popover);
    }

    // Venue editor keyboard + outside-click handlers
    document.addEventListener('keydown', function(e) {
        var popover = document.getElementById('venue-popover');
        if (!popover) return;
        if (e.key === 'Enter' && !popover.classList.contains('hidden')) window.saveVenueName();
        if (e.key === 'Escape') window.closeVenueEditor();
    });

    document.addEventListener('click', function(e) {
        var popover = document.getElementById('venue-popover');
        var avatar = document.getElementById('venue-avatar');
        var inner = popover ? popover.querySelector('.max-w-sm') : null;
        if (popover && !popover.classList.contains('hidden') && inner && !inner.contains(e.target) && e.target !== avatar) {
            popover.classList.add('hidden');
        }
    });

    // ── Auth avatar (venue-avatar button, shared by all pages) ──────────
    var _SESSION_MS = 10 * 60 * 1000;

    window.LA_ADMIN_LOGOUT = function() {
        // Ends the sign-in on the server too, so a copy of its token stops working
        try {
            var t = (JSON.parse(localStorage.getItem('la_admin') || 'null') || {}).webToken;
            if (t) fetch('/api/switch-venue', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + t }, body: JSON.stringify({ signOut: true }) }).catch(function() {});
        } catch (_) {}
        localStorage.removeItem('la_admin');
        var d = document.getElementById('la-auth-drop');
        if (d) d.remove();
        window.location.replace('/login.html');
    };

    function _getAdminSession() {
        try {
            var raw = localStorage.getItem('la_admin');
            if (!raw) return null;
            var d = JSON.parse(raw);
            if (!d || !d.ts || Date.now() - d.ts > _SESSION_MS) return null;
            return d;
        } catch(e) { return null; }
    }

    function _sessionTimeStr(ts) {
        var rem = Math.max(0, _SESSION_MS - (Date.now() - ts));
        var s = Math.ceil(rem / 1000);
        var m = Math.floor(s / 60);
        var ss = s % 60;
        return m + ':' + (ss < 10 ? '0' : '') + ss;
    }

    function _esc(v) {
        return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    }

    // Accounts listed in several venues (VENUES_CONFIG) can switch between them.
    // Phones: the logo starts on the left so the close button on the right never covers it
    if (!document.getElementById('la-side-css')) {
        var _sc = document.createElement('style');
        _sc.id = 'la-side-css';
        _sc.textContent = '@media (max-width:767px){#la-side-head{justify-content:flex-start !important;padding-left:24px !important;padding-right:64px !important}#la-side-head > a{width:auto !important;max-width:100%}#la-side-head > a img{width:auto !important;max-width:100%;object-position:left center}}';
        document.head.appendChild(_sc);
    }
    // Account menu (avatar): name and email, the accounts to switch to, log out
    var _LA_ICON = {
        venue: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 21V9l8-5 8 5v12"/><path d="M9 21v-6h6v6"/></svg>',
        artist: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="3.5"/><path d="M5 20.5c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5"/></svg>',
        label: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2.5"/><path d="M12 6.5a5.5 5.5 0 0 0-5.5 5.5"/></svg>',
        management: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="7.5" width="17" height="12" rx="2"/><path d="M9 7.5V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1.5"/><path d="M3.5 12.5h17"/></svg>',
        admin: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5l7 2.8v5.2c0 4.4-2.9 7.9-7 9-4.1-1.1-7-4.6-7-9V6.3l7-2.8z"/><path d="M9 12.2l2.2 2.2 4-4.2"/></svg>',   // admin: a shield
        check: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
        out: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 4H5v16h5"/><path d="M14 8l4 4-4 4"/><path d="M18 12H9"/></svg>'
    };
    if (!document.getElementById('la-acct-css')) {
        var _acs = document.createElement('style');
        _acs.id = 'la-acct-css';
        _acs.textContent =
            '#la-auth-drop{font-family:"Helvetica Neue",Helvetica,Arial,sans-serif;animation:laAcctIn .16s cubic-bezier(.22,1,.36,1)}' +
            '@keyframes laAcctIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}' +
            '.la-acct-head{padding:16px 18px 14px;border-bottom:1px solid var(--la-line,#3a3b40)}' +
            '.la-acct-name{font-size:15px;font-weight:600;color:var(--la-text,#fafafa);line-height:1.25;word-break:break-word}' +
            '.la-acct-mail{margin-top:4px;font-size:13px;color:var(--la-sub,#a1a1aa);word-break:break-all}' +
            '.la-acct-group{padding:4px 0}' +
            '.la-acct-group + .la-acct-group{border-top:1px solid var(--la-line,#3a3b40)}' +
            '.la-acct-row{display:flex;align-items:center;gap:12px;width:100%;padding:10px 18px;background:none;border:0;color:var(--la-text,#fafafa);font:400 14px/1.2 "Helvetica Neue",Helvetica,Arial,sans-serif;text-align:left;cursor:pointer;transition:background .12s ease}' +
            '.la-acct-row svg{width:17px;height:17px}' +
            '.la-acct-row svg{flex-shrink:0;color:var(--la-sub,#a1a1aa)}' +
            '.la-acct-row:hover:not(:disabled){background:color-mix(in srgb,var(--la-text,#fafafa) 6%,transparent)}' +
            '.la-acct-row.cur{cursor:default}' +
            '.la-acct-row.sub{padding-left:42px;font-size:.92em;color:var(--la-sub,#a1a1aa)}' +
            '.la-acct-row.sub svg{width:15px;height:15px}' +
            '.la-acct-row span{flex:1;min-width:0}' +
            '.la-acct-check{display:flex;margin-left:auto}' +
            '.la-acct-check svg{width:15px;height:15px;color:var(--la-accent, #39FF14)}';
        document.head.appendChild(_acs);
    }
    // Client names in capitals ("CAFE 1001"), the local / assets account as its wordmark
    function _niceName(n) {
        n = String(n || '').trim();
        if (/^local\s*[\/-]?\s*assets\b/i.test(n)) return 'local / assets';
        return n.toUpperCase();
    }
    function _venueSwitcherHtml(session) {
        var venues = (Array.isArray(session.venues) ? session.venues.slice() : [])
            // local / assets (the admin account) first, then the clients A–Z
            .sort(function(a, b) {
                var aa = /^local\s*[\/-]?\s*assets\b/i.test(String(a.name || '').trim()) || a.slug === 'local-assets-admin';
                var bb = /^local\s*[\/-]?\s*assets\b/i.test(String(b.name || '').trim()) || b.slug === 'local-assets-admin';
                return (bb - aa) || String(a.name || '').localeCompare(String(b.name || ''));
            });
        if (venues.length < 2) return '';
        // An account's artists sit under it (the admin's menu); an artist's own choices stay as they are
        var parents = {}; venues.forEach(function(v) { if (!v.as) parents[v.slug] = true; });
        var ordered = [];
        venues.filter(function(v) { return !v.as || !parents[v.slug]; }).forEach(function(v) {
            ordered.push(v);
            if (!v.as) venues.filter(function(c) { return c.as && c.slug === v.slug; }).sort(function(a, b) { return String(a.name).localeCompare(String(b.name)); }).forEach(function(c) { ordered.push(Object.assign({ sub: true }, c)); });
        });
        venues = ordered;
        var html = '<div data-la-switcher class="la-acct-group">';
        venues.forEach(function(v) {
            // The account itself is current only while not viewing it as one of its artists (so it can be chosen to go back)
            var current = v.slug === session.venueSlug && (v.as ? !!(session.member && session.member.owner === v.as) : !session.member);
            // Icon by what the account is: an artist, a venue, a record label, management, or local / assets itself
            var kind = v.type || (/^local\s*[\/-]?\s*assets\b/i.test(String(v.name || '')) || v.slug === 'local-assets-admin' ? 'admin' : 'venue');
            html += '<button type="button" class="la-acct-row' + (v.sub ? ' sub' : '') + (current ? ' cur' : '') + '" data-venue-slug="' + _esc(v.slug) + '" data-as="' + _esc(v.as || '') + '" onclick="window.LA_SWITCH_VENUE(this.dataset.venueSlug, this.dataset.as)"' + (current ? ' disabled aria-current="true"' : '') + '>' +
                (_LA_ICON[kind] || _LA_ICON.venue) + '<span>' + _esc(_niceName(v.name)) + '</span>' + (current ? '<i class="la-acct-check">' + _LA_ICON.check + '</i>' : '') + '</button>';
        });
        return html + '</div>';
    }

    // Keeps the sign-in fresh while a page is open (tokens last an hour); an expired one goes to sign-in
    var _refreshing = false;
    async function _refreshToken() {
        var session = _getAdminSession();
        if (!session || !session.webToken || _refreshing) return;
        // Only while someone is using a page: an idle browser runs out after 10 minutes like a closed one
        if (!_isApp() && Date.now() - _lastActive() > _SESSION_MS && !_mediaPlaying()) return;
        _refreshing = true;
        try {
            var res = await fetch('/api/switch-venue', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.webToken },
                body: JSON.stringify({ refresh: true }),
            });
            if (res.status === 401) {
                window.location.replace('/login.html?next=' + encodeURIComponent(location.pathname + location.search));
                return;
            }
            var data = await res.json().catch(function() { return {}; });
            var cur = _getAdminSession();
            if (res.ok && data.webToken && cur) {
                cur.webToken = data.webToken;
                // The session runs 10 minutes from the last real use (the apps: from now)
                cur.ts = _isApp() ? Date.now() : Math.min(Date.now(), Math.max(_lastActive(), cur.ts || 0));
                if ('member' in data) {
                    var was = cur.member ? cur.member.owner : '', now = data.member ? data.member.owner : '';
                    cur.member = data.member || null;
                    if (data.member) { cur.venue = String(data.member.name).toUpperCase(); localStorage.setItem('la_venue_name', cur.venue); }
                    if (was !== now) { localStorage.setItem('la_admin', JSON.stringify(cur)); location.reload(); return; }
                }
                // Keep the venue switcher in step with the accounts that still exist
                if (Array.isArray(data.venues)) {
                    var changed = JSON.stringify(data.venues) !== JSON.stringify(cur.venues || []);
                    cur.venues = data.venues;
                    localStorage.setItem('la_admin', JSON.stringify(cur));
                    if (changed) { var sw = document.querySelector('[data-la-switcher]'); if (sw) sw.outerHTML = _venueSwitcherHtml(cur); }
                } else localStorage.setItem('la_admin', JSON.stringify(cur));
            }
        } catch (e) {} finally { _refreshing = false; }
    }
    // Banners go just under the page's top bar: above it they sat under the phone's status bar and were cut off
    function _placeBanner(main, el) {
        var bar = main.querySelector(':scope > header, :scope > .la-topbar');
        if (bar) bar.insertAdjacentElement('afterend', el); else main.insertBefore(el, main.firstChild);
    }
    // An unpaid invoice pauses the account: a banner on every page with the way to pay
    (function _billingBanner() {
        var session = _getAdminSession();
        if (!session || !session.webToken || _isClient) return;
        fetch('/api/billing?status=1', { headers: { 'Authorization': 'Bearer ' + session.webToken } })
            .then(function(r) { return r.ok ? r.json() : null; })
            .then(function(d) {
                if (d && d.setupPending && !d.paused) {
                    var mn = document.querySelector('main');
                    if (mn && !document.getElementById('la-setup')) {
                        var sb = document.createElement('div');
                        sb.id = 'la-setup';
                        sb.style.cssText = 'padding:12px 20px;background:#14532d;color:#fff;font:500 13px/1.4 Inter,system-ui,sans-serif;flex-shrink:0;z-index:45;';
                        sb.innerHTML = '<b style="font-weight:700">Welcome to local / assets.</b> We\'re setting up your private video storage. You can set up your Brand Kit now; uploads and recordings open as soon as it\'s ready, and we\'ll email you.';
                        _placeBanner(mn, sb);
                    }
                    return;
                }
                if (!d || !d.paused) return;
                var main = document.querySelector('main');
                if (!main || document.getElementById('la-paused')) return;
                var b = document.createElement('div');
                b.id = 'la-paused';
                b.setAttribute('role', 'alert');
                b.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:12px 20px;background:#7f1d1d;color:#fff;font:500 13px/1.4 Inter,system-ui,sans-serif;flex-shrink:0;z-index:45;';
                if (d.byAdmin) { b.innerHTML = '<span><b style="font-weight:700">Account paused.</b> local / assets has paused this account, so uploads, clips, watermarks and publishing are stopped. Email info@local-assets.com to start it again.</span>'; _placeBanner(main, b); return; }
                b.innerHTML = '<span><b style="font-weight:700">Account paused.</b> Invoice ' + _esc(d.number || '') + ' is unpaid, so uploads, clips, watermarks and publishing are stopped until it is paid.</span>' +
                    (d.payUrl ? '<a href="' + _esc(d.payUrl) + '" target="_blank" rel="noopener" style="background:#fff;color:#7f1d1d;font-weight:700;padding:7px 14px;border-radius:8px;text-decoration:none;white-space:nowrap">Pay now</a>' : '<a href="/billing" style="color:#fff;text-decoration:underline">Billing</a>');
                _placeBanner(main, b);
            }).catch(function() {});
    })();
    // ── Signing out on time ──
    // In a browser the session lasts 10 minutes from the last time anyone used a page (any tab).
    // An expired or signed-out session sends every open page to sign-in: on a timer, when a tab comes back,
    // when another tab signs out, and when Back shows a page kept from before signing out.
    // The a™ apps stay signed in (the Mac app streams sets by itself); Log out still signs them out.
    function _isApp() { return !!window.laApp; }
    function _lastActive() { try { return Number(localStorage.getItem('la_active')) || 0; } catch (_) { return 0; } }
    // Someone watching: a video or audio playing with sound (the banner and previews loop muted by themselves)
    function _mediaPlaying() {
        var list = Array.prototype.slice.call(document.querySelectorAll('video, audio, mux-player'));
        return list.some(function(m) { return !m.paused && !m.ended && !m.muted && m.volume > 0; });
    }
    var _markedAt = 0;
    function _markActive(e) {
        if (e && e.isTrusted === false) return;   // only a person's own input, not events a page makes
        var now = Date.now(); if (now - _markedAt < 15000) return; _markedAt = now;
        try { localStorage.setItem('la_active', String(now)); } catch (_) {}
    }
    var _signedInAtLoad = !!_getAdminSession();
    function _checkSignedIn() {
        if (!_signedInAtLoad) return;
        if (_getAdminSession()) return;
        try { localStorage.removeItem('la_admin'); } catch (_) {}
        window.location.replace('/login.html?next=' + encodeURIComponent(location.pathname + location.search));
    }
    if (_signedInAtLoad) {
        _markActive();
        // Taps, clicks, keys and the wheel: not 'scroll', which pages also cause by themselves
        ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(function(ev) { window.addEventListener(ev, _markActive, { passive: true, capture: true }); });
        setInterval(function() { if (_mediaPlaying()) _markActive(null); _checkSignedIn(); }, 20000);
        window.addEventListener('storage', function(e) { if (e.key === 'la_admin' && !e.newValue) _checkSignedIn(); });
        window.addEventListener('pageshow', function(e) { if (e.persisted) _checkSignedIn(); });
    }
    setInterval(_refreshToken, 5 * 60 * 1000);
    document.addEventListener('visibilitychange', function() { if (document.visibilityState === 'visible') { _checkSignedIn(); _refreshToken(); } });
    _refreshToken();

    window.LA_SWITCH_VENUE = async function(slug, as) {
        var session = _getAdminSession();
        if (!session) { window.LA_ADMIN_LOGOUT(); return; }
        try {
            var res = await fetch('/api/switch-venue', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (session.webToken || '') },
                body: JSON.stringify({ venueSlug: slug, as: as || '' }),
            });
            var data = await res.json().catch(function() { return {}; });
            if (!res.ok) { alert(data.error || 'Could not switch venue'); return; }
            session.webToken  = data.webToken;
            session.venue     = (data.venue || '').toUpperCase();
            session.venueSlug = data.venueSlug;
            session.member    = data.member || null;
            session.venues    = data.venues || session.venues;
            localStorage.setItem('la_admin', JSON.stringify(session));
            localStorage.setItem('la_venue_name', session.venue);
            localStorage.removeItem('la_revenue_cache_v2');
            window.location.reload();
        } catch (e) { alert('Could not switch venue'); }
    };

    function _toggleAuthDrop(session, btn) {
        var existing = document.getElementById('la-auth-drop');
        if (existing) {
            existing.remove();
            if (window._authDropInterval) clearInterval(window._authDropInterval);
            return;
        }

        var rect = btn.getBoundingClientRect();
        var drop = document.createElement('div');
        drop.id = 'la-auth-drop';
        drop.style.cssText = [
            'position:fixed',
            'top:' + (rect.bottom + 8) + 'px',
            'border-radius:8px',
            'overflow:hidden',
            'right:' + (window.innerWidth - rect.right) + 'px',
            'background:var(--la-raised, #0a0a0a)',
            'border:1px solid var(--la-line, #27272a)',
            'min-width:230px',
            'max-width:min(340px, calc(100vw - 24px))',
            'z-index:99999',
            'box-shadow:0 18px 44px -16px rgba(0,0,0,.55)',
        ].join(';');

        var venue = session.venue || localStorage.getItem('la_venue_name') || 'local / assets';

        drop.innerHTML =
            '<div class="la-acct-head"><div class="la-acct-name">' + _esc(_niceName(venue)) + '</div><div class="la-acct-mail">' + _esc(session.email || '') + '</div></div>' +
            _venueSwitcherHtml(session) +
            '<div class="la-acct-group"><button type="button" class="la-acct-row" onclick="window.LA_ADMIN_LOGOUT()">' + _LA_ICON.out + '<span>Log out</span></button></div>';

        document.body.appendChild(drop);

        window._authDropInterval = setInterval(function() {
            var el = document.getElementById('la-drop-timer');
            if (!el) { clearInterval(window._authDropInterval); return; }
            var s2 = _getAdminSession();
            if (!s2) { window.LA_ADMIN_LOGOUT(); return; }
            el.textContent = _sessionTimeStr(s2.ts);
        }, 1000);

        setTimeout(function() {
            document.addEventListener('click', function _closeHandler(e) {
                var d = document.getElementById('la-auth-drop');
                if (d && !d.contains(e.target) && e.target !== btn) {
                    d.remove();
                    clearInterval(window._authDropInterval);
                    document.removeEventListener('click', _closeHandler);
                }
            });
        }, 50);
    }

    window._updateAuthAvatar = function() {
        var btn = document.getElementById('venue-avatar');
        if (!btn) return;

        var session = _getAdminSession();

        if (!session) {
            // Not logged in → "SIGN IN" pill
            btn.className = 'la-sign-in-btn';
            btn.style.cssText = '';
            btn.textContent = 'Sign in';
            btn.title = 'Sign in';
            btn.onclick = function(e) { e.stopPropagation(); window.location.href = '/login.html'; };
        } else {
            // Logged in → profile photo (or initial fallback)
            btn.classList.remove('la-sign-in-btn');
            btn.style.cssText = 'width:32px;height:32px;border-radius:50%;overflow:visible;cursor:pointer;flex-shrink:0;position:relative;display:inline-flex;align-items:center;justify-content:center;';
            btn.title = session.name || session.email || 'Account';

            if (session.picture) {
                btn.innerHTML = '<img src="' + session.picture + '" style="width:32px;height:32px;border-radius:50%;object-fit:cover;border:2px solid transparent;transition:border-color .2s;" alt="" ' +
                    'onmouseover="this.style.borderColor=\'var(--la-accent)\'" onmouseout="this.style.borderColor=\'transparent\'" ' +
                    'onerror="this.parentElement.innerHTML=\'<span style=&quot;width:32px;height:32px;border-radius:50%;background:#27272a;display:inline-flex;align-items:center;justify-content:center;font-family:monospace;font-size:12px;font-weight:700;color:#fff;&quot;>' + (session.name || 'A').charAt(0).toUpperCase() + '</span>\'">';
            } else {
                btn.innerHTML = '<span style="width:32px;height:32px;border-radius:50%;background:#27272a;display:inline-flex;align-items:center;justify-content:center;font-family:monospace;font-size:12px;font-weight:700;color:#fff;">' + (session.name || 'A').charAt(0).toUpperCase() + '</span>';
            }

            btn.onclick = function(e) { e.stopPropagation(); _toggleAuthDrop(session, btn); };
        }
    };

    window.applyVenueName();

    // Kick off an expiry watcher so the page redirects when session dies
    setInterval(function() {
        if (!_getAdminSession() && document.getElementById('venue-avatar')) {
            window._updateAuthAvatar();
        }
    }, 15000);
});
// The version under the sidebar follows the newest a™ release (apps/mac-latest.json), so it never goes stale
(function() {
    function run() {
    if (!document.querySelector('[data-la-version]')) return;
    fetch('/apps/mac-latest.json', { cache: 'no-cache' }).then(function(r) { return r.ok ? r.json() : null; }).then(function(d) {
        if (!d || !/^\d+(\.\d+)*$/.test(String(d.version || ''))) return;
        document.querySelectorAll('[data-la-version]').forEach(function(el) { el.textContent = 'V' + d.version; });
    }).catch(function() {});
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
})();

// The terms: the first time someone opens the dashboard they tick that they agree to the Terms of Service
// and have read the Privacy policy. Asked once per version (api/switch-venue.js keeps who agreed and when).
(function() {
    function session() { try { var d = JSON.parse(localStorage.getItem('la_admin') || 'null'); return d && d.webToken ? d : null; } catch (_) { return null; } }
    function post(token, body) {
        return fetch('/api/switch-venue', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify(body) })
            .then(function(r) { return r.json().catch(function() { return {}; }).then(function(d) { d._status = r.status; return d; }); });
    }
    function ask(s, version) {
        if (document.getElementById('la-terms')) return;
        var st = document.createElement('style');
        st.textContent = '#la-terms .lad-panel{width:480px}#la-terms .lat-eyebrow{font:500 10px/1 "JetBrains Mono",ui-monospace,monospace;letter-spacing:.24em;text-transform:uppercase;color:var(--la-dim,#7c8178);margin-bottom:14px}'
            + '#la-terms a{color:var(--la-text,#fafafa);text-decoration:underline;text-decoration-color:var(--la-accent, #39FF14);text-underline-offset:3px}'
            + '#la-terms .lat-check{display:flex;gap:12px;align-items:flex-start;margin-top:20px;padding:14px 16px;border:1px solid var(--la-line,#27272a);border-radius:16px;cursor:pointer;font-size:14px;line-height:1.5;color:var(--la-text,#fafafa)}'
            + '#la-terms .lat-check input{flex:none;width:18px;height:18px;margin-top:1px;accent-color:var(--la-accent, #39FF14);cursor:pointer}'
            + '#la-terms .lad-btn.primary[disabled]{opacity:.4;cursor:not-allowed;filter:none}'
            + '#la-terms .lat-err{margin-top:12px;font-size:13px;color:var(--la-bad,#ef4444);min-height:0}';
        document.head.appendChild(st);
        var wrap = document.createElement('div');
        wrap.className = 'lad-backdrop'; wrap.id = 'la-terms';
        wrap.setAttribute('role', 'dialog'); wrap.setAttribute('aria-modal', 'true'); wrap.setAttribute('aria-labelledby', 'la-terms-title');
        wrap.innerHTML = '<div class="lad-panel">'
            + '<p class="lat-eyebrow">Before you start</p>'
            + '<h2 class="lad-title" id="la-terms-title">Our terms</h2>'
            + '<p class="lad-msg">To use local / assets, please agree to our <a href="/terms" target="_blank" rel="noopener">Terms of Service</a>. Our <a href="/privacy" target="_blank" rel="noopener">Privacy policy</a> explains what we keep and why. You only need to do this once.</p>'
            + '<label class="lat-check"><input type="checkbox" id="la-terms-tick"><span>I agree to the Terms of Service and have read the Privacy policy.</span></label>'
            + '<p class="lat-err" id="la-terms-err"></p>'
            + '<div class="lad-actions"><button type="button" class="lad-btn primary" id="la-terms-ok" disabled>Continue</button><button type="button" class="lad-btn ghost" id="la-terms-out">Log out</button></div>'
            + '</div>';
        document.body.appendChild(wrap);
        requestAnimationFrame(function() { wrap.classList.add('in'); });
        var tick = wrap.querySelector('#la-terms-tick'), ok = wrap.querySelector('#la-terms-ok'), err = wrap.querySelector('#la-terms-err');
        tick.addEventListener('change', function() { ok.disabled = !tick.checked; });
        wrap.querySelector('#la-terms-out').addEventListener('click', function() { if (window.LA_ADMIN_LOGOUT) window.LA_ADMIN_LOGOUT(); });
        ok.addEventListener('click', function() {
            if (!tick.checked) return;
            ok.disabled = true; err.textContent = '';
            var cur = session() || s;
            post(cur.webToken, { acceptTerms: version }).then(function(d) {
                if (!d.ok) { err.textContent = d.error || 'Could not save that. Try again.'; ok.disabled = false; return; }
                wrap.classList.remove('in'); setTimeout(function() { wrap.remove(); }, 160);
            }).catch(function() { err.textContent = 'Could not save that. Check the connection and try again.'; ok.disabled = false; });
        });
    }
    function run() {
        var s = session();
        if (!s || /^\/(login|download|privacy|terms)(\.html)?$/.test(location.pathname)) return;
        post(s.webToken, { termsStatus: true }).then(function(d) {
            if (d._status !== 200 || !d.version) return;
            if (!d.accepted) ask(s, d.version);
        }).catch(function() {});
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
})();
// Who is on the platform (the admin's Accounts page, Online now): while a page is open and on screen it says so
// about once a minute, with the page and the kind of device. Nothing else is sent.
(function() {
    if (/^\/(login|download|privacy|terms|mimo)(\.html)?$/.test(location.pathname)) return;
    var ua = navigator.userAgent || '';
    var device = /iPhone|iPod/.test(ua) ? 'iPhone' : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iPad'
        : /Android/.test(ua) ? 'Android' : /Macintosh|Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Other';
    var last = 0;
    function ping() {
        if (document.visibilityState !== 'visible' || Date.now() - last < 30000) return;
        var t = ''; try { t = JSON.parse(localStorage.getItem('la_admin') || '{}').webToken || ''; } catch (_) {}
        if (!t) return;
        last = Date.now();
        fetch('/api/switch-venue', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + t },
            body: JSON.stringify({ ping: { page: location.pathname.replace(/^\/|\.html$/g, '') || 'dashboard', device: device, app: !!(window.laApp && window.laApp.mac) || /Electron/.test(ua) } }) }).catch(function() {});
    }
    setTimeout(ping, 1500);
    setInterval(ping, 60000);
    document.addEventListener('visibilitychange', ping);
})();
