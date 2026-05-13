document.addEventListener("DOMContentLoaded", () => {
    // Inject theme switcher CSS if not already present
    if (!document.getElementById('la-theme-switcher-css')) {
        var style = document.createElement('style');
        style.id = 'la-theme-switcher-css';
        style.textContent = `
            .la-theme-switcher{display:inline-flex;background:#111;border:1px solid #27272a;border-radius:9999px;padding:3px;gap:2px}
            .la-theme-switcher button{all:unset;display:inline-flex;align-items:center;gap:0;font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:500;letter-spacing:.05em;text-transform:uppercase;padding:5px 10px;border-radius:9999px;cursor:pointer;color:rgba(255,255,255,.2);transition:color .3s ease-in-out,background-color .3s ease-in-out;white-space:nowrap;-webkit-user-select:none;user-select:none}
            .la-theme-switcher button:hover{color:rgba(255,255,255,.45)}
            .la-theme-switcher button[aria-checked="true"]{background:rgba(255,255,255,.08);color:#fff}
            .la-theme-switcher button .la-theme-icon{font-size:12px;display:inline-flex;max-width:0;opacity:0;overflow:hidden;transition:max-width .3s ease-in-out,opacity .3s ease-in-out,margin .3s ease-in-out;margin-right:0}
            .la-theme-switcher button[aria-checked="true"] .la-theme-icon{max-width:18px;opacity:1;margin-right:5px}
            html:not(.dark) .la-theme-switcher{background:#e4e4e7;border-color:#d4d4d8}
            html:not(.dark) .la-theme-switcher button{color:rgba(0,0,0,.3)}
            html:not(.dark) .la-theme-switcher button:hover{color:rgba(0,0,0,.55)}
            html:not(.dark) .la-theme-switcher button[aria-checked="true"]{background:rgba(0,0,0,.07);color:#18181b}
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
                <iconify-icon icon="solar:widget-5-linear" class="text-lg"></iconify-icon>Overview
            </a>
            ${_isClient ? '' : `
            <a href="/camera" class="nav-link flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${isActive('/camera')}">
                <iconify-icon icon="solar:videocamera-record-linear" class="text-lg"></iconify-icon>Camera Control
            </a>
            <a href="/assets" class="nav-link flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${isActive('/assets')}">
                <iconify-icon icon="solar:cloud-upload-linear" class="text-lg"></iconify-icon>Upload Asset
            </a>`}
        </nav>
        <div class="px-4 pt-6 mt-4 flex justify-center" style="padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 1.5rem)">
            <div class="la-theme-switcher" role="radiogroup" aria-label="Theme">
                <button type="button" role="radio" aria-checked="${saved === 'light' ? 'true' : 'false'}" data-theme="light">
                    <iconify-icon icon="solar:sun-linear" class="la-theme-icon"></iconify-icon>
                    <span>Light</span>
                </button>
                <button type="button" role="radio" aria-checked="${saved === 'dark' || !['light','dark','auto'].includes(saved) ? 'true' : 'false'}" data-theme="dark">
                    <iconify-icon icon="solar:moon-linear" class="la-theme-icon"></iconify-icon>
                    <span>Dark</span>
                </button>
                <button type="button" role="radio" aria-checked="${saved === 'auto' ? 'true' : 'false'}" data-theme="auto">
                    <iconify-icon icon="solar:monitor-linear" class="la-theme-icon"></iconify-icon>
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
            'right:' + (window.innerWidth - rect.right) + 'px',
            'background:#0a0a0a',
            'border:1px solid #27272a',
            'min-width:230px',
            'z-index:99999',
            'box-shadow:0 8px 40px rgba(0,0,0,0.95)',
            'font-family:ui-monospace,monospace',
        ].join(';');

        var venue = (session.venue || localStorage.getItem('la_venue_name') || 'LOCAL / ASSETS').toUpperCase();

        drop.innerHTML =
            '<div style="padding:14px 16px;border-bottom:1px solid #27272a;">' +
                '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.12em;color:#fff;margin-bottom:4px;">' + venue + '</div>' +
                '<div style="font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:#52525b;">' + (session.email || '') + '</div>' +
            '</div>' +
            '<div style="padding:10px 16px;border-bottom:1px solid #27272a;display:flex;align-items:center;justify-content:space-between;gap:12px;">' +
                '<span style="font-size:8px;text-transform:uppercase;letter-spacing:.12em;color:#52525b;">Session expires</span>' +
                '<span id="la-drop-timer" style="font-size:9px;color:#39FF14;letter-spacing:.08em;font-weight:700;">' + _sessionTimeStr(session.ts) + '</span>' +
            '</div>' +
            '<div style="padding:10px 16px;">' +
                '<button onclick="window.LA_ADMIN_LOGOUT()" style="display:block;width:100%;padding:9px 0;background:#ef4444;color:#fff;font-family:inherit;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.15em;border:none;cursor:pointer;">SIGN OUT</button>' +
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
            btn.style.cssText = 'width:auto;min-width:60px;height:28px;padding:0 10px;background:#18181b;border:1px solid #27272a;border-radius:4px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;';
            btn.innerHTML = '<span style="font-family:ui-monospace,monospace;font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.15em;color:#71717a;">SIGN IN</span>';
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