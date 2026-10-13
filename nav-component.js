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
            .la-sign-in-btn{background:#18181b;border:1px solid #27272a}
            .la-sign-in-btn span{color:#71717a}
            html:not(.dark) .la-sign-in-btn{background:#f4f4f5;border-color:#d4d4d8}
            html:not(.dark) .la-sign-in-btn span{color:#52525b}
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
    var _isAdminAcct = (function() { try { var a = JSON.parse(localStorage.getItem('la_admin') || '{}'); return a.venueSlug === 'local-assets-admin' || /^local\s*[\/-]?\s*assets\b/i.test(String(a.venue || '').trim()); } catch (_) { return false; } })();
    sidebar.innerHTML = `
        <div class="h-20 flex items-center px-8 border-b border-[#27272a] justify-between shrink-0">
            <a href="/dashboard" class="h-5 w-24 flex">
                <img src="/logos/White@2x.png" class="h-full w-full object-left object-contain" alt="logo">
            </a>
            <button onclick="toggleSidebar()" class="md:hidden text-zinc-400 hover:text-white transition-colors">
                <iconify-icon icon="solar:close-circle-linear" class="text-2xl"></iconify-icon>
            </button>
        </div>
        <nav class="flex-1 p-4 space-y-2 overflow-y-auto">
            <a href="/dashboard" class="nav-link flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${isActive('/dashboard')}">
                Overview
            </a>
            <a href="/camera" class="nav-link flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${isActive('/camera')}">
                Camera Control
            </a>
            <a href="/brand" style="${_isAdminAcct ? 'display:none' : ''}" class="nav-link flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${isActive('/brand')}">
                Brand Kit
            </a>
            <a href="/assets" class="nav-link flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${isActive('/assets')}">
                Upload Asset
            </a>
            <a href="/billing" class="nav-link flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${isActive('/billing')}">
                Billing
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
        if (tier) tier.textContent = 'Infrastructure Tier — ' + name;
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
    function _venueSwitcherHtml(session) {
        var venues = (Array.isArray(session.venues) ? session.venues.slice() : [])
            // local / assets (the admin account) first, then the clients A–Z
            .sort(function(a, b) {
                var aa = /^local\s*[\/-]?\s*assets\b/i.test(String(a.name || '').trim()) || a.slug === 'local-assets-admin';
                var bb = /^local\s*[\/-]?\s*assets\b/i.test(String(b.name || '').trim()) || b.slug === 'local-assets-admin';
                return (bb - aa) || String(a.name || '').localeCompare(String(b.name || ''));
            });
        if (venues.length < 2) return '';
        var html = '<div style="padding:10px 16px;border-bottom:1px solid var(--la-line, #27272a);">' +
            '<div style="font-size:8px;text-transform:uppercase;letter-spacing:.12em;color:var(--la-dim, #52525b);margin-bottom:6px;">Switch venue</div>';
        venues.forEach(function(v) {
            var current = v.slug === session.venueSlug;
            html += '<button data-venue-slug="' + _esc(v.slug) + '" onclick="window.LA_SWITCH_VENUE(this.dataset.venueSlug)"' + (current ? ' disabled' : '') +
                ' style="display:flex;align-items:center;gap:8px;width:100%;padding:6px 0;background:none;border:none;font-family:inherit;font-size:10px;text-transform:uppercase;letter-spacing:.08em;text-align:left;cursor:' + (current ? 'default' : 'pointer') + ';color:' + (current ? 'var(--la-accent, #39FF14)' : 'var(--la-sub, #a1a1aa)') + ';">' +
                '<span style="width:6px;height:6px;border-radius:50%;background:' + (current ? 'var(--la-accent, #39FF14)' : 'var(--la-line, #3f3f46)') + ';flex-shrink:0;"></span>' + _esc(v.name) + '</button>';
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
            if (res.ok && data.webToken && cur) { cur.webToken = data.webToken; cur.ts = Date.now(); localStorage.setItem('la_admin', JSON.stringify(cur)); }
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
            'border-radius:12px',
            'overflow:hidden',
            'right:' + (window.innerWidth - rect.right) + 'px',
            'background:var(--la-raised, #0a0a0a)',
            'border:1px solid var(--la-line, #27272a)',
            'min-width:230px',
            'z-index:99999',
            'box-shadow:var(--la-shadow, 0 8px 40px rgba(0,0,0,0.95))',
            'font-family:ui-monospace,monospace',
        ].join(';');

        var venue = (session.venue || localStorage.getItem('la_venue_name') || 'LOCAL / ASSETS').toUpperCase();

        drop.innerHTML =
            '<div style="padding:14px 16px;border-bottom:1px solid var(--la-line, #27272a);">' +
                '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.12em;color:var(--la-text, #fff);margin-bottom:4px;">' + _esc(venue) + '</div>' +
                '<div style="font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:var(--la-dim, #52525b);">' + _esc(session.email || '') + '</div>' +
            '</div>' +
            _venueSwitcherHtml(session) +
            '<div style="padding:10px 16px;border-bottom:1px solid var(--la-line, #27272a);display:flex;align-items:center;justify-content:space-between;gap:12px;">' +
                '<span style="font-size:8px;text-transform:uppercase;letter-spacing:.12em;color:var(--la-dim, #52525b);">Session expires</span>' +
                '<span id="la-drop-timer" style="font-size:9px;color:var(--la-accent, #39FF14);letter-spacing:.08em;font-weight:700;">' + _sessionTimeStr(session.ts) + '</span>' +
            '</div>' +
            '<div style="padding:10px 16px;">' +
                '<button onclick="window.LA_ADMIN_LOGOUT()" style="display:block;width:100%;padding:9px 0;background:var(--la-bad, #ef4444);color:#fff;border-radius:8px;font-family:inherit;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.15em;border:none;cursor:pointer;">SIGN OUT</button>' +
            '</div>';

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
            btn.style.cssText = 'width:auto;min-width:60px;height:28px;padding:0 10px;border-radius:4px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;';
            btn.innerHTML = '<span style="font-family:ui-monospace,monospace;font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.15em;">SIGN IN</span>';
            btn.title = 'Sign in';
            btn.onclick = function(e) { e.stopPropagation(); window.location.href = '/login.html'; };
        } else {
            // Logged in → profile photo (or initial fallback)
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