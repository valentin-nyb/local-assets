// Dropdown menus in the site's style (la-select.js), on every page that has the nav
// Faster page changes: hovering a sidebar link starts loading that page (and its data) in the background,
// so it's usually ready when clicked (Chrome, Edge, Brave and the a™ app; other browsers just load normally)
(function () {
    if (!(window.HTMLScriptElement && HTMLScriptElement.supports && HTMLScriptElement.supports('speculationrules'))) return;
    if (document.querySelector('script[type=speculationrules]')) return;
    var sr = document.createElement('script');
    sr.type = 'speculationrules';
    sr.textContent = JSON.stringify({ prerender: [{ where: { href_matches: ['/dashboard', '/camera', '/brand', '/assets', '/billing'] }, eagerness: 'moderate' }] });
    document.head.appendChild(sr);
})();
(function () { if (document.querySelector('script[data-la-select]')) return; var sc = document.createElement('script'); sc.src = '/la-select.js?v=5'; sc.defer = true; sc.setAttribute('data-la-select', ''); document.head.appendChild(sc); })();
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
            <a href="/camera" class="nav-link flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${isActive('/camera')}">
                <svg class="nav-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="6" width="13.5" height="12" rx="2.5"/><path d="M16 10.5l5.5-3.2v9.4L16 13.5"/></svg><span>Camera Control</span>
            </a>
            <a href="/assets" class="nav-link flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${isActive('/assets')}">
                <svg class="nav-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15.5V4M7.5 8.5L12 4l4.5 4.5"/><path d="M4 15v3.5A2 2 0 0 0 6 20.5h12a2 2 0 0 0 2-2V15"/></svg><span>Upload Asset</span>
            </a>
            <a href="/brand" style="${_isAdminAcct ? 'display:none' : ''}" class="nav-link flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${isActive('/brand')}">
                <svg class="nav-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.8-.8 1.8-1.8 0-.5-.2-.9-.5-1.3-.3-.3-.5-.8-.5-1.3 0-1 .8-1.8 1.8-1.8h2.1a3.8 3.8 0 0 0 3.8-3.8C20.5 6.9 16.7 3.5 12 3.5z"/><circle cx="7.6" cy="11.2" r="1"/><circle cx="10.4" cy="7.4" r="1"/><circle cx="15" cy="7.6" r="1"/></svg><span>Brand Kit</span>
            </a>
            <a href="/billing" class="nav-link flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${isActive('/billing')}">
                <svg class="nav-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19M6.5 15h4"/></svg><span>Billing</span>
            </a>
        </nav>
        <div class="px-4 pt-6 mt-4 flex justify-center" style="padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 1.5rem)">
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
        </div>
    `;

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
        if (breadcrumb) breadcrumb.textContent = name;
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
            var isDark = document.documentElement.classList.contains('dark');
            input.style.borderColor = isDark ? '#39FF14' : '#F97316';
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
        admin: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 4L9 20"/></svg>',
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
            '.la-acct-row span{flex:1;min-width:0}' +
            '.la-acct-check{display:flex;margin-left:auto}' +
            '.la-acct-check svg{width:15px;height:15px;color:var(--la-accent,#39FF14)}';
        document.head.appendChild(_acs);
    }
    // Names in normal case: "AMONGST FEW" → "Amongst Few", the local / assets account as its wordmark
    function _niceName(n) {
        n = String(n || '').trim();
        if (/^local\s*[\/-]?\s*assets\b/i.test(n)) return 'local / assets';
        if (n !== n.toUpperCase()) return n;
        return n.toLowerCase().replace(/(^|[\s\-\/(&.])([a-z])/g, function(m, a, b) { return a + b.toUpperCase(); });
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
        var html = '<div data-la-switcher class="la-acct-group">';
        venues.forEach(function(v) {
            var current = v.slug === session.venueSlug;
            // Icon by what the account is: an artist, a venue, a record label, management, or local / assets itself
            var kind = v.type || (/^local\s*[\/-]?\s*assets\b/i.test(String(v.name || '')) || v.slug === 'local-assets-admin' ? 'admin' : 'venue');
            html += '<button type="button" class="la-acct-row' + (current ? ' cur' : '') + '" data-venue-slug="' + _esc(v.slug) + '" onclick="window.LA_SWITCH_VENUE(this.dataset.venueSlug)"' + (current ? ' disabled aria-current="true"' : '') + '>' +
                (_LA_ICON[kind] || _LA_ICON.venue) + '<span>' + _esc(_niceName(v.name)) + '</span>' + (current ? '<i class="la-acct-check">' + _LA_ICON.check + '</i>' : '') + '</button>';
        });
        return html + '</div>';
    }

    // Keeps the sign-in fresh while a page is open (tokens last an hour); an expired one goes to sign-in
    var _refreshing = false;
    async function _refreshToken() {
        var session = _getAdminSession();
        if (!session || !session.webToken || _refreshing) return;
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
                cur.webToken = data.webToken; cur.ts = Date.now();
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
                        mn.insertBefore(sb, mn.firstChild);
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
                b.innerHTML = '<span><b style="font-weight:700">Account paused.</b> Invoice ' + _esc(d.number || '') + ' is unpaid, so uploads, clips, watermarks and publishing are stopped until it is paid.</span>' +
                    (d.payUrl ? '<a href="' + _esc(d.payUrl) + '" target="_blank" rel="noopener" style="background:#fff;color:#7f1d1d;font-weight:700;padding:7px 14px;border-radius:8px;text-decoration:none;white-space:nowrap">Pay now</a>' : '<a href="/billing" style="color:#fff;text-decoration:underline">Billing</a>');
                main.insertBefore(b, main.firstChild);
            }).catch(function() {});
    })();
    setInterval(_refreshToken, 5 * 60 * 1000);
    document.addEventListener('visibilitychange', function() { if (document.visibilityState === 'visible') _refreshToken(); });
    _refreshToken();

    window.LA_SWITCH_VENUE = async function(slug) {
        var session = _getAdminSession();
        if (!session) { window.LA_ADMIN_LOGOUT(); return; }
        try {
            var res = await fetch('/api/switch-venue', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (session.webToken || '') },
                body: JSON.stringify({ venueSlug: slug }),
            });
            var data = await res.json().catch(function() { return {}; });
            if (!res.ok) { alert(data.error || 'Could not switch venue'); return; }
            session.webToken  = data.webToken;
            session.venue     = (data.venue || '').toUpperCase();
            session.venueSlug = data.venueSlug;
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
                    'onmouseover="this.style.borderColor=\'#39FF14\'" onmouseout="this.style.borderColor=\'transparent\'" ' +
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