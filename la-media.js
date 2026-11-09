// Videos, thumbnails and downloads through /api/media, which signs them for the signed-in account
// (Mux signed playback). Pages write Mux addresses as before and pass them through laMux():
//   laMux(url)                 an address the page can use in <img>, <video>, hls src or fetch
//   laMux(url, { dl: name })   a download (a 15-minute link, noted for the account)
//   laMux.player(el, pid)      a <mux-player> (or <mux-audio>) gets its tickets, then its playback ID
//   laMux.ready                resolves once this device has its media key (12 hours, renewed)
(function() {
    if (window.laMux) return;
    var KEY = 'la_mkey', key = '', exp = 0;
    // A shared link (player.html?s=…): no sign-in; the share id opens its one video
    var share = (new URLSearchParams(location.search).get('s') || '').replace(/[^A-Za-z0-9_-]/g, '');
    var token = function() { try { return JSON.parse(localStorage.getItem('la_admin') || '{}').webToken || ''; } catch (_) { return ''; } };
    // A key kept on this device is used only by the person it was made for: signing in as someone else (another
    // account's email) on the same device kept the last person's key, and every file of the new account was refused
    var whoKey = function(k) { try { return JSON.parse(atob(String(k).split('.')[0].replace(/-/g, '+').replace(/_/g, '/'))).e || ''; } catch (_) { return ''; } };
    var me = function() { try { return String(JSON.parse(localStorage.getItem('la_admin') || '{}').email || '').toLowerCase(); } catch (_) { return ''; } };
    try { var c = JSON.parse(localStorage.getItem(KEY) || 'null'); if (c && c.exp > Date.now() + 60e3 && (!me() || String(whoKey(c.key)).toLowerCase() === me())) { key = c.key; exp = c.exp; } } catch (_) {}
    var post = function(body) {
        var t = token();
        if (share) body.share = share; else if (!t) return Promise.reject(new Error('Not signed in'));
        var h = { 'Content-Type': 'application/json' }; if (t && !share) h.Authorization = 'Bearer ' + t;
        return fetch('/api/media', { method: 'POST', headers: h, body: JSON.stringify(body) })
            .then(function(r) { return r.json().then(function(d) { if (!r.ok) throw new Error(d.error || r.status); return d; }); });
    };
    // Mux videos, and Brand Kit files (the storage's brand/ folder)
    var isMux = function(u) { return /^https:\/\/((stream|image)\.mux\.com|[a-z0-9]+\.public\.blob\.vercel-storage\.com\/brand)\//.test(String(u || '')); };
    function laMux(url, o) {
        if (!isMux(url)) return url;
        return '/api/media?u=' + encodeURIComponent(url) + (o && o.dl ? '&dl=' + encodeURIComponent(o.dl) : '') + (share ? '&s=' + share : '&k=' + encodeURIComponent(key));
    }
    // Addresses written before the key arrived (k empty) get it once it's here
    function fix() {
        if (!key) return;
        document.querySelectorAll('[src*="/api/media?"],[href*="/api/media?"],[poster*="/api/media?"]').forEach(function(el) {
            ['src', 'href', 'poster'].forEach(function(a) { var v = el.getAttribute(a); if (v && /\/api\/media\?.*&k=$/.test(v)) el.setAttribute(a, v + encodeURIComponent(key)); });
        });
    }
    function renew() {
        return post({ action: 'key' }).then(function(d) {
            key = d.key; exp = d.exp;
            try { localStorage.setItem(KEY, JSON.stringify({ key: key, exp: exp })); } catch (_) {}
            fix();
        });
    }
    laMux.ready = share || (key && exp - Date.now() > 2 * 3600e3) ? Promise.resolve() : renew().catch(function() {});
    if (!share) setInterval(function() { if (exp - Date.now() < 2 * 3600e3) renew().catch(function() {}); }, 30 * 60e3);
    // A link to one video for anyone, for good (days: until it ends, when given)
    laMux.share = function(pid, title, days) { return post({ action: 'share', pid: pid, title: title || '', days: days || 0 }); };
    laMux.shared = !!share;
    // Mux Player: tickets for its playback, poster and storyboard, then the playback ID (public videos: none needed)
    var _tickets = {};
    laMux.player = function(el, pid) {
        if (!el || !pid) return Promise.resolve();
        var set = function(t) {
            // A player moving to another video drops the last one's tickets
            ['playback-token', 'thumbnail-token', 'storyboard-token'].forEach(function(a) { el.removeAttribute(a); });
            if (t && t.playback) {
                el.setAttribute('playback-token', t.playback);
                if (t.thumbnail) el.setAttribute('thumbnail-token', t.thumbnail);
                if (t.storyboard) el.setAttribute('storyboard-token', t.storyboard);
            }
            el.setAttribute('playback-id', pid);
        };
        if (pid in _tickets && _tickets[pid].at > Date.now() - 3600e3) { set(_tickets[pid].t); return Promise.resolve(); }
        return post({ action: 'tickets', pids: [pid] }).then(function(d) {
            var t = d.tickets && d.tickets[pid];
            if (t && t.denied) return;
            _tickets[pid] = { t: t, at: Date.now() }; set(t);
        }).catch(function() { set(null); });
    };
    // Every <mux-player data-pid="…"> inside a part of the page (written as HTML)
    laMux.players = function(root) {
        (root || document).querySelectorAll('mux-player[data-pid]:not([playback-id])').forEach(function(el) { laMux.player(el, el.getAttribute('data-pid')); });
    };
    // Phones and tablets: a download never takes the page's place (from the home screen there's no Back to return
    // with), the share sheet saves it instead (Photos, Files, Instagram…)
    laMux.touch = function() { try { return matchMedia('(pointer: coarse)').matches; } catch (_) { return false; } };
    var EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'video/mp4': 'mp4', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'application/pdf': 'pdf' };
    // The sheet's button: sharing needs a fresh tap once the file has taken a while to arrive
    function offer(file, url) {
        var d = document.createElement('div');
        d.style.cssText = 'position:fixed;inset:0;z-index:2147483646;display:flex;align-items:flex-end;justify-content:center;background:rgba(0,0,0,.5);padding:16px 16px calc(16px + env(safe-area-inset-bottom))';
        d.innerHTML = '<div style="width:100%;max-width:420px;background:var(--la-card,#111);color:var(--la-text,#fafafa);border-radius:18px;padding:18px;font:15px/1.4 system-ui,sans-serif;display:grid;gap:10px">' +
            '<b style="font-size:16px">Your file is ready</b>' +
            '<button type="button" data-go style="height:46px;border-radius:999px;border:0;background:var(--la-accent,#39FF14);color:var(--la-accent-ink,#000);font-weight:700;font-size:15px">' + (file ? 'Save or share' : 'Open file') + '</button>' +
            '<button type="button" data-x style="height:42px;border-radius:999px;border:1px solid rgba(127,127,127,.4);background:transparent;color:inherit;font-size:15px">Cancel</button></div>';
        var close = function() { d.remove(); };
        d.addEventListener('click', function(e) {
            if (e.target.closest('[data-go]')) { if (file) navigator.share({ files: [file] }).catch(function() {}); else window.open(url, '_blank'); close(); }
            else if (e.target === d || e.target.closest('[data-x]')) close();
        });
        document.body.appendChild(d);
    }
    laMux.save = function(url, name) {
        try { name = name || new URL(url, location.href).searchParams.get('dl'); } catch (_) {}
        name = name || 'file';
        if (!navigator.canShare) return offer(null, url);
        return fetch(url).then(function(r) {
            if (!r.ok) throw new Error(r.status);
            if (Number(r.headers.get('content-length')) > 150e6) throw new Error('too big to hold');   // a long video: opened instead
            return r.blob();
        }).then(function(b) {
            var type = (b.type || '').split(';')[0], ext = EXT[type];
            var f = new File([b], /\.[A-Za-z0-9]{2,4}$/.test(name) || !ext ? name : name + '.' + ext, { type: type || 'application/octet-stream' });
            if (!navigator.canShare({ files: [f] })) return offer(null, url);
            return navigator.share({ files: [f] }).catch(function(e) { if (!e || e.name !== 'AbortError') offer(f, url); });
        }).catch(function() { offer(null, url); });
    };
    document.addEventListener('click', function(e) {
        if (e.defaultPrevented || !laMux.touch()) return;
        var a = e.target.closest && e.target.closest('a[href*="/api/media?"]');
        if (!a || !/[?&]dl=/.test(a.getAttribute('href') || '')) return;
        e.preventDefault();
        laMux.save(a.href);
    }, true);
    window.laMux = laMux;
    // Players written into the page later (lists, popups) get theirs as they appear
    var watch = function() {
        laMux.players(document);
        new MutationObserver(function(ms) {
            for (var i = 0; i < ms.length; i++) for (var j = 0; j < ms[i].addedNodes.length; j++) {
                var nd = ms[i].addedNodes[j];
                if (nd.nodeType === 1 && (nd.matches('mux-player[data-pid]') || nd.querySelector('mux-player[data-pid]'))) { laMux.players(nd.parentNode || document); return; }
            }
        }).observe(document.documentElement, { childList: true, subtree: true });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch); else watch();
})();
